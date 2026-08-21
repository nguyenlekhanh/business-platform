import {
  IsISO8601,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ReservationStatus } from '@prisma/client';
import { PageQueryDto } from '../../common/pagination/pagination-query.dto';

/**
 * Reservation create/update payloads. `id`, `tenantId`, `status`,
 * `createdAt`, `updatedAt` are deliberately NOT part of these DTOs:
 * - the tenant identity always comes from the server-derived TenantContext and
 *   is injected by the Prisma tenant-scoping extension,
 * - `status` is fully server-controlled (create -> RESERVED, DELETE ->
 *   CANCELLED); clients cannot set or transition it,
 * - `customerId`/`equipmentId` are immutable after creation (re-booking is a
 *   cancel + recreate operation).
 * A client-supplied tenantId/id/status is rejected with 400 by the
 * ValidationPipe (whitelist + forbidNonWhitelisted). Timestamps are ISO-8601
 * strings; the service parses them into UTC Date instants.
 */
export class CreateReservationDto {
  @IsString()
  @IsNotEmpty()
  customerId!: string;

  @IsString()
  @IsNotEmpty()
  equipmentId!: string;

  @IsISO8601()
  startAt!: string;

  @IsISO8601()
  endAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateReservationDto {
  @IsOptional()
  @IsISO8601()
  startAt?: string;

  @IsOptional()
  @IsISO8601()
  endAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/**
 * Reservation list query (Phase 2J approved filter set). Extends the shared
 * pagination base (limit/cursor/order). Approved filters only:
 * - status: single enum equality,
 * - customerId/equipmentId: exact-match equality; unknown or foreign ids
 *   simply yield an empty page (never a 404 - no existence oracle),
 * - from/to: OVERLAP semantics - reservations intersecting [from, to)
 *   (`startAt < to AND endAt > from`); `from < to` is enforced by the
 *   service with 400 when both are supplied,
 * - sortBy: allow-listed primary sort; the id tiebreaker follows `order`.
 * Unknown query fields are rejected 400 by forbidNonWhitelisted.
 */
export class ReservationListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(ReservationStatus)
  status?: ReservationStatus;

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  equipmentId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsIn(['createdAt', 'startAt'])
  sortBy?: 'createdAt' | 'startAt';
}
