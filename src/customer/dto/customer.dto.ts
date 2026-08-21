import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { CustomerStatus } from '@prisma/client';
import { PageQueryDto } from '../../common/pagination/pagination-query.dto';

/**
 * Customer (rental counterparty) create/update payloads. `id`, `tenantId`,
 * `createdAt`, `updatedAt` are deliberately NOT part of these DTOs: the tenant
 * identity always comes from the server-derived TenantContext and is injected
 * by the Prisma tenant-scoping extension, so a client-supplied tenantId/id is
 * rejected with 400 by the ValidationPipe (whitelist + forbidNonWhitelisted).
 */
export class CreateCustomerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;
}

export class UpdateCustomerDto {
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
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;
}

/**
 * Customer list query (Phase 2J approved filter set): status equality filter
 * plus the shared pagination base (limit/cursor/order). Unknown query fields
 * are rejected 400 by forbidNonWhitelisted.
 */
export class CustomerListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;
}
