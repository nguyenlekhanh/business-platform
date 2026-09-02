import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ServiceStatus } from '@prisma/client';
import { PageQueryDto } from '../../common/pagination/pagination-query.dto';

/**
 * Service catalog payloads — Phase 5 P5-U1.
 *
 * A Service is a tenant-owned catalog definition ONLY (approved B2): it is
 * not a booking, appointment, occurrence, staff/resource assignment,
 * availability slot, payment, or Order. `id` and `tenantId` are deliberately
 * NOT part of these DTOs: the tenant identity always comes from the
 * server-derived TenantContext (the Prisma extension injects it), so a
 * client-supplied tenantId/id is rejected with 400 by the ValidationPipe
 * (whitelist + forbidNonWhitelisted). The status field is validated against
 * the Prisma enum (PATCH carries the archive flow — the ProductStatus
 * catalog convention). There are deliberately NO pricing fields (approved
 * B23 deferral), NO duration fields (approved B5 deferral), and NO
 * staff/resource/availability fields (approved B1 non-preclusion).
 */
export class CreateServiceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(ServiceStatus)
  status?: ServiceStatus;
}

export class UpdateServiceDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(ServiceStatus)
  status?: ServiceStatus;
}

/**
 * Service list query: shared pagination base + a status equality filter —
 * exactly the ProductListQueryDto filter shape (the established catalog
 * convention). Unknown query fields are rejected 400 by
 * forbidNonWhitelisted.
 */
export class ServiceListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(ServiceStatus)
  status?: ServiceStatus;
}
