import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { TenantAdminController } from './tenant-admin.controller';
import { TenantAdminService } from './tenant-admin.service';

/**
 * Tenant administration: reading/updating the current tenant's safe fields.
 * Imports TenantModule for the guard/interceptor and RbacModule for
 * PermissionService (settings:read / settings:manage evaluation). Placed in
 * its own module (rather than inside TenantModule) to avoid a module cycle:
 * RbacModule imports TenantModule, and this service needs PermissionService.
 */
@Module({
  imports: [TenantModule, RbacModule],
  controllers: [TenantAdminController],
  providers: [TenantAdminService],
})
export class TenantAdminModule {}
