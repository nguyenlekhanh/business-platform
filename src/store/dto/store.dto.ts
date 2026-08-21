import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { StoreStatus, StoreType } from '@prisma/client';
import { PageQueryDto } from '../../common/pagination/pagination-query.dto';

/**
 * Store (generic business unit) create/update payloads. `id` and `tenantId`
 * are deliberately NOT part of these DTOs: the tenant identity always comes
 * from the server-derived TenantContext (the Prisma extension injects it), so
 * a client-supplied tenantId/id is rejected with 400 by the ValidationPipe
 * (whitelist + forbidNonWhitelisted). The type/status fields are validated
 * against the Prisma enums.
 */
export class CreateStoreDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code!: string;

  @IsEnum(StoreType)
  type!: StoreType;

  @IsOptional()
  @IsEnum(StoreStatus)
  status?: StoreStatus;

  @IsOptional()
  @IsObject()
  settings?: unknown;
}

export class UpdateStoreDto {
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
  @IsEnum(StoreType)
  type?: StoreType;

  @IsOptional()
  @IsEnum(StoreStatus)
  status?: StoreStatus;

  @IsOptional()
  @IsObject()
  settings?: unknown;
}

/**
 * Store list query (Phase 2J approved filter set): status + type equality
 * filters plus the shared pagination base (limit/cursor/order). Unknown query
 * fields are rejected 400 by forbidNonWhitelisted.
 */
export class StoreListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(StoreStatus)
  status?: StoreStatus;

  @IsOptional()
  @IsEnum(StoreType)
  type?: StoreType;
}
