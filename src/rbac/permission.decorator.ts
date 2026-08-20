import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_METADATA_KEY = 'rbac:permissions';

export type PermissionMode = 'ALL' | 'ANY';

export interface PermissionRequirement {
  mode: PermissionMode;
  permissions: readonly string[];
}

/**
 * Declares that the handler requires the caller to hold ALL of the given
 * permissions (evaluated inside the resolved TenantContext). Usable at class
 * or method level.
 */
export const RequirePermission = (
  ...permissions: string[]
): MethodDecorator & ClassDecorator =>
  SetMetadata<string, PermissionRequirement>(PERMISSIONS_METADATA_KEY, {
    mode: 'ALL',
    permissions,
  });

/**
 * Declares that the handler requires the caller to hold AT LEAST ONE of the
 * given permissions.
 */
export const RequireAnyPermission = (
  ...permissions: string[]
): MethodDecorator & ClassDecorator =>
  SetMetadata<string, PermissionRequirement>(PERMISSIONS_METADATA_KEY, {
    mode: 'ANY',
    permissions,
  });
