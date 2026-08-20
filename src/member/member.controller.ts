import {
  Body,
  Controller,
  Get,
  Param,
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
import { UpdateMemberStatusDto } from './dto/member.dto';
import { MemberService, MemberSummary } from './member.service';

/**
 * Membership administration endpoints. Guard chain per route: JWT ->
 * TenantResolutionGuard -> PermissionsGuard. Authorization is enforced inside
 * MemberService via PermissionService (tenant-scoped), so the controller only
 * wires authentication + tenant resolution.
 */
@ApiTags('members')
@Controller('members')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class MemberController {
  constructor(private readonly memberService: MemberService) {}

  @Get()
  @ApiOperation({ summary: 'List members of the tenant' })
  list(@CurrentUser() user: JwtUser): Promise<MemberSummary[]> {
    return this.memberService.listMembers(user.userId);
  }

  @Get(':userId')
  @ApiOperation({ summary: 'Get a single member by user id' })
  get(
    @CurrentUser() user: JwtUser,
    @Param('userId') userId: string,
  ): Promise<MemberSummary> {
    return this.memberService.getMember(user.userId, userId);
  }

  @Put(':membershipId/status')
  @ApiOperation({ summary: 'Update a membership status (ACTIVE/SUSPENDED)' })
  updateStatus(
    @CurrentUser() user: JwtUser,
    @Param('membershipId') membershipId: string,
    @Body() dto: UpdateMemberStatusDto,
  ): Promise<MemberSummary> {
    return this.memberService.updateMemberStatus(
      user.userId,
      membershipId,
      dto,
    );
  }
}
