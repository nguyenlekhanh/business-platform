import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { JwtUser } from './jwt.strategy';

/**
 * Resolves the authenticated identity attached to the request by
 * JwtAuthGuard. The userId always originates from the verified token, never
 * from client-supplied input.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user: JwtUser }>();
    return request.user;
  },
);
