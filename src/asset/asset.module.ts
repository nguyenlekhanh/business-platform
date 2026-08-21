import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { AssetController } from './asset.controller';
import { AssetService } from './asset.service';

/**
 * Asset (generic equipment/resource) administration. Imports TenantModule for
 * the guard/interceptor and RbacModule for PermissionsGuard (asset:* permission
 * evaluation). AssetModule does NOT import StoreModule to avoid a circular
 * dependency: storeId is validated through the tenant-scoped Prisma Store lookup
 * (the extension enforces tenant scoping), which is sufficient and keeps the
 * module graph acyclic.
 */
@Module({
  imports: [TenantModule, RbacModule],
  controllers: [AssetController],
  providers: [AssetService],
})
export class AssetModule {}
