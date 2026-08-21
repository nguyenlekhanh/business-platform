import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { EquipmentType } from '@prisma/client';
import { PageQueryDto } from '../../common/pagination/pagination-query.dto';

/**
 * Equipment (rentable equipment identity) create/update payloads. `id`,
 * `tenantId`, `assetId`-on-update, `createdAt`, `updatedAt` are deliberately
 * NOT part of these DTOs: the tenant identity always comes from the
 * server-derived TenantContext (injected by the Prisma tenant-scoping
 * extension) and the 1:1 Asset link is immutable after creation, so any such
 * client-supplied field is rejected with 400 by the ValidationPipe (whitelist
 * + forbidNonWhitelisted).
 */
export class CreateEquipmentDto {
  @IsString()
  @IsNotEmpty()
  assetId!: string;

  @IsEnum(EquipmentType)
  type!: EquipmentType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  manufacturer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  serialNumber?: string;

  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2999)
  year?: number;
}

export class UpdateEquipmentDto {
  @IsOptional()
  @IsEnum(EquipmentType)
  type?: EquipmentType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  manufacturer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  serialNumber?: string;

  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2999)
  year?: number;
}

/**
 * Equipment list query (Phase 2J approved filter set): type equality filter
 * plus the shared pagination base (limit/cursor/order). Unknown query fields
 * are rejected 400 by forbidNonWhitelisted.
 */
export class EquipmentListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(EquipmentType)
  type?: EquipmentType;
}
