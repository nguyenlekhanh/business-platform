import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

// Reserved system role keys. Custom roles must never claim them; the
// service-level check is the security boundary, this regex is defense-in-depth.
const RESERVED_SYSTEM_KEYS = 'owner|admin|employee';

const ROLE_KEY_PATTERN = new RegExp(
  `^(?!(${RESERVED_SYSTEM_KEYS})$)[a-z][a-z0-9-]{0,63}$`,
);

const MAX_PERMISSION_IDS = 50;
const MAX_PERMISSION_ID_LENGTH = 40;

export class CreateRoleDto {
  @Matches(ROLE_KEY_PATTERN, {
    message:
      'key must start with a lowercase letter, contain only lowercase letters, digits and hyphens, and must not be a reserved system role key',
  })
  key!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayMaxSize(MAX_PERMISSION_IDS)
  @IsString({ each: true })
  @MaxLength(MAX_PERMISSION_ID_LENGTH, { each: true })
  permissionIds!: string[];
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class AssignRolePermissionsDto {
  @IsArray()
  @ArrayMaxSize(MAX_PERMISSION_IDS)
  @IsString({ each: true })
  @MaxLength(MAX_PERMISSION_ID_LENGTH, { each: true })
  permissionIds!: string[];
}

export class AssignRoleToMembershipDto {
  // membershipId is injected from the route parameter by the controller; it is
  // optional here so the body-only validation (roleId) passes without it.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  membershipId?: string;

  @IsString()
  @IsNotEmpty()
  roleId!: string;
}
