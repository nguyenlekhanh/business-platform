import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Tenant } from '@prisma/client';
import { TenantScopedRequest } from './tenant-resolution.guard';

/**
 * Resolves the tenant already established by TenantResolutionGuard. No
 * database query is performed here: the tenant was fetched during guard
 * execution and stored on the request.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Tenant | undefined => {
    const request = ctx.switchToHttp().getRequest<TenantScopedRequest>();
    return request.tenant;
  },
);
