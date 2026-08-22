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
const INSUFFICIENT_STOCK = 'Insufficient stock';

export interface InventorySummary {
  id: string | null;
  tenantId: string;
  variantId: string;
  quantityOnHand: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/**
 * Inventory — Phase 3 U4.
 *
 * Single stock pool per variant, lazy row (missing == 0). Mutations are
 * atomic guarded conditional writes via updateMany + increment; never
 * read-modify-write. DB CHECK (quantityOnHand >=0) is defense in depth.
 * Tenant isolation mirrors ProductVariant: variant lookup is tenant-scoped,
 * so a foreign variantId is an indistinguishable 404 before any inventory
 * access. All Prisma calls are tenant-scoped via the extension.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async getInventory(variantId: string): Promise<InventorySummary> {
    this.assertTenantContext();
    const variant = await this.findVariant(variantId);
    if (!variant) {
      throw new NotFoundException(VARIANT_NOT_FOUND);
    }
    const inventory = await this.prisma.inventory.findUnique({
      where: { variantId },
    });
    if (!inventory) {
      return this.zeroSummary(variantId);
    }
    return this.toSummary(inventory);
  }

  async adjust(dto: AdjustInventoryDto): Promise<InventorySummary> {
    this.assertTenantContext();
    const variant = await this.findVariant(dto.variantId);
    if (!variant) {
      throw new NotFoundException(VARIANT_NOT_FOUND);
    }
    const tenantId = this.tenantContext.requireTenantId();
    const delta = dto.delta;

    // Attempt guarded atomic increment (no read-modify-write).
    // For positive delta, condition gte:-delta is always true when row exists
    // (0 >= negative). For negative delta, it enforces sufficient stock.
    const updated = await this.prisma.inventory.updateMany({
      where: {
        variantId: dto.variantId,
        quantityOnHand: { gte: -delta },
      },
      data: {
        quantityOnHand: { increment: delta },
      },
    });

    if (updated.count === 1) {
      const inventory = await this.prisma.inventory.findUnique({
        where: { variantId: dto.variantId },
      });
      // updateMany succeeded so row must exist
      if (!inventory) {
        throw new ConflictException(INSUFFICIENT_STOCK);
      }
      return this.toSummary(inventory);
    }

    // count 0: either missing row or insufficient stock
    const existing = await this.prisma.inventory.findUnique({
      where: { variantId: dto.variantId },
    });

    if (!existing) {
      // Missing row == 0 on hand
      if (delta < 0) {
        throw new ConflictException(INSUFFICIENT_STOCK);
      }
      // delta >0 : try to create lazy row
      try {
        const created = await this.prisma.inventory.create({
          data: {
            tenantId,
            variantId: dto.variantId,
            quantityOnHand: delta,
          },
        });
        return this.toSummary(created);
      } catch (error) {
        if (this.isP2002(error)) {
          // Race: another request created the row first — retry guarded update
          const retry = await this.prisma.inventory.updateMany({
            where: {
              variantId: dto.variantId,
              quantityOnHand: { gte: -delta },
            },
            data: {
              quantityOnHand: { increment: delta },
            },
          });
          if (retry.count === 1) {
            const inventory = await this.prisma.inventory.findUnique({
              where: { variantId: dto.variantId },
            });
            if (!inventory) {
              throw new ConflictException(INSUFFICIENT_STOCK);
            }
            return this.toSummary(inventory);
          }
          throw new ConflictException(INSUFFICIENT_STOCK);
        }
        throw error;
      }
    }

    // Row exists but guarded update failed -> insufficient stock
    throw new ConflictException(INSUFFICIENT_STOCK);
  }

  private async findVariant(variantId: string): Promise<ProductVariant | null> {
    return this.prisma.productVariant.findUnique({
      where: { id: variantId },
    });
  }

  private zeroSummary(variantId: string): InventorySummary {
    const tenantId = this.tenantContext.requireTenantId();
    return {
      id: null,
      tenantId,
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
