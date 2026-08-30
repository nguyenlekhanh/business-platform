import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

/**
 * Create payment payload — Phase 3 U7.
 * Amount and currency are derived from the Order (full-amount invariant).
 * Status is server-controlled (PROCESSING -> CAPTURED|FAILED).
 * tenantId is server-derived via tenant-scoping extension.
 */
export class CreatePaymentDto {
  @IsString()
  @IsNotEmpty()
  orderId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  method!: string;
}
