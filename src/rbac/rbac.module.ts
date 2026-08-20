import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { PermissionService } from './permission.service';
import { PermissionsGuard } from './permissions.guard';
import { RoleController } from './role.controller';
import { RoleService } from './role.service';
import { RbacTestController } from './rbac-test.controller';

/**
 * RBAC: permission catalog evaluation (PermissionService + PermissionsGuard)
 * and role management (RoleService + RoleController).
 *
 * TenantContextService is provided globally by TenantContextModule; the module
 * imports TenantModule only for the guard/interceptor types. The controller
 * guards are applied per-route: JWT -> TenantResolutionGuard ->
 * PermissionsGuard.
 */
@Module({
  imports: [TenantModule],
  controllers: [RoleController, RbacTestController],
  providers: [PermissionService, PermissionsGuard, RoleService],
  exports: [PermissionService, PermissionsGuard, RoleService],
})
export class RbacModule {}
