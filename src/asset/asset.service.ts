import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Asset, AssetStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  buildOrderBy,
  encodeRowCursor,
  fetchPage,
  Paginated,
  resolveListContinuation,
} from '../common/pagination/paginate';
import { DEFAULT_PAGE_SIZE } from '../common/pagination/pagination-query.dto';
import {
  AssetListQueryDto,
  CreateAssetDto,
  UpdateAssetDto,
} from './dto/asset.dto';

const ASSET_NOT_FOUND = 'Asset not found';
const STORE_NOT_FOUND = 'Store not found';
const CODE_TAKEN = 'An asset with this code already exists in the tenant';

/**
 * Safe asset projection: all scalar fields, the optional storeId, and no
 * relation traversal into tenant-scoped models.
 */
export interface AssetSummary {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  type: string;
  description: string | null;
  status: AssetStatus;
  storeId: string | null;
  settings: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Asset (generic equipment/resource) administration.
 *
 * SECURITY CONTRACT (mirrors StoreService):
 * - Tenant identity is ALWAYS server-derived via TenantContext.requireTenantId()
 *   and fails closed when the context is missing. tenantId is never a method
 *   parameter or client input.
 * - Asset is a tenant-scoped model in the centralized Prisma extension, so
 *   every top-level read/write is automatically scoped; an asset/store id from
 *   another tenant resolves to null (404).
 * - The extension injects tenantId into create/update data — the service never
 *   writes it.
 * - A duplicate (tenantId, code) surfaces as Prisma P2002 -> 409.
 * - An optional storeId is validated through a tenant-scoped Store lookup so a
 *   cross-tenant store resolves to null -> 404 (DB-level tenant consistency is
 *   additionally backed by the Store.tenantId foreign key).
 * - No raw SQL, no nested writes, no generic RolePermission CRUD.
 */
@Injectable()
export class AssetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Paginated, filtered asset list (Phase 2J contract): keyset over
   * (createdAt, id) with the shared envelope; equality filters type/status/
   * storeId. Tenant scoping stays centralized in the Prisma extension; a
   * foreign storeId filter simply matches nothing.
   */
  async listAssets(query: AssetListQueryDto): Promise<Paginated<AssetSummary>> {
    this.assertTenantContext();
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const direction = query.order ?? 'asc';

    const equality: Record<string, unknown> = {};
    if (query.type !== undefined) {
      equality.type = query.type;
    }
    if (query.status !== undefined) {
      equality.status = query.status;
    }
    if (query.storeId !== undefined) {
      equality.storeId = query.storeId;
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
    ) as Prisma.AssetWhereInput;

    const page = await fetchPage(
      async () =>
        (await this.prisma.asset.findMany({
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
      data: page.data.map((row) => this.toSummary(row as unknown as Asset)),
      meta: page.meta,
    };
  }

  async getAsset(id: string): Promise<AssetSummary> {
    this.assertTenantContext();
    const asset = await this.findAsset(id);
    if (!asset) {
      throw new NotFoundException(ASSET_NOT_FOUND);
    }
    return this.toSummary(asset);
  }

  async createAsset(dto: CreateAssetDto): Promise<AssetSummary> {
    const tenantId = this.tenantContext.requireTenantId();
    const storeId = await this.resolveStoreId(dto.storeId);
    try {
      const asset = await this.prisma.asset.create({
        data: {
          tenantId,
          name: dto.name,
          code: dto.code,
          type: dto.type,
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          storeId: storeId ?? null,
          ...(dto.settings !== undefined
            ? { settings: dto.settings as Prisma.InputJsonValue }
            : {}),
        },
      });
      return this.toSummary(asset);
    } catch (error) {
      if (this.isP2002(error)) {
        throw new ConflictException(CODE_TAKEN);
      }
      throw error;
    }
  }

  async updateAsset(id: string, dto: UpdateAssetDto): Promise<AssetSummary> {
    this.assertTenantContext();
    const asset = await this.findAsset(id);
    if (!asset) {
      throw new NotFoundException(ASSET_NOT_FOUND);
    }
    const storeId = await this.resolveStoreId(dto.storeId);
    try {
      const updated = await this.prisma.asset.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.code !== undefined ? { code: dto.code } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(storeId !== undefined ? { storeId: storeId ?? null } : {}),
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

  async deleteAsset(id: string): Promise<{ id: string }> {
    this.assertTenantContext();
    const asset = await this.findAsset(id);
    if (!asset) {
      throw new NotFoundException(ASSET_NOT_FOUND);
    }
    try {
      await this.prisma.asset.delete({ where: { id } });
    } catch (error) {
      // Asset -> Equipment cascades, but Reservation.equipmentId is ON DELETE
      // RESTRICT (Phase 2G): an asset whose equipment has reservations cannot
      // be deleted - business history must survive.
      if (this.isP2003(error)) {
        throw new ConflictException(
          'Asset has reservations and cannot be deleted',
        );
      }
      throw error;
    }
    return { id };
  }

  /**
   * Resolves an optional client-supplied storeId through a tenant-scoped Store
   * lookup. A cross-tenant or missing store resolves to null -> the caller maps
   * that to a 404. Returns `undefined` when no storeId was supplied (asset stays
   * tenant-level).
   */
  private async resolveStoreId(
    storeId: string | undefined,
  ): Promise<string | undefined> {
    if (storeId === undefined) {
      return undefined;
    }
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });
    if (!store) {
      throw new NotFoundException(STORE_NOT_FOUND);
    }
    return store.id;
  }

  /** Tenant-scoped asset lookup. The extension merges tenantId into the where
   *  clause, so an asset id from another tenant resolves to null. */
  private findAsset(id: string): Promise<Asset | null> {
    return this.prisma.asset.findUnique({ where: { id } });
  }

  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }

  private toSummary(asset: Asset): AssetSummary {
    return {
      id: asset.id,
      tenantId: asset.tenantId,
      name: asset.name,
      code: asset.code,
      type: asset.type,
      description: asset.description,
      status: asset.status,
      storeId: asset.storeId,
      settings: asset.settings,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
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

  /** Foreign-key RESTRICT violation (e.g. equipment still has reservations). */
  private isP2003(
    error: unknown,
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003'
    );
  }
}
