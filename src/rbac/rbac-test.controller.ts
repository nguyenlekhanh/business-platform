import { Controller, Get, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantContextInterceptor } from '../tenant/tenant-context.interceptor';
import { TenantResolutionGuard } from '../tenant/tenant-resolution.guard';
import { CurrentUser } from './current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermission,
} from './permission.decorator';
import { PERMISSIONS } from './permission-catalog';
import { PermissionService } from './permission.service';
import { PermissionsGuard } from './permissions.guard';

/**
 * TEST-ONLY endpoints that exercise the authorization stack: JWT ->
 * TenantResolutionGuard -> PermissionsGuard -> PermissionService. They exist
 * only to prove the architecture in tests and must not be used as a reference
 * for production routes.
 */
@ApiTags('rbac')
@Controller('rbac/_test')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
export class RbacTestController {
  constructor(private readonly permissionService: PermissionService) {}

  @Get('store-read')
  @RequirePermission(PERMISSIONS.STORE_READ)
  @ApiOperation({ summary: 'TEST-ONLY: requires store:read' })
  storeRead(
    @CurrentUser() user: { userId: string },
  ): Promise<{ granted: boolean; keys: readonly string[]; isOwner: boolean }> {
    return this.permissionService
      .getPermissions(user.userId)
      .then((snapshot) => ({
        granted: true,
        keys: snapshot.keys,
        isOwner: snapshot.isOwner,
      }));
  }

  @Get('any-report-settings')
  @RequireAnyPermission(PERMISSIONS.REPORT_READ, PERMISSIONS.SETTINGS_READ)
  @ApiOperation({ summary: 'TEST-ONLY: requires report:read OR settings:read' })
  anyReportSettings(): { granted: true } {
    return { granted: true };
  }
}
