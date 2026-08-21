import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Store, StoreStatus, StoreType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import {
  buildOrderBy,
  encodeRowCursor,
  fetchPage,
  Paginated,
  resolveListContinuation,
} from '../common/pagination/paginate';
import { DEFAULT_PAGE_SIZE } from '../common/pagination/pagination-query.dto';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  CreateStoreDto,
  StoreListQueryDto,
  UpdateStoreDto,
} from './dto/store.dto';

const STORE_NOT_FOUND = 'Store not found';
const CODE_TAKEN = 'A store with this code already exists in the tenant';

/** Safe store projection: all scalar fields, no relation traversal. */
export interface StoreSummary {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  type: StoreType;
  status: StoreStatus;
  settings: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Store (generic business unit) administration.
 *
 * SECURITY CONTRACT:
 * - The tenant identity is ALWAYS server-derived: each method asserts the
 *   TenantContext (requireTenantId) and fails closed (500) when it is missing.
 *   tenantId is never accepted as a method parameter or from client input.
 * - Store is a tenant-scoped model in the centralized Prisma extension, so
 *   every top-level read/write here is automatically scoped to the active
 *   tenant; a store id from another tenant resolves to null (404).
 * - The tenantId is injected by the extension into create/update data — the
 *   service never writes it, so callers cannot override it.
 * - A duplicate (tenantId, code) surfaces as a Prisma P2002 unique-constraint
 *   violation which is mapped to 409. The same code in different tenants is
 *   allowed because the constraint is composite (tenantId, code).
 * - No raw SQL, no nested writes, no generic RolePermission CRUD.
 */
@Injectable()
export class StoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Paginated, filtered store list (Phase 2J contract): keyset over
   * (createdAt, id) with the shared envelope; equality filters status/type.
   * Tenant scoping stays centralized in the Prisma extension.
   */
  async listStores(query: StoreListQueryDto): Promise<Paginated<StoreSummary>> {
    this.assertTenantContext();
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const direction = query.order ?? 'asc';

    const equality: Record<string, unknown> = {};
    if (query.status !== undefined) {
      equality.status = query.status;
    }
    if (query.type !== undefined) {
      equality.type = query.type;
    }

    const { fingerprint, keyset } = resolveListContinuation({
      cursor: query.cursor,
      sortBy: 'createdAt',
      direction,
      equality,
    });

    const predicates: Record<string, unknown>[] = [];
    if (Object.keys(equality).length > 0) {
      predicates.push(equality);
    }
    if (keyset !== undefined) {
      predicates.push(keyset);
    }
    const where = (
      predicates.length > 0 ? { AND: predicates } : {}
    ) as Prisma.StoreWhereInput;

    const page = await fetchPage(
      async () =>
        (await this.prisma.store.findMany({
          where,
          orderBy: buildOrderBy('createdAt', direction),
          take: limit + 1,
        })) as unknown as Array<Record<string, unknown>>,
      limit,
      encodeRowCursor,
      'createdAt',
      direction,
      fingerprint,
    );
    return {
      data: page.data.map((row) => this.toSummary(row as unknown as Store)),
      meta: page.meta,
    };
  }

  async getStore(storeId: string): Promise<StoreSummary> {
    this.assertTenantContext();
    const store = await this.findStore(storeId);
    if (!store) {
      throw new NotFoundException(STORE_NOT_FOUND);
    }
    return this.toSummary(store);
  }

  async createStore(dto: CreateStoreDto): Promise<StoreSummary> {
    // The tenant identity comes ONLY from the TenantContext: server-derived
    // and never a client parameter. The Prisma extension additionally forces
    // this tenantId into the create, so it can never be overridden.
    const tenantId = this.tenantContext.requireTenantId();
    try {
      const store = await this.prisma.store.create({
        data: {
          tenantId,
          name: dto.name,
          code: dto.code,
          type: dto.type,
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.settings !== undefined
            ? { settings: dto.settings as Prisma.InputJsonValue }
            : {}),
        },
      });
      return this.toSummary(store);
    } catch (error) {
      if (this.isP2002(error)) {
        throw new ConflictException(CODE_TAKEN);
      }
      throw error;
    }
  }

  async updateStore(
    storeId: string,
    dto: UpdateStoreDto,
  ): Promise<StoreSummary> {
    this.assertTenantContext();
    const store = await this.findStore(storeId);
    if (!store) {
      throw new NotFoundException(STORE_NOT_FOUND);
    }
    // The tenant is NEVER written here: the extension scopes the update to the
    // active TenantContext (where: tenantId) and injects it into data, so a
    // caller cannot point this at another tenant.
    try {
      const updated = await this.prisma.store.update({
        where: { id: storeId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.code !== undefined ? { code: dto.code } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.settings !== undefined
            ? { settings: dto.settings as Prisma.InputJsonValue }
            : {}),
        },
      });
      return this.toSummary(updated);
    } catch (error) {
      if (this.isP2002(error)) {
        throw new ConflictException(CODE_TAKEN);
      }
      throw error;
    }
  }

  async deleteStore(storeId: string): Promise<{ id: string }> {
    this.assertTenantContext();
    const store = await this.findStore(storeId);
    if (!store) {
      throw new NotFoundException(STORE_NOT_FOUND);
    }
    await this.prisma.store.delete({ where: { id: storeId } });
    return { id: storeId };
  }

  /**
   * Tenant-scoped store lookup. The extension merges the active tenantId into
   * the where clause, so a storeId from another tenant resolves to null.
   */
  private findStore(storeId: string): Promise<Store | null> {
    return this.prisma.store.findUnique({ where: { id: storeId } });
  }

  /**
   * Defense in depth: the store methods require an active TenantContext even
   * before hitting the Prisma extension. This makes the fail-closed contract
   * explicit at the service boundary (and unit-testable without the extension).
   */
  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }

  private toSummary(store: Store): StoreSummary {
    return {
      id: store.id,
      tenantId: store.tenantId,
      name: store.name,
      code: store.code,
      type: store.type,
      status: store.status,
      settings: store.settings,
      createdAt: store.createdAt,
      updatedAt: store.updatedAt,
    };
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
