import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, lastValueFrom } from 'rxjs';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TenantScopedRequest } from './tenant-resolution.guard';

/**
 * Runs the downstream handler (and any async work it performs) inside the
 * AsyncLocalStorage tenant context. The context survives asynchronous
 * operations because AsyncLocalStorage propagates through awaited promises.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<TenantScopedRequest>();
    const tenantId = request.tenant?.id;
    if (!tenantId) {
      return next.handle();
    }
    return from(
      this.tenantContext.run(tenantId, () => lastValueFrom(next.handle())),
    );
  }
}
