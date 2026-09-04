import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { PosDeviceStatus } from '@prisma/client';
import { PageQueryDto } from '../../common/pagination/pagination-query.dto';

/**
 * POS DTOs — Phase 4 P4-U1.
 *
 * A1: pos:create authorizes device registration and session opening;
 * pos:manage authorizes lifecycle transitions and credential rotation.
 * A5: storeId is set ONCE at registration and is never client-writable
 * afterwards; session storeId is derived from the device, never from the
 * client. Status is server-controlled everywhere (whitelist rejects it).
 */

export class CreatePosDeviceDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;
}

export class UpdatePosDeviceDto {
  // A5: store binding is permanent — only `name` is patchable. Status goes
  // through the dedicated lifecycle endpoints (never client-writable here).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;
}

export class PosDeviceListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED', 'RETIRED'])
  status?: PosDeviceStatus;
}

export class OpenPosSessionDto {
  // The session's store is derived from the DEVICE on the server; the
  // client may never assert storeId, tenantId, userId, status, or
  // timestamps (whitelist rejects all of them).
  @IsString()
  @IsNotEmpty()
  deviceId!: string;
}

/**
 * Online POS sale line — Phase 4 P4-U2. The server is the price/stock
 * authority (Phase 3 T1 behavior); the client supplies only the variant and
 * quantity. NOTE: unlike the P4-U4+ offline intent snapshot, an ONLINE sale
 * does NOT carry a device-observed price — pricing is live and authoritative
 * exactly like POST /orders.
 */
export class PosSaleItemDto {
  @IsString()
  @IsNotEmpty()
  variantId!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number;
}

/**
 * Online POS sale — Phase 4 P4-U2 + Phase 5 P5-U5. Creates an Order via the existing Core
 * Commerce T1 (server pricing, guarded stock decrement, snapshots), a
 * Payment via the existing T5, links them to the POS context (session ->
 * device -> store, cashier = session opener), and — for CASH — captures
 * immediately via the existing T2 (cash is captured when tendered, the
 * approved D5 pattern). Non-cash methods leave the Payment PROCESSING for
 * the existing POST /payments/:id/capture flow. customerId is optional
 * (anonymous/walk-in sales are documented Phase 3 behavior: Order.customerId
 * is nullable). status/order/payment/device/store/cashier are never
 * client-writable.
 * bookingId optional (P5-U5): link this POS sale to an existing Booking.
 */
export class CreatePosSaleDto {
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PosSaleItemDto)
  items!: PosSaleItemDto[];

  @IsOptional()
  @IsIn(['CASH', 'CARD'])
  method!: 'CASH' | 'CARD';

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  bookingId?: string;
}

/**
 * Offline sale-intent line — Phase 4 P4-U4. The device reports the variant,
 * quantity, and the price it OBSERVED at sale time (integer minor units,
 * BigInt input validated to Number.MAX_SAFE_INTEGER per the established
 * Price DTO convention). observedUnitAmountMinor is a frozen snapshot used
 * ONLY for D3 PRICE_CHANGED detection at sync — the server is the price
 * authority and never reprices silently.
 */
export class OfflineSaleIntentItemDto {
  @IsString()
  @IsNotEmpty()
  variantId!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  observedUnitAmountMinor!: number;
}

/**
 * Record an offline sale intent — Phase 4 P4-U4 (the durable sync inbox).
 *
 * The device supplies its OUTBOX identity: sessionId (the shift the sale
 * happened in — OPEN or CLOSED historical record; U5 decides acceptability),
 * its client-generated idempotency UUID, its per-device outbox sequence
 * number (> 0, device-assigned), and the frozen intent lines. The server
 * derives tenant from context and device/store/cashier from the session —
 * provenance is NEVER client-writable. Optional customerId (walk-in sales
 * are the documented Phase 3 rule). Recording executes NOTHING (no Order,
 * Payment, Inventory, or Cart mutation — that is P4-U5).
 */
export class RecordOfflineSaleIntentDto {
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @IsUUID()
  clientUuid!: string;

  @IsInt()
  @Min(1)
  seq!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OfflineSaleIntentItemDto)
  items!: OfflineSaleIntentItemDto[];

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  customerId?: string;
}
