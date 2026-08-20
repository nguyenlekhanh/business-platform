import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantResolutionGuard } from './tenant-resolution.guard';
import { TenantService } from './tenant.service';
import { TenantTestController } from './tenant-test.controller';

/**
 * Tenant resolution. TenantContextService is provided globally by
 * TenantContextModule. Imports AuthModule only for JwtAuthGuard/JwtStrategy;
 * AuthModule does not depend on TenantModule, so there is no cycle.
 */
@Module({
  imports: [AuthModule],
  controllers: [TenantTestController],
  providers: [TenantService, TenantResolutionGuard, TenantContextInterceptor],
  exports: [TenantService, TenantResolutionGuard, TenantContextInterceptor],
})
export class TenantModule {}
