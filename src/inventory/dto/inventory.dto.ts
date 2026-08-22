import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  NotEquals,
} from 'class-validator';

/**
 * Inventory adjustment payload — Phase 3 U4.
 * `delta` is the signed change to apply atomically (never a direct quantity).
 * Zero is rejected; negative stock is rejected by the guarded update and DB CHECK.
 * `reason` is optional free-form audit note.
 * No tenantId/id in body: tenant always server-derived.
 */
export class AdjustInventoryDto {
  @IsString()
  @IsNotEmpty()
  variantId!: string;

  @IsInt()
  @NotEquals(0, { message: 'delta must not be 0' })
  delta!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
