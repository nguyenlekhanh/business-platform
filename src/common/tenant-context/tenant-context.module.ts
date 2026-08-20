import { Global, Module } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';

/**
 * Global cross-cutting module: the tenant context is consumed by the Prisma
 * tenant-scoping layer (PrismaModule) as well as the tenant feature module, so
 * it lives here as a dependency-free leaf module to avoid module cycles.
 */
@Global()
@Module({
  providers: [TenantContextService],
  exports: [TenantContextService],
})
export class TenantContextModule {}
