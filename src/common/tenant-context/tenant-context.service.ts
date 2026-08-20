import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

interface TenantContextState {
  tenantId: string;
  /** Per-request scratch space (e.g. permission memoization). */
  memo?: Map<string, unknown>;
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

  /**
   * Returns the per-request memo map, creating it lazily. The memo lives on
   * the AsyncLocalStorage store, so it is scoped to the current request and
   * can never leak across requests. Returns undefined outside a context.
   */
  getMemo(): Map<string, unknown> | undefined {
    const store = this.storage.getStore();
    if (!store) {
      return undefined;
    }
    if (!store.memo) {
      store.memo = new Map<string, unknown>();
    }
    return store.memo;
  }

  /** Clears the per-request memo (called after RBAC mutations). */
  clearMemo(): void {
    this.storage.getStore()?.memo?.clear();
  }
}
