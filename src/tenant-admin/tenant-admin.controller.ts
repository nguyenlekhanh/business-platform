import {
  Body,
  Controller,
  Get,
  Put,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { JwtUser } from '../auth/jwt.strategy';
import { CurrentUser } from '../rbac/current-user.decorator';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { TenantContextInterceptor } from '../tenant/tenant-context.interceptor';
import { TenantResolutionGuard } from '../tenant/tenant-resolution.guard';
import { UpdateTenantDto } from './dto/tenant-admin.dto';
import { TenantAdminService, TenantSummary } from './tenant-admin.service';

/**
 * Tenant administration endpoints. Guard chain per route: JWT ->
 * TenantResolutionGuard -> PermissionsGuard. Authorization is enforced inside
 * TenantAdminService via PermissionService (settings:read / settings:manage,
 * owner semantics included), so the controller only wires authentication +
 * tenant resolution. There is NO tenantId parameter anywhere: the tenant is
 * always the one resolved from the X-Tenant-ID header into the TenantContext.
 */
@ApiTags('tenant')
@Controller('tenant')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class TenantAdminController {
  constructor(private readonly tenantAdminService: TenantAdminService) {}

  @Get()
  @ApiOperation({ summary: 'Get the current tenant' })
  get(@CurrentUser() user: JwtUser): Promise<TenantSummary> {
    return this.tenantAdminService.getTenant(user.userId);
  }

  @Put()
  @ApiOperation({ summary: 'Update the current tenant (name, slug, settings)' })
  update(
    @CurrentUser() user: JwtUser,
    @Body() dto: UpdateTenantDto,
  ): Promise<TenantSummary> {
    return this.tenantAdminService.updateTenant(user.userId, dto);
  }
}
