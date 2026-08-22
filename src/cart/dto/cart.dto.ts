import { IsInt, IsNotEmpty, IsString, Min, Max } from 'class-validator';

/**
 * Cart item payloads — Phase 3 U5.
 * Cart itself has no client-writable fields (owner and tenant are server-derived).
 * Items reference a variant and a quantity >0. No tenantId/id in body.
 */
export class AddCartItemDto {
  @IsString()
  @IsNotEmpty()
  variantId!: string;

  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity!: number;
}

export class UpdateCartItemDto {
  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity!: number;
}
