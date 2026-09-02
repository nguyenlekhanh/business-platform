import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Service } from '@prisma/client';
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
  CreateServiceDto,
  ServiceListQueryDto,
  UpdateServiceDto,
} from './dto/service.dto';

const SERVICE_NOT_FOUND = 'Service not found';
const NAME_TAKEN = 'A service with this name already exists in the tenant';

/** Safe service projection: all scalar fields, no relation traversal. */
export interface ServiceSummary {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  status: Service['status'];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Service catalog administration — Phase 5 P5-U1.
 *
 * The Service model is a tenant-scoped CATALOG DEFINITION only (approved
 * B2): nothing here implements booking, scheduling, availability, staff,
 * resources, pricing, or payment. The unit is deliberately the smallest
 * durable foundation; every future semantic (pricing B23, duration B5, the
 * booking target B1) is deferred to explicitly approved units and this
 * model must not preclude any of them.
 *
 * SECURITY CONTRACT (mirrors CategoryService/ProductService):
 * - The tenant identity is ALWAYS server-derived: each method asserts the
 *   TenantContext (requireTenantId) and fails closed (500) when it is
 *   missing. tenantId is never a method parameter or client input; the
 *   extension injects the context tenant into every create/update.
 * - Service is a tenant-scoped model in the centralized Prisma extension,
 *   so every top-level read/write is automatically scoped; a service id
 *   from another tenant resolves to null (uniform 404).
 * - A duplicate (tenantId, name) surfaces as Prisma P2002 -> 409. The same
 *   name in different tenants is allowed (composite constraint).
 * - No raw SQL, no nested writes, no relation traversal.
 *
 * CRUD SEMANTICS (the established catalog pattern — Product, not Category):
 * - status: DRAFT default on create; PATCH carries the archive flow
 *   (soft-retirement via ARCHIVED instead of deletion).
 * - NO delete endpoint: nothing references a Service yet, and the approved
 *   scope has no deletion semantics (a future Booking FK will RESTRICT
 *   deletion the same way Product does for Category).
 */
@Injectable()
export class ServiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Paginated service list (established catalog contract): keyset over
   * (createdAt, id) with the shared envelope + a status equality filter
   * (the ProductListQueryDto filter shape). Tenant scoping stays
   * centralized in the Prisma extension.
   */
  async listServices(
    query: ServiceListQueryDto,
  ): Promise<Paginated<ServiceSummary>> {
    this.assertTenantContext();
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const direction = query.order ?? 'asc';

    const equality: Record<string, unknown> = {};
    if (query.status !== undefined) {
      equality.status = query.status;
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
    ) as Prisma.ServiceWhereInput;

    const page = await fetchPage(
      async () =>
        (await this.prisma.service.findMany({
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
      data: page.data.map((row) => this.toSummary(row as unknown as Service)),
      meta: page.meta,
    };
  }

  async getService(serviceId: string): Promise<ServiceSummary> {
    this.assertTenantContext();
    const service = await this.findService(serviceId);
    if (!service) {
      throw new NotFoundException(SERVICE_NOT_FOUND);
    }
    return this.toSummary(service);
  }

  async createService(dto: CreateServiceDto): Promise<ServiceSummary> {
    // The tenant identity comes ONLY from the TenantContext: server-derived
    // and never a client parameter. The extension additionally forces this
    // tenantId into the create, so it can never be overridden.
    const tenantId = this.tenantContext.requireTenantId();
    try {
      const service = await this.prisma.service.create({
        data: {
          tenantId,
          name: dto.name,
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
      return this.toSummary(service);
    } catch (error) {
      if (this.isP2002(error)) {
        throw new ConflictException(NAME_TAKEN);
      }
      throw error;
    }
  }

  async updateService(
    serviceId: string,
    dto: UpdateServiceDto,
  ): Promise<ServiceSummary> {
    this.assertTenantContext();
    const service = await this.findService(serviceId);
    if (!service) {
      throw new NotFoundException(SERVICE_NOT_FOUND);
    }
    // The tenant is NEVER written here: the extension scopes the update to
    // the active TenantContext (where: tenantId), so a caller cannot point
    // this at another tenant.
    try {
      const updated = await this.prisma.service.update({
        where: { id: serviceId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
      return this.toSummary(updated);
    } catch (error) {
      if (this.isP2002(error)) {
        throw new ConflictException(NAME_TAKEN);
      }
      throw error;
    }
  }

  /**
   * Tenant-scoped service lookup. The extension merges the active tenantId
   * into the where clause, so a service id from another tenant resolves to
   * null.
   */
  private findService(serviceId: string): Promise<Service | null> {
    return this.prisma.service.findUnique({ where: { id: serviceId } });
  }

  /**
   * Defense in depth: the service methods require an active TenantContext
   * even before hitting the Prisma extension. This makes the fail-closed
   * contract explicit at the service boundary (and unit-testable without
   * the extension).
   */
  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }

  private toSummary(service: Service): ServiceSummary {
    return {
      id: service.id,
      tenantId: service.tenantId,
      name: service.name,
      description: service.description,
      status: service.status,
      createdAt: service.createdAt,
      updatedAt: service.updatedAt,
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
