import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtUser } from '../auth/jwt.strategy';

/**
 * Resolves the authenticated user already attached to the request by
 * TenantResolutionGuard (via the JWT strategy). No database query is
 * performed here.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtUser | undefined => {
    const request = ctx.switchToHttp().getRequest<{ user?: JwtUser }>();
    return request.user;
  },
);
