import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
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
 * Online POS sale — Phase 4 P4-U2. Creates an Order via the existing Core
 * Commerce T1 (server pricing, guarded stock decrement, snapshots), a
 * Payment via the existing T5, links them to the POS context (session ->
 * device -> store, cashier = session opener), and — for CASH — captures
 * immediately via the existing T2 (cash is captured when tendered, the
 * approved D5 pattern). Non-cash methods leave the Payment PROCESSING for
 * the existing POST /payments/:id/capture flow. customerId is optional
 * (anonymous/walk-in sales are documented Phase 3 behavior: Order.customerId
 * is nullable). status/order/payment/device/store/cashier are never
 * client-writable.
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
}
