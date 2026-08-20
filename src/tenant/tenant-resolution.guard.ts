import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Tenant } from '@prisma/client';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { JwtUser } from '../auth/jwt.strategy';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TenantService } from './tenant.service';

/** An authenticated request that has (optionally) resolved its tenant. */
export interface TenantScopedRequest extends Request {
  user: JwtUser;
  tenant?: Tenant;
}

const MISSING_TENANT_ERROR = 'Missing X-Tenant-ID header';
const TENANT_ACCESS_DENIED = 'Tenant access denied';

/**
 * Authenticates the JWT first (as a JwtAuthGuard), then resolves the tenant
 * from the X-Tenant-ID header via TenantService and attaches the resolved
 * Tenant to the request. The header is never trusted directly: membership and
 * tenant status are always verified against the database.
 */
@Injectable()
export class TenantResolutionGuard extends JwtAuthGuard {
  constructor(
    private readonly tenantService: TenantService,
    private readonly tenantContext: TenantContextService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);

    const request = context.switchToHttp().getRequest<TenantScopedRequest>();

    const rawTenantId = request.headers['x-tenant-id'];
    if (typeof rawTenantId !== 'string' || rawTenantId.trim() === '') {
      throw new BadRequestException(MISSING_TENANT_ERROR);
    }

    const tenantId = rawTenantId.trim();
    // The membership lookup runs inside the requested tenant's context because
    // tenant-scoped Prisma operations (membership/role/store) now fail closed
    // when no context exists and this resolution happens before the
    // TenantContextInterceptor establishes the downstream context.
    const tenant = await this.tenantContext.run(tenantId, () =>
      this.tenantService.resolveTenant(request.user.userId, tenantId),
    );
    if (!tenant) {
      throw new ForbiddenException(TENANT_ACCESS_DENIED);
    }

    request.tenant = tenant;
    return true;
  }
}
