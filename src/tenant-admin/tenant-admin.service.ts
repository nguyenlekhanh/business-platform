import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Tenant, TenantStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PERMISSIONS } from '../rbac/permission-catalog';
import { PermissionService } from '../rbac/permission.service';
import { UpdateTenantDto } from './dto/tenant-admin.dto';

const TENANT_NOT_FOUND = 'Tenant not found';
const SLUG_TAKEN = 'Slug is already in use';

/** Safe tenant projection returned to clients: only scalar tenant fields. */
export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  settings: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tenant administration: reading the current tenant and updating its allowed
 * fields (name, slug, settings).
 *
 * SECURITY CONTRACT:
 * - The tenant identity is ALWAYS server-derived from the TenantContext
 *   (requireTenantId). The controller exposes no tenantId query/path/body
 *   parameter, so a client can never point these operations at another tenant.
 * - The Tenant model is global (not in the tenant-scoped set), so the read and
 *   update run by id with the context-derived tenantId and fail closed (500)
 *   if no context exists.
 * - `status` is not updatable here: status management is explicitly out of
 *   scope for this phase (no endpoint, no DTO field). TenantResolutionGuard
 *   already enforces that only ACTIVE tenants are reachable.
 * - A duplicate slug surfaces as a Prisma P2002 unique-constraint violation
 *   which is mapped to 409.
 */
@Injectable()
export class TenantAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionService: PermissionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async getTenant(actorUserId: string): Promise<TenantSummary> {
    await this.assertRead(actorUserId);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: this.tenantContext.requireTenantId() },
    });
    if (!tenant) {
      throw new NotFoundException(TENANT_NOT_FOUND);
    }
    return this.toSummary(tenant);
  }

  async updateTenant(
    actorUserId: string,
    dto: UpdateTenantDto,
  ): Promise<TenantSummary> {
    await this.assertManage(actorUserId);
    const tenantId = this.tenantContext.requireTenantId();
    try {
      const tenant = await this.prisma.tenant.update({
        where: { id: tenantId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
          ...(dto.settings !== undefined
            ? { settings: dto.settings as Prisma.InputJsonValue }
            : {}),
        },
      });
      return this.toSummary(tenant);
    } catch (error) {
      if (this.isP2002(error)) {
        throw new ConflictException(SLUG_TAKEN);
      }
      throw error;
    }
  }

  /** Asserts the actor holds settings:read (owner semantics included). */
  private assertRead(actorUserId: string): Promise<void> {
    return this.permissionService.assertPermissions(actorUserId, {
      mode: 'ALL',
      permissions: [PERMISSIONS.SETTINGS_READ],
    });
  }

  /** Asserts the actor holds settings:manage (owner semantics included). */
  private assertManage(actorUserId: string): Promise<void> {
    return this.permissionService.assertPermissions(actorUserId, {
      mode: 'ALL',
      permissions: [PERMISSIONS.SETTINGS_MANAGE],
    });
  }

  private toSummary(tenant: Tenant): TenantSummary {
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      settings: tenant.settings,
      createdAt: tenant.createdAt,
      updatedAt: tenant.updatedAt,
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
