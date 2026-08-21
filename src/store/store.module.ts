import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';

/**
 * Store (generic business unit) administration. Imports TenantModule for the
 * guard/interceptor and RbacModule for PermissionsGuard + PermissionService
 * (store:* permission evaluation). The controller uses the same guard chain as
 * the other tenant-scoped controllers.
 */
@Module({
  imports: [TenantModule, RbacModule],
  controllers: [StoreController],
  providers: [StoreService],
})
export class StoreModule {}
