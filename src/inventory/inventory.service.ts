import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Inventory, ProductVariant } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { AdjustInventoryDto } from './dto/inventory.dto';

const VARIANT_NOT_FOUND = 'Variant not found';
const STORE_NOT_FOUND = 'Store not found';
const INSUFFICIENT_STOCK = 'Insufficient stock';

export interface InventorySummary {
  id: string | null;
  tenantId: string;
  storeId: string | null;
  variantId: string;
  quantityOnHand: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** Scoped pool locator: global (storeId null) or a specific store pool. */
export type InventoryScope =
  { kind: 'global' } | { kind: 'store'; storeId: string };

/** Prisma where-shape for one pool within the current tenant. */
export type PoolWhere = { variantId: string; storeId: string | null };

/**
 * Inventory — Phase 3 U4, extended by Phase 4 P4-U3 (approved D2 Option A).
 *
 * Stock lives in POOLS per (tenant, variant[, store]):
 *   - storeId NULL  = the tenant-GLOBAL pool (the Phase 3 single pool,
 *     preserved verbatim; the default for every pre-existing behavior);
 *   - storeId set   = a store-scoped pool, unique per (store, variant).
 * Two stores holding the same variant have independent rows and can never
 * leak into each other (partial unique indexes arbitrate).
 *
 * All Phase 3 invariants are preserved: mutations are atomic guarded
 * conditional writes via updateMany + increment (never read-modify-write),
 * the DB CHECK (quantityOnHand >= 0) is defense in depth, a missing row
 * == 0 on hand with lazy creation on first positive adjust, and tenant
 * isolation mirrors ProductVariant (foreign variantId is an
 * indistinguishable 404 before any inventory access). All Prisma calls
 * remain tenant-scoped via the extension; a foreign storeId is likewise a
 * uniform 404 (Asset.storeId precedent).
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Phase 3 contract: the tenant-global pool (no store context). */
  async getInventory(variantId: string): Promise<InventorySummary> {
    return this.getScopedInventory({ kind: 'global' }, variantId);
  }

  /** Store-scoped read: 0 when no pool row exists. */
  async getScopedInventory(
    scope: InventoryScope,
    variantId: string,
  ): Promise<InventorySummary> {
    this.assertTenantContext();
    const variant = await this.findVariant(variantId);
    if (!variant) throw new NotFoundException(VARIANT_NOT_FOUND);
    await this.assertScopeStore(scope);
    const pool = this.poolWhere(scope, variantId);

    const inventory = await this.prisma.inventory.findFirst({
      where: pool,
    });
    if (!inventory) {
      return this.zeroSummary(scope, variantId);
    }
    return this.toSummary(inventory);
  }

  /** Phase 3 contract: adjust the tenant-global pool. */
  async adjust(dto: AdjustInventoryDto): Promise<InventorySummary> {
    return this.adjustScoped({ kind: 'global' }, dto);
  }

  /** Store-scoped guarded adjust (same invariants as the global pool). */
  async adjustScoped(
    scope: InventoryScope,
    dto: AdjustInventoryDto,
  ): Promise<InventorySummary> {
    this.assertTenantContext();
    const variant = await this.findVariant(dto.variantId);
    if (!variant) throw new NotFoundException(VARIANT_NOT_FOUND);
    await this.assertScopeStore(scope);
    const tenantId = this.tenantContext.requireTenantId();
    const pool = this.poolWhere(scope, dto.variantId);
    const storeId = scope.kind === 'store' ? scope.storeId : null;
    const delta = dto.delta;

    // Guarded atomic increment (no read-modify-write). For positive delta
    // the gte condition is trivially satisfied when the row exists; for
    // negative delta it enforces sufficient stock in THIS pool only.
    const updated = await this.prisma.inventory.updateMany({
      where: { ...pool, quantityOnHand: { gte: -delta } },
      data: { quantityOnHand: { increment: delta } },
    });

    if (updated.count === 1) {
      const inventory = await this.prisma.inventory.findFirst({
        where: pool,
      });
      if (!inventory) throw new ConflictException(INSUFFICIENT_STOCK);
      return this.toSummary(inventory);
    }

    // count 0: either missing pool row or insufficient stock in this pool.
    const existing = await this.prisma.inventory.findFirst({ where: pool });

    if (!existing) {
      if (delta < 0) throw new ConflictException(INSUFFICIENT_STOCK);
      try {
        const created = await this.prisma.inventory.create({
          data: {
            tenantId,
            variantId: dto.variantId,
            storeId,
            quantityOnHand: delta,
          },
        });
        return this.toSummary(created);
      } catch (error) {
        if (this.isP2002(error)) {
          // Race on the pool's partial unique index — retry the guarded
          // update (the other creator's row is now visible).
          const retry = await this.prisma.inventory.updateMany({
            where: { ...pool, quantityOnHand: { gte: -delta } },
            data: { quantityOnHand: { increment: delta } },
          });
          if (retry.count === 1) {
            const inventory = await this.prisma.inventory.findFirst({
              where: pool,
            });
            if (!inventory) throw new ConflictException(INSUFFICIENT_STOCK);
            return this.toSummary(inventory);
          }
          throw new ConflictException(INSUFFICIENT_STOCK);
        }
        throw error;
      }
    }

    throw new ConflictException(INSUFFICIENT_STOCK);
  }

  /**
   * Resolve a scope to its pool where-clause. Callers validate the scope's
   * store first via assertScopeStore (foreign/unknown store -> uniform 404,
   * the Asset.storeId precedent).
   */
  private poolWhere(scope: InventoryScope, variantId: string): PoolWhere {
    if (scope.kind === 'global') return { variantId, storeId: null };
    return { variantId, storeId: scope.storeId };
  }

  /** Tenant-scoped store validation for a 'store' scope (uniform 404). */
  private async assertScopeStore(scope: InventoryScope): Promise<void> {
    if (scope.kind !== 'store') return;
    const store = await this.prisma.store.findUnique({
      where: { id: scope.storeId },
    });
    if (!store) throw new NotFoundException(STORE_NOT_FOUND);
  }

  /** Tenant-scoped store existence check (exported for POS reuse). */
  async storeExists(storeId: string): Promise<boolean> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
    });
    return store !== null;
  }

  private async findVariant(variantId: string): Promise<ProductVariant | null> {
    return this.prisma.productVariant.findUnique({
      where: { id: variantId },
    });
  }

  private zeroSummary(
    scope: InventoryScope,
    variantId: string,
  ): InventorySummary {
    const tenantId = this.tenantContext.requireTenantId();
    return {
      id: null,
      tenantId,
      storeId: scope.kind === 'store' ? scope.storeId : null,
      variantId,
      quantityOnHand: 0,
      createdAt: null,
      updatedAt: null,
    };
  }

  private toSummary(inventory: Inventory): InventorySummary {
    return {
      id: inventory.id,
      tenantId: inventory.tenantId,
      storeId: inventory.storeId,
      variantId: inventory.variantId,
      quantityOnHand: inventory.quantityOnHand,
      createdAt: inventory.createdAt,
      updatedAt: inventory.updatedAt,
    };
  }

  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }

  private isP2002(
    error: unknown,
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}
