import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
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
