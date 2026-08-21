import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Equipment, EquipmentType } from '@prisma/client';
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
  CreateEquipmentDto,
  EquipmentListQueryDto,
  UpdateEquipmentDto,
} from './dto/equipment.dto';

const EQUIPMENT_NOT_FOUND = 'Equipment not found';
const ASSET_NOT_FOUND = 'Asset not found';
const ASSET_ALREADY_EQUIPPED = 'This asset already has an equipment record';
const SERIAL_TAKEN =
  'An equipment with this serial number already exists in the tenant';

/**
 * Safe equipment projection: scalar identity fields only, no relation
 * traversal into tenant-scoped models.
 */
export interface EquipmentSummary {
  id: string;
  tenantId: string;
  assetId: string;
  type: EquipmentType;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  year: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Equipment (rentable equipment identity) administration on top of Asset.
 *
 * SECURITY CONTRACT (mirrors AssetService):
 * - Tenant identity is ALWAYS server-derived via TenantContext.requireTenantId()
 *   and fails closed when the context is missing. A client-supplied tenantId
 *   is never accepted: create passes only the context-derived id, which the
 *   centralized extension enforces on every write.
 * - Equipment is a tenant-scoped model in the centralized Prisma extension, so
 *   every top-level read/write is automatically scoped; an equipment id from
 *   another tenant resolves to null (404).
 * - The extension injects tenantId into create/update data — the service never
 *   writes it.
 * - The 1:1 Asset link is resolved through a tenant-scoped Asset lookup: an
 *   unknown or cross-tenant assetId is rejected with 404 BEFORE any write.
 *   A duplicate attachment surfaces as P2002 on the unique assetId -> 409.
 * - A duplicate (tenantId, serialNumber) surfaces as P2002 -> 409. Serial
 *   uniqueness is deliberately tenant-scoped, never global.
 * - The Asset link is immutable after creation: UpdateEquipmentDto has no
 *   assetId field, so re-parenting is impossible via the API.
 * - No raw SQL, no nested writes, no generic RolePermission CRUD.
 */
@Injectable()
export class EquipmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Paginated, filtered equipment list (Phase 2J contract): keyset over
   * (createdAt, id) with the shared envelope; equality filter type. Tenant
   * scoping stays centralized in the Prisma extension.
   */
  async listEquipment(
    query: EquipmentListQueryDto,
  ): Promise<Paginated<EquipmentSummary>> {
    this.assertTenantContext();
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const direction = query.order ?? 'asc';

    const equality: Record<string, unknown> = {};
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
    ) as Prisma.EquipmentWhereInput;

    const page = await fetchPage(
      async () =>
        (await this.prisma.equipment.findMany({
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
      data: page.data.map((row) => this.toSummary(row as unknown as Equipment)),
      meta: page.meta,
    };
  }

  async getEquipment(id: string): Promise<EquipmentSummary> {
    this.assertTenantContext();
    const item = await this.findEquipment(id);
    if (!item) {
      throw new NotFoundException(EQUIPMENT_NOT_FOUND);
    }
    return this.toSummary(item);
  }

  async createEquipment(dto: CreateEquipmentDto): Promise<EquipmentSummary> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.resolveAssetId(dto.assetId);
    try {
      const item = await this.prisma.equipment.create({
        data: {
          tenantId,
          assetId: dto.assetId,
          type: dto.type,
          ...(dto.manufacturer !== undefined
            ? { manufacturer: dto.manufacturer }
            : {}),
          ...(dto.model !== undefined ? { model: dto.model } : {}),
          ...(dto.serialNumber !== undefined
            ? { serialNumber: dto.serialNumber }
            : {}),
          ...(dto.year !== undefined ? { year: dto.year } : {}),
        },
      });
      return this.toSummary(item);
    } catch (error) {
      return this.reraiseConflict(error);
    }
  }

  async updateEquipment(
    id: string,
    dto: UpdateEquipmentDto,
  ): Promise<EquipmentSummary> {
    this.assertTenantContext();
    const item = await this.findEquipment(id);
    if (!item) {
      throw new NotFoundException(EQUIPMENT_NOT_FOUND);
    }
    try {
      const updated = await this.prisma.equipment.update({
        where: { id },
        data: {
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.manufacturer !== undefined
            ? { manufacturer: dto.manufacturer }
            : {}),
          ...(dto.model !== undefined ? { model: dto.model } : {}),
          ...(dto.serialNumber !== undefined
            ? { serialNumber: dto.serialNumber }
            : {}),
          ...(dto.year !== undefined ? { year: dto.year } : {}),
        },
      });
      return this.toSummary(updated);
    } catch (error) {
      return this.reraiseConflict(error);
    }
  }

  async deleteEquipment(id: string): Promise<{ id: string }> {
    this.assertTenantContext();
    const item = await this.findEquipment(id);
    if (!item) {
      throw new NotFoundException(EQUIPMENT_NOT_FOUND);
    }
    await this.prisma.equipment.delete({ where: { id } });
    return { id };
  }

  /**
   * Resolves a client-supplied assetId through a tenant-scoped Asset lookup.
   * An unknown or cross-tenant asset resolves to null -> 404 before any write.
   */
  private async resolveAssetId(assetId: string): Promise<void> {
    const asset = await this.prisma.asset.findUnique({
      where: { id: assetId },
      select: { id: true },
    });
    if (!asset) {
      throw new NotFoundException(ASSET_NOT_FOUND);
    }
  }

  /** Tenant-scoped equipment lookup. The extension merges tenantId into the
   *  where clause, so an id from another tenant resolves to null. */
  private findEquipment(id: string): Promise<Equipment | null> {
    return this.prisma.equipment.findUnique({ where: { id } });
  }

  /** Maps P2002 unique violations to their business meaning (409), based on
   *  which unique constraint fired. Non-P2002 errors are rethrown untouched. */
  private reraiseConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const target = (error.meta as { target?: string[] } | undefined)?.target;
      if (Array.isArray(target) && target.includes('serialNumber')) {
        throw new ConflictException(SERIAL_TAKEN);
      }
      throw new ConflictException(ASSET_ALREADY_EQUIPPED);
    }
    throw error as Error;
  }

  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }

  private toSummary(item: Equipment): EquipmentSummary {
    return {
      id: item.id,
      tenantId: item.tenantId,
      assetId: item.assetId,
      type: item.type,
      manufacturer: item.manufacturer,
      model: item.model,
      serialNumber: item.serialNumber,
      year: item.year,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
