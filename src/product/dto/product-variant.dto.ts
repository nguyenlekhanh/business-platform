import { VariantStatus } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination-query.dto';

/**
 * ProductVariant / Price payloads (Phase 3 U3). `id` and `tenantId` are
 * deliberately NOT part of these DTOs: tenant identity always comes from the
 * server-derived TenantContext (the Prisma extension injects it), so a
 * client-supplied tenantId/id is rejected with 400 by the ValidationPipe
 * (whitelist + forbidNonWhitelisted). Variant status mirrors the product
 * archive flow (approved D2 PATCH semantics). No new permission keys were
 * created for variants/prices: they are product internals protected by the
 * existing product:* five-key pattern (approved assessment section 10).
 */
export class CreateProductVariantDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  sku!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsEnum(VariantStatus)
  status?: VariantStatus;
}

export class UpdateProductVariantDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  sku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsEnum(VariantStatus)
  status?: VariantStatus;
}

/**
 * No domain filters are approved for the variant list (it is always scoped
 * to one parent product via the URL); only the shared pagination base.
 */
export class ProductVariantListQueryDto extends PageQueryDto {}

/**
 * Upsert payload for the CURRENT price of a variant in ONE currency
 * (PUT /variants/:id/price). Currency must be uppercase ISO-4217 alpha-3
 * (no server-side normalization: 'usd' is rejected, not coerced).
 * amountMinor arrives as a JSON integer number and must stay within the
 * safe integer range; storage/exactness remain BIGINT server-side.
 */
export class PutPriceDto {
  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency must be an uppercase ISO-4217 alpha-3 code',
  })
  currency!: string;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  amountMinor!: number;
}
