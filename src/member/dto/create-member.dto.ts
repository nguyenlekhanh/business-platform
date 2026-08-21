import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Onboarding / invitation payload for POST /members.
 *
 * Only the fields genuinely needed for server-side membership onboarding are
 * accepted. The following are explicitly NOT accepted to prevent privilege
 * escalation and cross-tenant / impersonation attacks:
 *  - tenantId   (derived from TenantContext)
 *  - userId     (derived from normalized-email User resolution)
 *  - membershipId (server-generated)
 *  - isSystem   (immutable system-flag)
 *  - status     (server-controlled onboarding state)
 *  - role key/name (roleId-based assignment only)
 *  - permissionIds (not an endpoint concern)
 */
export class CreateMemberDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  /**
   * Optional tenant-scoped role id to assign on onboarding. When omitted, a
   * safe default (the tenant's `employee` system role) is resolved.
   */
  @IsOptional()
  @IsString()
  roleId?: string;
}
