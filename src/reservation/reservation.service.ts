import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, Reservation, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { decodeCursor, filterFingerprint } from '../common/pagination/cursor';
import {
  buildKeysetWhere,
  buildOrderBy,
  dateKeyFromCursor,
  encodeRowCursor,
  fetchPage,
  Paginated,
} from '../common/pagination/paginate';
import { DEFAULT_PAGE_SIZE } from '../common/pagination/pagination-query.dto';
import {
  CreateReservationDto,
  ReservationListQueryDto,
  UpdateReservationDto,
} from './dto/reservation.dto';

const RESERVATION_NOT_FOUND = 'Reservation not found';
const CUSTOMER_NOT_FOUND = 'Customer not found';
const EQUIPMENT_NOT_FOUND = 'Equipment not found';
const OVERLAP_CONFLICT =
  'Equipment is already reserved for the selected period';
const NOT_MUTABLE = 'Only reservations in RESERVED status can be updated';
const ALREADY_CANCELLED = 'Reservation is already cancelled';
const INVALID_RANGE = 'startAt must be before endAt';
const NOT_STARTABLE = 'Only reservations in RESERVED status can be started';
const NOT_COMPLETABLE = 'Only reservations in ACTIVE status can be completed';
const NOT_BEFORE_START =
  'Reservation cannot be started before its scheduled start time';
const NOT_BEFORE_END =
  'Reservation cannot be completed before its scheduled end time';
const INVALID_LIST_RANGE = 'from must be before to';

/** Statuses in which a reservation holds the equipment (overlap-relevant). */
const HOLDING_STATUSES: ReservationStatus[] = ['RESERVED', 'ACTIVE'];

/**
 * Safe reservation projection: all scalar fields and no relation traversal.
 */
export interface ReservationSummary {
  id: string;
  tenantId: string;
  customerId: string;
  equipmentId: string;
  startAt: Date;
  endAt: Date;
  status: ReservationStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Reservation (time-bound hold on rentable equipment) administration.
 *
 * SECURITY CONTRACT (mirrors CustomerService):
 * - Tenant identity is ALWAYS server-derived via TenantContext.requireTenantId()
 *   and fails closed when the context is missing. tenantId is never a method
 *   parameter or client input; create passes only the context-derived id,
 *   which the centralized extension enforces on every write.
 * - Reservation is a tenant-scoped model in the centralized Prisma extension,
 *   so every top-level read/write is automatically scoped; a reservation id
 *   from another tenant resolves to null (404).
 * - customerId/equipmentId are resolved through tenant-scoped lookups BEFORE
 *   any write: unknown or cross-tenant references resolve to null -> 404 (no
 *   existence leak). Both links are immutable after creation.
 * - Time semantics: half-open [startAt, endAt) UTC intervals; ISO-8601 in,
 *   Date instants stored; startAt must be strictly before endAt.
 * - Overlap protection is TWO-layered: (1) an application pre-check returns a
 *   friendly 409, and (2) the authoritative guarantee is the PostgreSQL
 *   btree_gist EXCLUDE constraint (migration 20260821020000) which makes
 *   concurrent double-bookings impossible; SQLSTATE 23P01 maps to 409.
 * - Lifecycle: create -> RESERVED; start -> ACTIVE (only at/after startAt);
 *   complete -> COMPLETED (only at/after endAt); DELETE is a soft cancel ->
 *   CANCELLED; only RESERVED rows are mutable via PUT; CANCELLED rows are
 *   immutable; transitions reject any other source status or premature
 *   timing with 409.
 */
@Injectable()
export class ReservationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Paginated, filtered reservation list (Phase 2J contract).
   *
   * - Keyset pagination over (sortBy, id), default sortBy=createdAt asc
   *   (preserves the historical ordering). take = limit + 1 detects the next
   *   page; the probe row is trimmed before mapping.
   * - Approved filters: status/customerId/equipmentId equality; from/to with
   *   OVERLAP semantics (`startAt < to AND endAt > from`, half-open, mirrors
   *   the EXCLUDE constraint); from < to enforced (400).
   * - The cursor fingerprint covers the normalized filter set, so reusing a
   *   cursor with different filters/sort/direction is rejected 400.
   * - Tenant scoping stays centralized: the extension merges tenantId into
   *   the where clause of this top-level findMany; the cursor never carries
   *   tenantId. Foreign customerId/equipmentId filters simply match nothing.
   */
  async listReservations(
    query: ReservationListQueryDto,
  ): Promise<Paginated<ReservationSummary>> {
    this.assertTenantContext();
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const sortBy = query.sortBy ?? 'createdAt';
    const direction = query.order ?? 'asc';

    // Normalize range filters to canonical instants first; the same values
    // feed both the query predicate and the cursor fingerprint.
    const from =
      query.from !== undefined ? this.parseInstant(query.from) : undefined;
    const to = query.to !== undefined ? this.parseInstant(query.to) : undefined;
    if (from && to && !(from.getTime() < to.getTime())) {
      throw new BadRequestException(INVALID_LIST_RANGE);
    }

    const equality: Record<string, unknown> = {};
    if (query.status !== undefined) {
      equality.status = query.status;
    }
    if (query.customerId !== undefined) {
      equality.customerId = query.customerId;
    }
    if (query.equipmentId !== undefined) {
      equality.equipmentId = query.equipmentId;
    }

    const range: Record<string, unknown> = {};
    if (to !== undefined) {
      range.startAt = { lt: to };
    }
    if (from !== undefined) {
      range.endAt = { gt: from };
    }

    const fingerprint = filterFingerprint({
      ...equality,
      ...(from !== undefined ? { from: from.toISOString() } : {}),
      ...(to !== undefined ? { to: to.toISOString() } : {}),
    });

    const continuation =
      query.cursor !== undefined
        ? decodeCursor(query.cursor, { sortBy, direction, fingerprint })
        : undefined;

    const predicates: Record<string, unknown>[] = [];
    if (Object.keys(equality).length > 0) {
      predicates.push(equality);
    }
    if (Object.keys(range).length > 0) {
      predicates.push(range);
    }
    if (continuation !== undefined) {
      // Both reservation sort columns are DateTime: convert the cursor's
      // epoch-millis key back to a Date instant (400 on garbage).
      predicates.push(
        buildKeysetWhere(
          sortBy,
          dateKeyFromCursor(continuation.primaryValue),
          continuation.idValue,
          direction,
        ),
      );
    }
    const where = (
      predicates.length > 0 ? { AND: predicates } : {}
    ) as Prisma.ReservationWhereInput;

    const page = await fetchPage(
      async () =>
        (await this.prisma.reservation.findMany({
          where,
          orderBy: buildOrderBy(sortBy, direction),
          take: limit + 1,
        })) as unknown as Array<Record<string, unknown>>,
      limit,
      encodeRowCursor,
      sortBy,
      direction,
      fingerprint,
    );
    return {
      data: page.data.map((row) =>
        this.toSummary(row as unknown as Reservation),
      ),
      meta: page.meta,
    };
  }

  async getReservation(id: string): Promise<ReservationSummary> {
    this.assertTenantContext();
    const reservation = await this.findReservation(id);
    if (!reservation) {
      throw new NotFoundException(RESERVATION_NOT_FOUND);
    }
    return this.toSummary(reservation);
  }

  async createReservation(
    dto: CreateReservationDto,
  ): Promise<ReservationSummary> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.resolveCustomerId(dto.customerId);
    await this.resolveEquipmentId(dto.equipmentId);
    const startAt = this.parseInstant(dto.startAt);
    const endAt = this.parseInstant(dto.endAt);
    this.assertPositiveRange(startAt, endAt);
    await this.assertNoOverlap(dto.equipmentId, startAt, endAt);
    try {
      const reservation = await this.prisma.reservation.create({
        data: {
          tenantId,
          customerId: dto.customerId,
          equipmentId: dto.equipmentId,
          startAt,
          endAt,
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
      });
      return this.toSummary(reservation);
    } catch (error) {
      if (this.isExclusionViolation(error)) {
        throw new ConflictException(OVERLAP_CONFLICT);
      }
      throw error;
    }
  }

  async updateReservation(
    id: string,
    dto: UpdateReservationDto,
  ): Promise<ReservationSummary> {
    this.assertTenantContext();
    const reservation = await this.findReservation(id);
    if (!reservation) {
      throw new NotFoundException(RESERVATION_NOT_FOUND);
    }
    if (reservation.status !== 'RESERVED') {
      throw new ConflictException(NOT_MUTABLE);
    }
    // Partial time updates merge with the stored values so the effective
    // interval is always validated as a whole.
    const startAt =
      dto.startAt !== undefined
        ? this.parseInstant(dto.startAt)
        : reservation.startAt;
    const endAt =
      dto.endAt !== undefined
        ? this.parseInstant(dto.endAt)
        : reservation.endAt;
    this.assertPositiveRange(startAt, endAt);
    if (dto.startAt !== undefined || dto.endAt !== undefined) {
      await this.assertNoOverlap(reservation.equipmentId, startAt, endAt, id);
    }
    try {
      const updated = await this.prisma.reservation.update({
        where: { id },
        data: {
          ...(dto.startAt !== undefined ? { startAt } : {}),
          ...(dto.endAt !== undefined ? { endAt } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
      });
      return this.toSummary(updated);
    } catch (error) {
      if (this.isExclusionViolation(error)) {
        throw new ConflictException(OVERLAP_CONFLICT);
      }
      throw error;
    }
  }

  /**
   * Lifecycle transition RESERVED -> ACTIVE. The window is already held, so
   * no overlap re-check is needed. Clock-aware: starting requires the window
   * to be open (now >= startAt).
   */
  async startReservation(id: string): Promise<ReservationSummary> {
    return this.transition(id, 'RESERVED', 'ACTIVE', NOT_STARTABLE, {
      field: 'startAt',
      message: NOT_BEFORE_START,
    });
  }

  /**
   * Lifecycle transition ACTIVE -> COMPLETED. COMPLETED does not hold the
   * equipment (excluded from the EXCLUDE constraint), so the slot frees up.
   * Clock-aware: completing requires the window to have closed
   * (now >= endAt; half-open [startAt, endAt)).
   */
  async completeReservation(id: string): Promise<ReservationSummary> {
    return this.transition(id, 'ACTIVE', 'COMPLETED', NOT_COMPLETABLE, {
      field: 'endAt',
      message: NOT_BEFORE_END,
    });
  }

  /**
   * Soft cancel: the row is retained as a business record and its slot becomes
   * bookable again (CANCELLED does not hold the equipment). Cancelling an
   * already-cancelled reservation conflicts.
   */
  async deleteReservation(id: string): Promise<{ id: string }> {
    this.assertTenantContext();
    const reservation = await this.findReservation(id);
    if (!reservation) {
      throw new NotFoundException(RESERVATION_NOT_FOUND);
    }
    if (reservation.status === 'CANCELLED') {
      throw new ConflictException(ALREADY_CANCELLED);
    }
    await this.prisma.reservation.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
    return { id };
  }

  /** Parses a validated ISO-8601 string into a concrete UTC instant. */
  private parseInstant(value: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid ISO-8601 timestamp');
    }
    return date;
  }

  /** Half-open [startAt, endAt) semantics require a strictly positive duration. */
  private assertPositiveRange(startAt: Date, endAt: Date): void {
    if (!(startAt.getTime() < endAt.getTime())) {
      throw new BadRequestException(INVALID_RANGE);
    }
  }

  /** Application overlap pre-check (friendly 409). The PostgreSQL EXCLUDE
   *  constraint remains the authoritative race-safe guarantee. The query is
   *  top-level on a tenant-scoped model, so the extension merges tenantId into
   *  the where clause. */
  private async assertNoOverlap(
    equipmentId: string,
    startAt: Date,
    endAt: Date,
    excludeId?: string,
  ): Promise<void> {
    const overlapping = await this.prisma.reservation.findFirst({
      where: {
        equipmentId,
        status: { in: HOLDING_STATUSES },
        // half-open interval intersection: existing.start < requested.end AND
        // existing.end > requested.start
        startAt: { lt: endAt },
        endAt: { gt: startAt },
        ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (overlapping) {
      throw new ConflictException(OVERLAP_CONFLICT);
    }
  }

  /** Tenant-scoped customer resolution: cross-tenant or unknown -> 404. */
  private async resolveCustomerId(customerId: string): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) {
      throw new NotFoundException(CUSTOMER_NOT_FOUND);
    }
  }

  /** Tenant-scoped equipment resolution: cross-tenant or unknown -> 404. */
  private async resolveEquipmentId(equipmentId: string): Promise<void> {
    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true },
    });
    if (!equipment) {
      throw new NotFoundException(EQUIPMENT_NOT_FOUND);
    }
  }

  /** Tenant-scoped reservation lookup. The extension merges tenantId into the
   *  where clause, so a reservation id from another tenant resolves to null. */
  private findReservation(id: string): Promise<Reservation | null> {
    return this.prisma.reservation.findUnique({ where: { id } });
  }

  /** Strict lifecycle state machine: only `fromStatus` rows may move to
   *  `toStatus`; anything else (including CANCELLED/COMPLETED) conflicts.
   *  When `timeGate` is provided, the transition additionally requires
   *  now >= reservation[timeGate.field] (equality allowed; half-open windows).
   *  Cross-tenant or unknown ids resolve to null -> 404. */
  private async transition(
    id: string,
    fromStatus: ReservationStatus,
    toStatus: ReservationStatus,
    conflictMessage: string,
    timeGate?: { field: 'startAt' | 'endAt'; message: string },
  ): Promise<ReservationSummary> {
    this.assertTenantContext();
    const reservation = await this.findReservation(id);
    if (!reservation) {
      throw new NotFoundException(RESERVATION_NOT_FOUND);
    }
    if (reservation.status !== fromStatus) {
      throw new ConflictException(conflictMessage);
    }
    if (timeGate && reservation[timeGate.field].getTime() > Date.now()) {
      throw new ConflictException(timeGate.message);
    }
    const updated = await this.prisma.reservation.update({
      where: { id },
      data: { status: toStatus },
    });
    return this.toSummary(updated);
  }

  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }

  private toSummary(reservation: Reservation): ReservationSummary {
    return {
      id: reservation.id,
      tenantId: reservation.tenantId,
      customerId: reservation.customerId,
      equipmentId: reservation.equipmentId,
      startAt: reservation.startAt,
      endAt: reservation.endAt,
      status: reservation.status,
      notes: reservation.notes,
      createdAt: reservation.createdAt,
      updatedAt: reservation.updatedAt,
    };
  }

  /** Detects PostgreSQL exclusion-constraint violations (SQLSTATE 23P01).
   *  Prisma surfaces these as unknown-request errors rather than P2002, so
   *  both the error code and the embedded database message are checked. */
  private isExclusionViolation(error: unknown): boolean {
    const candidate = error as { code?: unknown; message?: unknown } | null;
    if (candidate === null || candidate === undefined) {
      return false;
    }
    if (typeof candidate.code === 'string' && candidate.code === '23P01') {
      return true;
    }
    return (
      typeof candidate.message === 'string' &&
      candidate.message.includes('23P01')
    );
  }
}
