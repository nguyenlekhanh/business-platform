import {
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { BookingStatus } from '@prisma/client';
import { PageQueryDto } from '../../common/pagination/pagination-query.dto';

/**
 * Booking payloads — Phase 5 P5-U4 (Service-Catalog Booking, Architecture A).
 *
 * A Booking represents a Service reserved for a time interval (Architecture A:
 * Service-Catalog Booking, approved B1 Option A). It does NOT book staff,
 * providers, or resources. The customer reference is optional/nullable
 * (approved B13 Option B, following the Order walk-in precedent). Cross-store
 * customer references are allowed (approved B14 sub-option i).
 *
 * `id` and `tenantId` are deliberately NOT part of these DTOs: the tenant
 * identity always comes from the server-derived TenantContext (the Prisma
 * extension injects it), so a client-supplied tenantId/id is rejected with 400
 * by the ValidationPipe (whitelist + forbidNonWhitelisted). The status field
 * is validated against the Prisma enum; PATCH carries the lifecycle transitions.
 *
 * NO staffId, resourceId, scheduleId, pricing, or duration fields — all
 * deferred per the approved decision gate.
 */
export class CreateBookingDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  serviceId!: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsISO8601({ strict: true })
  @IsNotEmpty()
  startAt!: string;

  @IsISO8601({ strict: true })
  @IsNotEmpty()
  endAt!: string;

  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;
}

export class UpdateBookingDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  serviceId?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  startAt?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  endAt?: string;

  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;
}

/**
 * Booking list query: shared pagination base + a status equality filter —
 * the ProductListQueryDto shape (the established catalog convention).
 * Unknown query fields are rejected 400 by forbidNonWhitelisted.
 */
export class BookingListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  serviceId?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;
}