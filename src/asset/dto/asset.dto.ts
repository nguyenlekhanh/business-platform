import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { AssetStatus } from '@prisma/client';
import { PageQueryDto } from '../../common/pagination/pagination-query.dto';

/**
 * Asset (generic equipment/resource) create/update payloads. `id`, `tenantId`,
 * `createdAt`, `updatedAt` are deliberately NOT part of these DTOs: the tenant
 * identity always comes from the server-derived TenantContext and is injected by
 * the Prisma tenant-scoping extension, so a client-supplied tenantId/id is
 * rejected with 400 by the ValidationPipe (whitelist + forbidNonWhitelisted).
 * The `type` field is a free-form string so any vertical (crane, vehicle,
 * terminal, ...) can be represented without schema changes.
 */
export class CreateAssetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  type!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsEnum(AssetStatus)
  status?: AssetStatus;

  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsObject()
  settings?: unknown;
}

export class UpdateAssetDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsEnum(AssetStatus)
  status?: AssetStatus;

  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsObject()
  settings?: unknown;
}

/**
 * Asset list query (Phase 2J approved filter set): type/status/storeId
 * equality filters plus the shared pagination base (limit/cursor/order).
 * Unknown query fields are rejected 400 by forbidNonWhitelisted. Foreign
 * storeId values simply match nothing - never an existence oracle.
 */
export class AssetListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsEnum(AssetStatus)
  status?: AssetStatus;

  @IsOptional()
  @IsString()
  storeId?: string;
}
