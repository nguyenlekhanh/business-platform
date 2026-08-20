import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Fields a client may update on its own tenant. `id`, `status` and `tenantId`
 * are deliberately NOT part of this DTO: the tenant identity always comes from
 * the server-derived TenantContext, and status management is out of scope for
 * this phase. The ValidationPipe runs with whitelist + forbidNonWhitelisted, so
 * any client-supplied id/status/tenantId is rejected with 400.
 */
export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(SLUG_PATTERN, {
    message:
      'slug must be 1-63 characters: lowercase letters, digits and hyphens, starting with a letter or digit',
  })
  slug?: string;

  @IsOptional()
  @IsObject()
  settings?: unknown;
}
