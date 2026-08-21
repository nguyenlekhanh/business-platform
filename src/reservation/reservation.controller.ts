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
  Query,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Paginated } from '../common/pagination/paginate';
import { PERMISSIONS } from '../rbac/permission-catalog';
import {
  RequireAnyPermission,
  RequirePermission,
} from '../rbac/permission.decorator';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { TenantContextInterceptor } from '../tenant/tenant-context.interceptor';
import { TenantResolutionGuard } from '../tenant/tenant-resolution.guard';
import { ReservationService, ReservationSummary } from './reservation.service';
import {
  CreateReservationDto,
  ReservationListQueryDto,
  UpdateReservationDto,
} from './dto/reservation.dto';

/**
 * Reservation endpoints. Guard chain per route: JWT -> TenantResolutionGuard
 * -> PermissionsGuard. Authorization is enforced by PermissionsGuard from
 * @RequirePermission / @RequireAnyPermission metadata. There is NO tenantId
 * parameter anywhere: the tenant is always the one resolved from the
 * X-Tenant-ID header into the TenantContext. DELETE is a soft cancel.
 */
@ApiTags('reservations')
@Controller('reservations')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class ReservationController {
  constructor(private readonly reservationService: ReservationService) {}

  @Get()
  @RequirePermission(PERMISSIONS.RESERVATION_READ)
  @ApiOperation({
    summary: 'List reservations in the tenant (keyset-paginated, filterable)',
  })
  list(
    @Query() query: ReservationListQueryDto,
  ): Promise<Paginated<ReservationSummary>> {
    return this.reservationService.listReservations(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.RESERVATION_READ)
  @ApiOperation({ summary: 'Get a single reservation' })
  get(@Param('id') id: string): Promise<ReservationSummary> {
    return this.reservationService.getReservation(id);
  }

  @Post()
  @RequireAnyPermission(
    PERMISSIONS.RESERVATION_CREATE,
    PERMISSIONS.RESERVATION_MANAGE,
  )
  @ApiOperation({ summary: 'Create a reservation' })
  create(@Body() dto: CreateReservationDto): Promise<ReservationSummary> {
    return this.reservationService.createReservation(dto);
  }

  @Put(':id')
  @RequireAnyPermission(
    PERMISSIONS.RESERVATION_UPDATE,
    PERMISSIONS.RESERVATION_MANAGE,
  )
  @ApiOperation({ summary: 'Update a RESERVED reservation' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateReservationDto,
  ): Promise<ReservationSummary> {
    return this.reservationService.updateReservation(id, dto);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(
    PERMISSIONS.RESERVATION_UPDATE,
    PERMISSIONS.RESERVATION_MANAGE,
  )
  @ApiOperation({
    summary: 'Start a RESERVED reservation (RESERVED -> ACTIVE)',
  })
  start(@Param('id') id: string): Promise<ReservationSummary> {
    return this.reservationService.startReservation(id);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(
    PERMISSIONS.RESERVATION_UPDATE,
    PERMISSIONS.RESERVATION_MANAGE,
  )
  @ApiOperation({
    summary: 'Complete an ACTIVE reservation (ACTIVE -> COMPLETED)',
  })
  complete(@Param('id') id: string): Promise<ReservationSummary> {
    return this.reservationService.completeReservation(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(
    PERMISSIONS.RESERVATION_DELETE,
    PERMISSIONS.RESERVATION_MANAGE,
  )
  @ApiOperation({ summary: 'Cancel a reservation (soft delete)' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.reservationService.deleteReservation(id);
  }
}
