import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantContextInterceptor } from '../tenant/tenant-context.interceptor';
import { TenantResolutionGuard } from '../tenant/tenant-resolution.guard';
import { RequirePermission } from '../rbac/permission.decorator';
import { PERMISSIONS } from '../rbac/permission-catalog';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { Paginated } from '../common/pagination/paginate';
import {
  CreatePosDeviceDto,
  OpenPosSessionDto,
  PosDeviceListQueryDto,
  UpdatePosDeviceDto,
} from './dto/pos.dto';
import {
  PosDeviceRegistrationSummary,
  PosDeviceService,
  PosDeviceSummary,
} from './pos-device.service';
import { PosSessionService, PosSessionSummary } from './pos-session.service';

/**
 * POS foundation endpoints — Phase 4 P4-U1.
 *
 * RBAC (A1):
 *   pos:read   -> list/get devices, get sessions
 *   pos:create -> register device, open session
 *   pos:manage -> patch name, suspend/resume/retire, rotate credential,
 *                 close session
 * Guard chain and validation conventions are identical to
 * PaymentController (U7 CP6). The plaintext device credential appears
 * ONLY in the register/rotate responses (A2).
 */
@ApiTags('pos')
@Controller('pos')
@UseGuards(JwtAuthGuard, TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class PosController {
  constructor(
    private readonly deviceService: PosDeviceService,
    private readonly sessionService: PosSessionService,
  ) {}

  // ---- Devices ---------------------------------------------------------

  @Post('devices')
  @RequirePermission(PERMISSIONS.POS_CREATE)
  @ApiOperation({ summary: 'Register a POS device (credential returned once)' })
  registerDevice(
    @Body() dto: CreatePosDeviceDto,
  ): Promise<PosDeviceRegistrationSummary> {
    return this.deviceService.registerDevice(dto);
  }

  @Get('devices')
  @RequirePermission(PERMISSIONS.POS_READ)
  @ApiOperation({ summary: 'List POS devices (paginated, filter status)' })
  listDevices(
    @Query() query: PosDeviceListQueryDto,
  ): Promise<Paginated<PosDeviceSummary>> {
    return this.deviceService.listDevices(query);
  }

  @Get('devices/:id')
  @RequirePermission(PERMISSIONS.POS_READ)
  @ApiOperation({ summary: 'Get POS device by id' })
  getDevice(@Param('id') id: string): Promise<PosDeviceSummary> {
    return this.deviceService.getDevice(id);
  }

  @Patch('devices/:id')
  @RequirePermission(PERMISSIONS.POS_MANAGE)
  @ApiOperation({ summary: 'Rename a POS device (store binding permanent)' })
  updateDevice(
    @Param('id') id: string,
    @Body() dto: UpdatePosDeviceDto,
  ): Promise<PosDeviceSummary> {
    return this.deviceService.updateDevice(id, dto);
  }

  @Post('devices/:id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.POS_MANAGE)
  @ApiOperation({ summary: 'Suspend an ACTIVE device (revocation)' })
  suspendDevice(@Param('id') id: string): Promise<PosDeviceSummary> {
    return this.deviceService.transition(id, 'suspend');
  }

  @Post('devices/:id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.POS_MANAGE)
  @ApiOperation({ summary: 'Resume a SUSPENDED device' })
  resumeDevice(@Param('id') id: string): Promise<PosDeviceSummary> {
    return this.deviceService.transition(id, 'resume');
  }

  @Post('devices/:id/retire')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.POS_MANAGE)
  @ApiOperation({ summary: 'Retire a device (terminal; no way back)' })
  retireDevice(@Param('id') id: string): Promise<PosDeviceSummary> {
    return this.deviceService.transition(id, 'retire');
  }

  @Post('devices/:id/rotate-credential')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.POS_MANAGE)
  @ApiOperation({
    summary: 'Rotate the device credential (new secret returned once)',
  })
  rotateCredential(
    @Param('id') id: string,
  ): Promise<PosDeviceRegistrationSummary> {
    return this.deviceService.rotateCredential(id);
  }

  // ---- Sessions ----------------------------------------------------------

  @Post('sessions')
  @RequirePermission(PERMISSIONS.POS_CREATE)
  @ApiOperation({ summary: 'Open a POS session (cashier shift)' })
  openSession(
    @CurrentUser() user: JwtUser,
    @Body() dto: OpenPosSessionDto,
  ): Promise<PosSessionSummary> {
    return this.sessionService.openSession(user.userId, dto);
  }

  @Get('sessions/:id')
  @RequirePermission(PERMISSIONS.POS_READ)
  @ApiOperation({ summary: 'Get POS session by id' })
  getSession(@Param('id') id: string): Promise<PosSessionSummary> {
    return this.sessionService.getSession(id);
  }

  @Post('sessions/:id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.POS_MANAGE)
  @ApiOperation({ summary: 'Close an OPEN POS session' })
  closeSession(@Param('id') id: string): Promise<PosSessionSummary> {
    return this.sessionService.closeSession(id);
  }
}
