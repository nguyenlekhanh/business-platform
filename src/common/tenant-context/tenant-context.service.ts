import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

interface TenantContextState {
  tenantId: string;
}

/**
 * Request-scoped tenant context backed by AsyncLocalStorage. No global
 * mutable state: the active tenant is bound to the async execution context of
 * the request, so concurrent requests never interfere.
 */
@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantContextState>();

  run<T>(tenantId: string, callback: () => T): T {
    return this.storage.run({ tenantId }, callback);
  }

  getTenantId(): string | undefined {
    return this.storage.getStore()?.tenantId;
  }

  requireTenantId(): string {
    const tenantId = this.getTenantId();
    if (!tenantId) {
      throw new InternalServerErrorException(
        'Tenant context is not available on this request',
      );
    }
    return tenantId;
  }
}
