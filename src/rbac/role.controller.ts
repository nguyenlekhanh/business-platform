import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantContextInterceptor } from '../tenant/tenant-context.interceptor';
import { TenantResolutionGuard } from '../tenant/tenant-resolution.guard';
import { CurrentUser } from './current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import {
  AssignRolePermissionsDto,
  AssignRoleToMembershipDto,
  CreateRoleDto,
  UpdateRoleDto,
} from './dto/role.dto';
import { PermissionsGuard } from './permissions.guard';
import { RoleService } from './role.service';

/**
 * Role management endpoints. Guard chain per route: JWT ->
 * TenantResolutionGuard -> PermissionsGuard. Authorization is enforced inside
 * RoleService via PermissionService (tenant-scoped), so the controller only
 * wires authentication + tenant resolution.
 */
@ApiTags('rbac')
@Controller('rbac/roles')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Post()
  @ApiOperation({ summary: 'Create a custom role' })
  create(
    @CurrentUser() user: JwtUser,
    @Body() dto: CreateRoleDto,
  ): Promise<{ id: string; key: string; name: string }> {
    return this.roleService.createRole(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List roles in the tenant' })
  list(@CurrentUser() user: JwtUser): Promise<
    Array<{
      id: string;
      key: string;
      name: string;
      description: string | null;
      isSystem: boolean;
      permissionCount: number;
    }>
  > {
    return this.roleService.listRoles(user.userId);
  }

  @Get(':roleId')
  @ApiOperation({ summary: 'Get a role with its permissions' })
  get(
    @CurrentUser() user: JwtUser,
    @Param('roleId') roleId: string,
  ): Promise<{
    id: string;
    key: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    permissions: Array<{ id: string; key: string; name: string }>;
  }> {
    return this.roleService.getRole(user.userId, roleId);
  }

  @Put(':roleId')
  @ApiOperation({ summary: 'Update a custom role name/description' })
  update(
    @CurrentUser() user: JwtUser,
    @Param('roleId') roleId: string,
    @Body() dto: UpdateRoleDto,
  ): Promise<{
    id: string;
    key: string;
    name: string;
    description: string | null;
  }> {
    return this.roleService.updateRole(user.userId, roleId, dto);
  }

  @Delete(':roleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a custom role' })
  async remove(
    @CurrentUser() user: JwtUser,
    @Param('roleId') roleId: string,
  ): Promise<void> {
    await this.roleService.deleteRole(user.userId, roleId);
  }

  @Put(':roleId/permissions')
  @ApiOperation({ summary: 'Replace a role permission grants' })
  assignPermissions(
    @CurrentUser() user: JwtUser,
    @Param('roleId') roleId: string,
    @Body() dto: AssignRolePermissionsDto,
  ): Promise<{ id: string; permissionCount: number }> {
    return this.roleService.assignPermissions(user.userId, roleId, dto);
  }

  @Put('memberships/:membershipId/role')
  @ApiOperation({ summary: 'Assign a role to a membership' })
  assignRoleToMembership(
    @CurrentUser() user: JwtUser,
    @Param('membershipId') membershipId: string,
    @Body() dto: AssignRoleToMembershipDto,
  ): Promise<{ id: string; roleId: string }> {
    return this.roleService.assignRoleToMembership(user.userId, {
      ...dto,
      membershipId,
    });
  }
}
