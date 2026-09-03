import {
  Body,
  Controller,
  Get,
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
import { Paginated } from '../common/pagination/paginate';
import { TenantContextInterceptor } from '../tenant/tenant-context.interceptor';
import { TenantResolutionGuard } from '../tenant/tenant-resolution.guard';
import {
  RequireAnyPermission,
  RequirePermission,
} from '../rbac/permission.decorator';
import { PERMISSIONS } from '../rbac/permission-catalog';
import { PermissionsGuard } from '../rbac/permissions.guard';
import {
  BookingListQueryDto,
  CreateBookingDto,
  UpdateBookingDto,
} from './dto/booking.dto';
import { BookingService, BookingSummary } from './booking.service';

/**
 * Service booking endpoints — Phase 5 P5-U4 (Architecture A: Service-Catalog Booking).
 *
 * PATCH is used for partial updates (the Phase 3+ convention on new
 * domains, approved D2). Guard chain per route: JWT (global) ->
 * TenantResolutionGuard -> PermissionsGuard; authorization is enforced by
 * PermissionsGuard from the @RequirePermission / @RequireAnyPermission
 * metadata. There is NO tenantId parameter anywhere: the tenant is always
 * the one resolved from the X-Tenant-ID header into the TenantContext.
 *
 * Deliberately NO delete route: the approved scope has no deletion
 * semantics; the omission is deliberate and REPORTED (soft retirement via
 * PATCH status=CANCELLED is the established convention; a future resource
 * FK will govern deletion the way Product's does for Category).
 *
 * Approved B1/B11/B13/B14 mapping on the three keys:
 *   GET    -> booking:read
 *   POST   -> booking:create OR booking:manage
 *   PATCH  -> booking:manage
 */
@ApiTags('bookings')
@Controller('bookings')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Get()
  @RequirePermission(PERMISSIONS.BOOKING_READ)
  @ApiOperation({ summary: 'List bookings in the tenant (paginated)' })
  list(
    @Query() query: BookingListQueryDto,
  ): Promise<Paginated<BookingSummary>> {
    return this.bookingService.listBookings(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.BOOKING_READ)
  @ApiOperation({ summary: 'Get a single booking' })
  get(@Param('id') id: string): Promise<BookingSummary> {
    return this.bookingService.getBooking(id);
  }

  @Post()
  @RequireAnyPermission(PERMISSIONS.BOOKING_CREATE, PERMISSIONS.BOOKING_MANAGE)
  @ApiOperation({ summary: 'Create a service booking' })
  create(@Body() dto: CreateBookingDto): Promise<BookingSummary> {
    return this.bookingService.createBooking(dto);
  }

  @Patch(':id')
  @RequireAnyPermission(PERMISSIONS.BOOKING_MANAGE)
  @ApiOperation({ summary: 'Partially update a service booking' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateBookingDto,
  ): Promise<BookingSummary> {
    return this.bookingService.updateBooking(id, dto);
  }
}