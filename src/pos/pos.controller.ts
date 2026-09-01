import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
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
  CreatePosSaleDto,
  OpenPosSessionDto,
  PosDeviceListQueryDto,
  RecordOfflineSaleIntentDto,
  UpdatePosDeviceDto,
} from './dto/pos.dto';
import {
  PosDeviceRegistrationSummary,
  PosDeviceService,
  PosDeviceSummary,
} from './pos-device.service';
import { PosSessionService, PosSessionSummary } from './pos-session.service';
import { PosSaleService, PosSaleSummary } from './pos-sale.service';
import {
  OfflineOperationSummary,
  PosOperationService,
} from './pos-operation.service';
import { FeedPage, PosSyncService, SyncResult } from './pos-sync.service';

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
    private readonly saleService: PosSaleService,
    private readonly operationService: PosOperationService,
    private readonly syncService: PosSyncService,
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

  // ---- Sales (P4-U2: online POS sale) -----------------------------------

  @Post('sales')
  @RequirePermission(PERMISSIONS.POS_CREATE)
  @ApiOperation({
    summary:
      'Create an online POS sale (Order via Core Commerce T1, Payment via T5; CASH captures via T2)',
  })
  createSale(
    @CurrentUser() user: JwtUser,
    @Body() dto: CreatePosSaleDto,
  ): Promise<PosSaleSummary> {
    return this.saleService.createSale(user.userId, dto);
  }

  @Get('sales/:id')
  @RequirePermission(PERMISSIONS.POS_READ)
  @ApiOperation({ summary: 'Get POS sale by id (provenance view)' })
  getSale(@Param('id') id: string): Promise<PosSaleSummary> {
    return this.saleService.getSale(id);
  }

  @Get('sessions/:id/sales')
  @RequirePermission(PERMISSIONS.POS_READ)
  @ApiOperation({ summary: "List a POS session's sales (shift history)" })
  listSessionSales(@Param('id') id: string): Promise<PosSaleSummary[]> {
    return this.saleService.listSessionSales(id);
  }

  // ---- Offline operations (P4-U4: the durable sync inbox) ---------------

  @Post('offline/operations')
  @RequirePermission(PERMISSIONS.POS_CREATE)
  @ApiOperation({
    summary:
      'Record an offline sale intent (durable, idempotent by device+clientUuid; executes nothing)',
  })
  recordOfflineSaleIntent(
    @CurrentUser() user: JwtUser,
    @Body() dto: RecordOfflineSaleIntentDto,
  ): Promise<OfflineOperationSummary> {
    return this.operationService.recordOfflineSaleIntent(user.userId, dto);
  }

  @Get('offline/operations/:id')
  @RequirePermission(PERMISSIONS.POS_READ)
  @ApiOperation({ summary: 'Get an offline operation by id (inbox view)' })
  getOfflineOperation(
    @Param('id') id: string,
  ): Promise<OfflineOperationSummary> {
    return this.operationService.getOperation(id);
  }

  @Get('offline/devices/:deviceId/operations')
  @RequirePermission(PERMISSIONS.POS_READ)
  @ApiOperation({
    summary: "List a device's offline operations ordered by its seq",
  })
  listDeviceOfflineOperations(
    @Param('deviceId') deviceId: string,
  ): Promise<OfflineOperationSummary[]> {
    return this.operationService.listDeviceOperations(deviceId);
  }

  // ---- Sync (P4-U5: push execution + D8 pull feed) ----------------------

  /**
   * Sync one offline operation (push). Requires BOTH the cashier JWT
   * (guard chain) and the server-issued device credential in the
   * X-POS-Device-Credential header (D6) — verified against the
   * operation's OWN device, constant-time. Authorization is revalidated
   * at sync (D7): the principal must be the recorded cashier holding
   * CURRENT pos:create. The route permission is pos:create; the device
   * credential + ownership checks run in the service.
   */
  @Post('offline/operations/:id/sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.POS_CREATE)
  @ApiOperation({
    summary:
      'Sync an offline operation: revalidate authority, execute via the existing sale engine, persist the durable result',
  })
  syncOfflineOperation(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Headers('X-POS-Device-Credential') deviceCredential?: string,
  ): Promise<SyncResult> {
    return this.syncService.syncOperation(user.userId, id, deviceCredential);
  }

  /**
   * Pull feed (D8): ordered watermark+tombstone entries above the device
   * cursor. `since` is the last delivered feedSeq (0 = from the start).
   */
  @Get('feed')
  @RequirePermission(PERMISSIONS.POS_READ)
  @ApiOperation({
    summary:
      'Pull catalog change feed (version watermark + tombstones) above the cursor',
  })
  pullFeed(
    @Query('since', new ParseIntPipe({ optional: true })) since = 0,
  ): Promise<FeedPage> {
    return this.syncService.pullFeed(since);
  }
}
