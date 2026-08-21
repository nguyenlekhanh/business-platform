import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Presented refresh-token material. The raw value is validated for shape
 * only; its authenticity is proven by hashing and matching the stored hash.
 */
export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  refreshToken!: string;
}
