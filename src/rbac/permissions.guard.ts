import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantScopedRequest } from '../tenant/tenant-resolution.guard';
import {
  PERMISSIONS_METADATA_KEY,
  type PermissionRequirement,
} from './permission.decorator';
import { PermissionService } from './permission.service';

/**
 * Evaluates @RequirePermission / @RequireAnyPermission metadata. Must run
 * AFTER TenantResolutionGuard so request.user and request.tenant exist. The
 * permission lookup itself is executed inside the tenant context because the
 * TenantContextInterceptor (which establishes context for the handler) runs
 * after guards.
 *
 * NOTE (memoization): the guard's tenantContext.run() and the interceptor's
 * handler store are two distinct AsyncLocalStorage stores, so the per-request
 * permission memo is scoped per store. The snapshot computed here is NOT
 * reused by the handler (and vice versa), so on routes with both a guard check
 * and a service permission check the snapshot may be loaded twice per request.
 * This is a documented performance trade-off, not a correctness/leak issue:
 * the memo can never cross requests or tenants. Fixing it would require
 * sharing a single store between guard and interceptor, which changes guard
 * ordering — deliberately left unchanged.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionService: PermissionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement>(
      PERMISSIONS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requirement || requirement.permissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<TenantScopedRequest>();
    const tenantId = request.tenant?.id;
    if (!tenantId) {
      throw new ForbiddenException('Tenant access denied');
    }

    await this.tenantContext.run(tenantId, async () =>
      this.permissionService.assertPermissions(
        request.user.userId,
        requirement,
      ),
    );
    return true;
  }
}
