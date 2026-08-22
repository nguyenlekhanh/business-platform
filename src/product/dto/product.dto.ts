import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ProductStatus } from '@prisma/client';
import { PageQueryDto } from '../../common/pagination/pagination-query.dto';

/**
 * Product (catalog item) create/update payloads. `id` and `tenantId` are
 * deliberately NOT part of these DTOs: the tenant identity always comes from
 * the server-derived TenantContext (the Prisma extension injects it), so a
 * client-supplied tenantId/id is rejected with 400 by the ValidationPipe
 * (whitelist + forbidNonWhitelisted). The status field is validated against
 * the Prisma enum (PATCH carries the archive flow); categoryId is an opaque
 * string resolved server-side.
 */
export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code!: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}

export class UpdateProductDto {
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
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}

/**
 * Product list query (Phase 3 approved filter set): status + categoryId
 * equality filters plus the shared pagination base (limit/cursor/order).
 * Unknown query fields are rejected 400 by forbidNonWhitelisted.
 */
export class ProductListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @IsString()
  categoryId?: string;
}
