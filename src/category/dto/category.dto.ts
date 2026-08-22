import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination-query.dto';

/**
 * Category (product taxonomy) create/update payloads. `id` and `tenantId` are
 * deliberately NOT part of these DTOs: the tenant identity always comes from
 * the server-derived TenantContext (the Prisma extension injects it), so a
 * client-supplied tenantId/id is rejected with 400 by the ValidationPipe
 * (whitelist + forbidNonWhitelisted).
 */
export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

/**
 * Category list query: shared pagination base only (limit/cursor/order).
 * No business filters exist for categories in the approved scope.
 */
export class CategoryListQueryDto extends PageQueryDto {}
