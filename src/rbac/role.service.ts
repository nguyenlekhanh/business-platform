import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  AssignRolePermissionsDto,
  AssignRoleToMembershipDto,
  CreateRoleDto,
  UpdateRoleDto,
} from './dto/role.dto';
import { assertNotLastActiveOwner } from './last-active-owner';
import { PermissionService } from './permission.service';
import { PERMISSIONS, SYSTEM_ROLE_KEYS } from './permission-catalog';

const ROLE_KEY_TAKEN = 'Role key already exists in this tenant';
const ROLE_ASSIGNED = 'Role is assigned to memberships';
const ROLE_NOT_FOUND = 'Role not found';
const SYSTEM_ROLE_IMMUTABLE = 'System roles are immutable';
const UNKNOWN_PERMISSION = 'Unknown permission id';
const DUPLICATE_PERMISSION = 'Duplicate permission ids are not allowed';
const PERMISSION_LIST_TOO_LARGE =
  'Permission list exceeds the maximum allowed size';
const PERMISSION_ID_TOO_LONG =
  'Permission id exceeds the maximum allowed length';
const CREATE_REQUIRES_PERMISSION = 'At least one permission is required';
const RESERVED_ROLE_KEY = 'Role key is reserved for system roles';
const GRANT_EXCEEDS_ACTOR = 'Cannot grant permissions you do not hold';
const SELF_ROLE_CHANGE = 'Cannot change your own role';
const OWNER_ASSIGNMENT = 'Only the owner can assign the owner role';
const LAST_OWNER = 'Cannot demote the last owner of the tenant';

const MAX_PERMISSION_IDS = 50;
const MAX_PERMISSION_ID_LENGTH = 40;

/**
 * Role management. Every operation first resolves the tenant-scoped Role (the
 * extension forces tenantId into reads/writes) so cross-tenant roleId or
 * membershipId values are rejected as "not found". The acting user's
 * permissions are asserted through PermissionService; every mutation clears
 * the per-request permission memo.
 *
 * BOUNDED GRANTS: an actor may only grant permissions they themselves hold.
 * The owner role carries semantic "all permissions" (PermissionService) and is
 * exempt. This is checked for BOTH createRole and assignPermissions against the
 * actor's effective permission snapshot, preventing privilege escalation where
 * a role:manage holder grants permissions they never had.
 *
 * LAST OWNER: demoting an owner is serialized with a PostgreSQL FOR UPDATE row
 * lock on the tenant's ACTIVE owner memberships (raw SQL, tenantId bound
 * explicitly since raw SQL bypasses the tenant-scoping extension). The owner
 * count is re-checked inside the same transaction, so concurrent demotions can
 * never leave a tenant with zero active owners.
 */
@Injectable()
export class RoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionService: PermissionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async createRole(
    actorUserId: string,
    dto: CreateRoleDto,
  ): Promise<{ id: string; key: string; name: string }> {
    await this.assertManage(actorUserId);
    this.assertNotReservedKey(dto.key);
    if (dto.permissionIds.length === 0) {
      throw new BadRequestException(CREATE_REQUIRES_PERMISSION);
    }
    const permissions = await this.resolvePermissions(dto.permissionIds);
    await this.assertBoundedGrants(actorUserId, permissions);

    try {
      const role = await this.prisma.$transaction(async (tx) => {
        const created = await tx.role.create({
          data: {
            tenantId: this.tenantContext.requireTenantId(),
            key: dto.key,
            name: dto.name,
            description: dto.description,
            isSystem: false,
          },
          select: { id: true, key: true, name: true },
        });
        await tx.rolePermission.createMany({
          data: permissions.map((permission) => ({
            roleId: created.id,
            permissionId: permission.id,
          })),
        });
        return created;
      });
      this.permissionService.clearMemo();
      return role;
    } catch (error) {
      if (this.isPrismaError(error, 'P2002')) {
        throw new ConflictException(ROLE_KEY_TAKEN);
      }
      throw error;
    }
  }

  async listRoles(actorUserId: string): Promise<
    Array<{
      id: string;
      key: string;
      name: string;
      description: string | null;
      isSystem: boolean;
      permissionCount: number;
    }>
  > {
    await this.assertRead(actorUserId);
    const roles = await this.prisma.role.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        isSystem: true,
        _count: { select: { permissions: true } },
      },
    });
    return roles.map((role) => ({
      ...role,
      permissionCount: role._count.permissions,
    }));
  }

  async getRole(
    actorUserId: string,
    roleId: string,
  ): Promise<{
    id: string;
    key: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    permissions: Array<{ id: string; key: string; name: string }>;
  }> {
    await this.assertRead(actorUserId);
    const role = await this.findRole(roleId);
    if (!role) {
      throw new NotFoundException(ROLE_NOT_FOUND);
    }
    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      permissions: role.permissions.map((rp) => ({
        id: rp.permission.id,
        key: rp.permission.key,
        name: rp.permission.name,
      })),
    };
  }

  async updateRole(
    actorUserId: string,
    roleId: string,
    dto: UpdateRoleDto,
  ): Promise<{
    id: string;
    key: string;
    name: string;
    description: string | null;
  }> {
    await this.assertManage(actorUserId);
    const role = await this.findRole(roleId);
    if (!role) {
      throw new NotFoundException(ROLE_NOT_FOUND);
    }
    this.assertMutable(role.isSystem);

    const updated = await this.prisma.role.update({
      where: { id: roleId },
      data: {
        name: dto.name ?? role.name,
        description:
          dto.description === undefined ? role.description : dto.description,
      },
      select: { id: true, key: true, name: true, description: true },
    });
    this.permissionService.clearMemo();
    return updated;
  }

  async deleteRole(
    actorUserId: string,
    roleId: string,
  ): Promise<{ id: string }> {
    await this.assertManage(actorUserId);
    const role = await this.findRole(roleId);
    if (!role) {
      throw new NotFoundException(ROLE_NOT_FOUND);
    }
    this.assertMutable(role.isSystem);

    const membershipCount = await this.prisma.membership.count({
      where: { roleId },
    });
    if (membershipCount > 0) {
      throw new ConflictException(ROLE_ASSIGNED);
    }

    try {
      await this.prisma.role.delete({ where: { id: roleId } });
      this.permissionService.clearMemo();
      return { id: roleId };
    } catch (error) {
      if (this.isPrismaError(error, 'P2003')) {
        throw new ConflictException(ROLE_ASSIGNED);
      }
      throw error;
    }
  }

  async assignPermissions(
    actorUserId: string,
    roleId: string,
    dto: AssignRolePermissionsDto,
  ): Promise<{ id: string; permissionCount: number }> {
    await this.assertManage(actorUserId);
    const role = await this.findRole(roleId);
    if (!role) {
      throw new NotFoundException(ROLE_NOT_FOUND);
    }
    this.assertMutable(role.isSystem);
    const permissions = await this.resolvePermissions(dto.permissionIds);
    await this.assertBoundedGrants(actorUserId, permissions);

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      if (permissions.length > 0) {
        await tx.rolePermission.createMany({
          data: permissions.map((permission) => ({
            roleId,
            permissionId: permission.id,
          })),
        });
      }
    });
    this.permissionService.clearMemo();
    return { id: roleId, permissionCount: permissions.length };
  }

  async assignRoleToMembership(
    actorUserId: string,
    dto: AssignRoleToMembershipDto,
  ): Promise<{ id: string; roleId: string }> {
    await this.assertManage(actorUserId);

    const role = await this.findRole(dto.roleId);
    if (!role) {
      throw new NotFoundException(ROLE_NOT_FOUND);
    }

    const membership = await this.prisma.membership.findUnique({
      where: { id: dto.membershipId ?? '' },
      select: { id: true, userId: true, role: { select: { key: true } } },
    });
    if (!membership) {
      throw new NotFoundException('Membership not found');
    }

    if (membership.userId === actorUserId) {
      throw new ForbiddenException(SELF_ROLE_CHANGE);
    }

    if (role.key === SYSTEM_ROLE_KEYS.OWNER) {
      const actor = await this.permissionService.getPermissions(actorUserId);
      if (!actor.isOwner) {
        throw new ForbiddenException(OWNER_ASSIGNMENT);
      }
    }

    const demotingOwner =
      membership.role.key === SYSTEM_ROLE_KEYS.OWNER &&
      role.key !== SYSTEM_ROLE_KEYS.OWNER;
    if (demotingOwner) {
      const updated = await this.demoteOwner(dto.membershipId ?? '', role.id);
      this.permissionService.clearMemo();
      return updated;
    }

    const updated = await this.prisma.membership.update({
      where: { id: dto.membershipId ?? '' },
      data: { roleId: role.id },
      select: { id: true, roleId: true },
    });
    this.permissionService.clearMemo();
    return updated;
  }

  /** Asserts the actor holds role:manage (owner semantics included). */
  private async assertManage(actorUserId: string): Promise<void> {
    await this.permissionService.assertPermissions(actorUserId, {
      mode: 'ALL',
      permissions: [PERMISSIONS.ROLE_MANAGE],
    });
  }

  /** Asserts the actor holds role:read (owner semantics included). */
  private async assertRead(actorUserId: string): Promise<void> {
    await this.permissionService.assertPermissions(actorUserId, {
      mode: 'ALL',
      permissions: [PERMISSIONS.ROLE_READ],
    });
  }

  /**
   * Tenant-scoped role lookup. The extension merges the active tenantId into
   * the where clause, so a roleId from another tenant resolves to null.
   */
  private findRole(roleId: string): Promise<{
    id: string;
    key: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    permissions: Array<{
      permission: { id: string; key: string; name: string };
    }>;
  } | null> {
    return this.prisma.role.findUnique({
      where: { id: roleId },
      include: {
        permissions: {
          select: {
            permission: { select: { id: true, key: true, name: true } },
          },
        },
      },
    });
  }

  /**
   * Resolves permission ids to their catalog entries. Hardened input checks
   * (mirrored by the DTO ValidationPipe): list bounded, per-id length bounded,
   * duplicates rejected, unknown ids rejected. All service-level because the
   * service is the authoritative security boundary (a missing pipe or a
   * direct service caller must not bypass them).
   */
  private async resolvePermissions(
    permissionIds: string[],
  ): Promise<Array<{ id: string; key: string }>> {
    if (permissionIds.length > MAX_PERMISSION_IDS) {
      throw new BadRequestException(PERMISSION_LIST_TOO_LARGE);
    }
    for (const permissionId of permissionIds) {
      if (permissionId.length > MAX_PERMISSION_ID_LENGTH) {
        throw new BadRequestException(PERMISSION_ID_TOO_LONG);
      }
    }
    const unique = Array.from(new Set(permissionIds));
    if (unique.length !== permissionIds.length) {
      throw new BadRequestException(DUPLICATE_PERMISSION);
    }
    const found = await this.prisma.permission.findMany({
      where: { id: { in: unique } },
      select: { id: true, key: true },
    });
    if (found.length !== unique.length) {
      throw new BadRequestException(UNKNOWN_PERMISSION);
    }
    return found;
  }

  /**
   * BOUNDED GRANTS: the actor may only grant permissions they hold. Owners
   * (semantic all-permissions) are exempt. Without this, a role:manage holder
   * could create/grant any catalog permission and escalate privileges.
   */
  private async assertBoundedGrants(
    actorUserId: string,
    permissions: Array<{ id: string; key: string }>,
  ): Promise<void> {
    if (permissions.length === 0) {
      return;
    }
    const actor = await this.permissionService.getPermissions(actorUserId);
    if (actor.isOwner) {
      return;
    }
    const held = new Set(actor.keys);
    const unheld = permissions.find((permission) => !held.has(permission.key));
    if (unheld) {
      throw new ForbiddenException(GRANT_EXCEEDS_ACTOR);
    }
  }

  /**
   * System role keys (owner/admin/employee) are reserved: a custom role must
   * never claim them. The DTO regex also rejects them, but this service-level
   * check is the security boundary and does not rely on seeded rows or the
   * DB unique constraint.
   */
  private assertNotReservedKey(key: string): void {
    if (Object.values(SYSTEM_ROLE_KEYS).includes(key as never)) {
      throw new BadRequestException(RESERVED_ROLE_KEY);
    }
  }

  /**
   * Serializes owner demotions with a PostgreSQL row lock (shared helper
   * assertNotLastActiveOwner). The owner count is re-checked inside the same
   * transaction after the lock is acquired, so concurrent demotions can never
   * leave a tenant with zero active owners.
   */
  private demoteOwner(
    membershipId: string,
    newRoleId: string,
  ): Promise<{ id: string; roleId: string }> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.prisma.$transaction(async (tx) => {
      await assertNotLastActiveOwner(tx, tenantId, LAST_OWNER);
      return tx.membership.update({
        where: { id: membershipId },
        data: { roleId: newRoleId },
        select: { id: true, roleId: true },
      });
    });
  }

  private assertMutable(isSystem: boolean): void {
    if (isSystem) {
      throw new ForbiddenException(SYSTEM_ROLE_IMMUTABLE);
    }
  }

  private isPrismaError(
    error: unknown,
    code: string,
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === code
    );
  }
}
