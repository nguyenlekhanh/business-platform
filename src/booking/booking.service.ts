import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Booking } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import {
  buildOrderBy,
  encodeRowCursor,
  fetchPage,
  Paginated,
  resolveListContinuation,
} from '../common/pagination/paginate';
import { DEFAULT_PAGE_SIZE } from '../common/pagination/pagination-query.dto';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { OrderService } from '../order/order.service';
import {
  BookingListQueryDto,
  CreateBookingDto,
  UpdateBookingDto,
} from './dto/booking.dto';

const BOOKING_NOT_FOUND = 'Booking not found';
const OVERLAP_ERROR =
  'Another booking for this service overlaps the requested time';
const SERVICE_NOT_FOUND = 'Service not found';
const CUSTOMER_NOT_FOUND = 'Customer not found';
const SERVICE_NOT_ACTIVE = 'Service is not active';

/** Safe booking projection: all scalar fields, no relation traversal. */
export interface BookingSummary {
  id: string;
  tenantId: string;
  serviceId: string;
  customerId: string | null;
  orderId: string | null;
  startAt: Date;
  endAt: Date;
  status: Booking['status'];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Service booking administration — Phase 5 P5-U4 (Architecture A: Service-Catalog Booking).
 *
 * The Booking model represents a Service reserved for a time interval
 * (Architecture A, approved B1 Option A): nothing here implements staff,
 * providers, resources, availability slots, calendars, scheduling, pricing,
 * or payment. The unit is deliberately the smallest durable foundation;
 * every future semantic is deferred to explicitly approved units.
 *
 * SECURITY CONTRACT (mirrors CategoryService/ProductService/ServiceService):
 * - The tenant identity is ALWAYS server-derived: each method asserts the
 *   TenantContext (requireTenantId) and fails closed (500) when it is
 *   missing. tenantId is never a method parameter or client input; the
 *   extension injects the context tenant into every create/update.
 * - Booking is a tenant-scoped model in the centralized Prisma extension,
 *   so every top-level read/write is automatically scoped; a booking id
 *   from another tenant resolves to null (uniform 404).
 * - A duplicate (serviceId, overlapping time) surfaces as Prisma P2002/P2003
 *   -> 409 via the EXCLUDE constraint. The DB is the final authority.
 * - No raw SQL, no nested writes, no relation traversal.
 *
 * CRUD SEMANTICS (the established catalog pattern — Product, not Category):
 * - status: BOOKED default on create; PATCH carries the lifecycle transitions
 *   (BOOKED -> CONFIRMED -> ACTIVE -> COMPLETED, CANCELLED, NO_SHOW).
 * - NO delete endpoint: the approved scope has no deletion semantics; a
 *   future resource FK will RESTRICT deletion the way Product's does for
 *   Category.
 */
@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly orderService: OrderService,
  ) {}

  /**
   * Paginated booking list (established catalog contract): keyset over
   * (startAt, id) with the shared envelope + status/serviceId/customerId
   * equality filters. Tenant scoping stays centralized in the Prisma extension.
   */
  async listBookings(
    query: BookingListQueryDto,
  ): Promise<Paginated<BookingSummary>> {
    this.assertTenantContext();
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const direction = query.order ?? 'asc';

    const equality: Record<string, unknown> = {};
    if (query.status !== undefined) {
      equality.status = query.status;
    }
    if (query.serviceId !== undefined) {
      equality.serviceId = query.serviceId;
    }
    if (query.customerId !== undefined) {
      equality.customerId = query.customerId;
    }

    const { fingerprint, keyset } = resolveListContinuation({
      cursor: query.cursor,
      sortBy: 'startAt',
      direction,
      equality,
    });

    const predicates: Record<string, unknown>[] = [];
    if (Object.keys(equality).length > 0) {
      predicates.push(equality);
    }
    if (keyset !== undefined) {
      predicates.push(keyset);
    }
    const where = (
      predicates.length > 0 ? { AND: predicates } : {}
    ) as Prisma.BookingWhereInput;

    const page = await fetchPage(
      async () =>
        (await this.prisma.booking.findMany({
          where,
          orderBy: buildOrderBy('startAt', direction),
          take: limit + 1,
        })) as unknown as Array<Record<string, unknown>>,
      limit,
      encodeRowCursor,
      'startAt',
      direction,
      fingerprint,
    );
    return {
      data: page.data.map((row) => this.toSummary(row as unknown as Booking)),
      meta: page.meta,
    };
  }

  async getBooking(bookingId: string): Promise<BookingSummary> {
    this.assertTenantContext();
    const booking = await this.findBooking(bookingId);
    if (!booking) {
      throw new NotFoundException(BOOKING_NOT_FOUND);
    }
    return this.toSummary(booking);
  }

  async createBooking(dto: CreateBookingDto): Promise<BookingSummary> {
    // The tenant identity comes ONLY from the TenantContext: server-derived
    // and never a client parameter. The extension additionally forces this
    // tenantId into the create, so it can never be overridden.
    const tenantId = this.tenantContext.requireTenantId();

    // Validate service exists and is ACTIVE (tenant-scoped lookup via extension)
    const service = await this.prisma.service.findUnique({
      where: { id: dto.serviceId },
    });
    if (!service) {
      throw new NotFoundException(SERVICE_NOT_FOUND);
    }
    if (service.status !== 'ACTIVE') {
      throw new ConflictException(SERVICE_NOT_ACTIVE);
    }

    // Validate customer exists if provided (tenant-scoped lookup via extension)
    if (dto.customerId) {
      const customer = await this.prisma.customer.findUnique({
        where: { id: dto.customerId },
      });
      if (!customer) {
        throw new NotFoundException(CUSTOMER_NOT_FOUND);
      }
    }

    try {
      const booking = await this.prisma.booking.create({
        data: {
          tenantId,
          serviceId: dto.serviceId,
          ...(dto.customerId !== undefined
            ? { customerId: dto.customerId }
            : {}),
          startAt: new Date(dto.startAt),
          endAt: new Date(dto.endAt),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
      return this.toSummary(booking);
    } catch (error) {
      if (this.isConflictError(error)) {
        throw new ConflictException(OVERLAP_ERROR);
      }
      if (this.isCheckConstraintViolation(error)) {
        throw new BadRequestException('End time must be after start time');
      }
      throw error;
    }
  }

  async updateBooking(
    bookingId: string,
    dto: UpdateBookingDto,
  ): Promise<BookingSummary> {
    this.assertTenantContext();
    const booking = await this.findBooking(bookingId);
    if (!booking) {
      throw new NotFoundException(BOOKING_NOT_FOUND);
    }

    // Validate service exists and is ACTIVE if changing
    if (dto.serviceId && dto.serviceId !== booking.serviceId) {
      const service = await this.prisma.service.findUnique({
        where: { id: dto.serviceId },
      });
      if (!service) {
        throw new NotFoundException(SERVICE_NOT_FOUND);
      }
      if (service.status !== 'ACTIVE') {
        throw new ConflictException(SERVICE_NOT_ACTIVE);
      }
    }

    // Validate customer exists if provided
    if (dto.customerId && dto.customerId !== booking.customerId) {
      const customer = await this.prisma.customer.findUnique({
        where: { id: dto.customerId },
      });
      if (!customer) {
        throw new NotFoundException(CUSTOMER_NOT_FOUND);
      }
    }

    // The tenant is NEVER written here: the extension scopes the update to
    // the active TenantContext (where: tenantId), so a caller cannot point
    // this at another tenant.
    try {
      const updated = await this.prisma.booking.update({
        where: { id: bookingId },
        data: {
          ...(dto.serviceId !== undefined ? { serviceId: dto.serviceId } : {}),
          ...(dto.customerId !== undefined
            ? { customerId: dto.customerId }
            : {}),
          ...(dto.startAt !== undefined
            ? { startAt: new Date(dto.startAt) }
            : {}),
          ...(dto.endAt !== undefined ? { endAt: new Date(dto.endAt) } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
      return this.toSummary(updated);
    } catch (error) {
      if (this.isConflictError(error)) {
        throw new ConflictException(OVERLAP_ERROR);
      }
      // Log unhandled errors for debugging
      console.error(
        '[BookingService] Unhandled error type:',
        error?.constructor?.name,
      );
      console.error('[BookingService] Unhandled error:', error);
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        console.error(
          '[BookingService] Prisma error code:',
          error.code,
          error.meta,
        );
      } else if (error instanceof Prisma.PrismaClientUnknownRequestError) {
        console.error(
          '[BookingService] Prisma unknown request error:',
          error.message,
        );
      } else if (error instanceof Prisma.PrismaClientValidationError) {
        console.error(
          '[BookingService] Prisma validation error:',
          error.message,
        );
      }
      throw error;
    }
  }

  /**
   * Tenant-scoped booking lookup. The extension merges the active tenantId
   * into the where clause, so a booking id from another tenant resolves to
   * null.
   */
  private findBooking(bookingId: string): Promise<Booking | null> {
    return this.prisma.booking.findUnique({ where: { id: bookingId } });
  }

  /**
   * Defense in depth: the service methods require an active TenantContext
   * even before hitting the Prisma extension. This makes the fail-closed
   * contract explicit at the service boundary (and unit-testable without
   * the extension).
   */
  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }

  private toSummary(booking: Booking): BookingSummary {
    return {
      id: booking.id,
      tenantId: booking.tenantId,
      serviceId: booking.serviceId,
      customerId: booking.customerId,
      orderId: booking.orderId,
      startAt: booking.startAt,
      endAt: booking.endAt,
      status: booking.status,
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
    };
  }

  private isConflictError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return (
        error.code === 'P2002' ||
        error.code === 'P2003' ||
        error.code === 'P2004'
      );
    }
    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes('exclusion_violation') ||
        msg.includes('exclusion constraint')
      );
    }
    if (error instanceof Prisma.PrismaClientValidationError) {
      return true;
    }
    return false;
  }

  private isCheckConstraintViolation(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes('check constraint') ||
        msg.includes('check_violation') ||
        msg.includes('23514')
      );
    }
    return false;
  }
}
