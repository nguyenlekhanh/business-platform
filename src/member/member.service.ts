import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MembershipStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { normalizeEmail } from '../common/utils/normalize-email.util';
import { assertNotLastActiveOwner } from '../rbac/last-active-owner';
import { PERMISSIONS, SYSTEM_ROLE_KEYS } from '../rbac/permission-catalog';
import { PermissionService } from '../rbac/permission.service';
import { CreateMemberDto } from './dto/create-member.dto';
import { UpdateMemberStatusDto } from './dto/member.dto';

const MEMBERSHIP_NOT_FOUND = 'Membership not found';
const SELF_STATUS_CHANGE = 'Cannot change your own membership status';
const SELF_MEMBERSHIP = 'Cannot add yourself as a member';
const LAST_ACTIVE_OWNER = 'Cannot suspend the last active owner of the tenant';
const ALREADY_MEMBER = 'User is already a member of this tenant';
const ROLE_NOT_FOUND = 'Role not found';
const DEFAULT_ROLE_NOT_FOUND = 'Default role not found';
const OWNER_ASSIGNMENT = 'Only the owner can assign the owner role';

const MEMBER_INCLUDE = {
  user: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
    },
  },
  role: {
    select: {
      id: true,
      key: true,
      name: true,
      isSystem: true,
    },
  },
} as const satisfies Prisma.MembershipInclude;

type MemberWithRelations = Prisma.MembershipGetPayload<{
  include: typeof MEMBER_INCLUDE;
}>;

export interface MemberSummary {
  membershipId: string;
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: {
    id: string;
    key: string;
    name: string;
    isSystem: boolean;
  };
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Membership administration: listing/getting tenant members and updating
 * membership status. Every operation first resolves the tenant-scoped
 * Membership (the extension forces tenantId into reads/writes), so
 * cross-tenant membershipId/userId values are rejected as "not found". The
 * acting user's permissions are asserted through PermissionService (owner
 * semantics included), and status mutations clear the per-request permission
 * memo.
 *
 * SECURITY INVARIANTS (mirrors of the RoleService owner protections):
 * - SELF-CHANGE: a member cannot change their own membership status, matching
 *   the self-role-change guard.
 * - LAST ACTIVE OWNER: suspending an active owner is serialized with the
 *   shared PostgreSQL FOR UPDATE row lock (assertNotLastActiveOwner) so
 *   concurrent suspensions can never leave a tenant with zero active owners.
 */
@Injectable()
export class MemberService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionService: PermissionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async listMembers(actorUserId: string): Promise<MemberSummary[]> {
    await this.assertRead(actorUserId);
    const memberships = await this.prisma.membership.findMany({
      orderBy: { createdAt: 'asc' },
      include: MEMBER_INCLUDE,
    });
    return memberships.map((membership) => this.toSummary(membership));
  }

  async getMember(actorUserId: string, userId: string): Promise<MemberSummary> {
    await this.assertRead(actorUserId);
    const membership = await this.findMemberByUserId(userId);
    if (!membership) {
      throw new NotFoundException(MEMBERSHIP_NOT_FOUND);
    }
    return this.toSummary(membership);
  }

  async updateMemberStatus(
    actorUserId: string,
    membershipId: string,
    dto: UpdateMemberStatusDto,
  ): Promise<MemberSummary> {
    await this.assertManage(actorUserId);

    const membership = await this.findMembership(membershipId);
    if (!membership) {
      throw new NotFoundException(MEMBERSHIP_NOT_FOUND);
    }

    if (membership.userId === actorUserId) {
      throw new ForbiddenException(SELF_STATUS_CHANGE);
    }

    const isOwnerMembership = membership.role.key === SYSTEM_ROLE_KEYS.OWNER;

    const removingActiveOwner =
      isOwnerMembership &&
      membership.status === 'ACTIVE' &&
      dto.status === 'SUSPENDED';

    const updated = removingActiveOwner
      ? await this.updateWithOwnerLock(membershipId, dto.status)
      : await this.prisma.membership.update({
          where: { id: membershipId },
          data: { status: dto.status },
          include: MEMBER_INCLUDE,
        });

    this.permissionService.clearMemo();
    return this.toSummary(updated);
  }

  /**
   * Onboards a new member into the current tenant (POST /members).
   *
   * SECURITY INVARIANTS (mirrors RoleService protections):
   * - member:manage asserted through PermissionService (owner semantics).
   * - Tenant derived ONLY from TenantContext; client tenantId ignored.
   * - Target User resolved globally by normalized email (trim+lowercase),
   *   reusing the existing User row (no duplicates) via upsert.
   * - Target Role resolved by tenant-scoped lookup (extension enforces
   *   tenant scoping): cross-tenant roleId -> null -> 404.
   * - Assigning owner requires the actor to be owner (OWNER_ASSIGNMENT).
   * - Custom role assignment cannot bypass bounded-grant rules because the
   *   role is resolved through the tenant-scoped store and its grants are
   *   inherent to the role (no client-supplied permissionIds are accepted).
   * - actor cannot onboard themselves (SELF_MEMBERSHIP) -> 403.
   * - Duplicate [userId, tenantId] membership -> 409.
   * - All writes run inside a single $transaction so a failure (e.g. P2002 on
   *   User.email or Membership uniqueness) aborts atomically.
   */
  async createMember(
    actorUserId: string,
    dto: CreateMemberDto,
  ): Promise<MemberSummary> {
    await this.assertManage(actorUserId);

    const tenantId = this.tenantContext.requireTenantId();
    const role = await this.resolveTargetRole(dto.roleId);
    if (!role) {
      throw new NotFoundException(
        dto.roleId ? ROLE_NOT_FOUND : DEFAULT_ROLE_NOT_FOUND,
      );
    }

    if (role.key === SYSTEM_ROLE_KEYS.OWNER) {
      const actor = await this.permissionService.getPermissions(actorUserId);
      if (!actor.isOwner) {
        throw new ForbiddenException(OWNER_ASSIGNMENT);
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.upsert({
          where: { email: normalizeEmail(dto.email) },
          update: {},
          create: {
            email: normalizeEmail(dto.email),
            firstName: dto.firstName ?? null,
            lastName: dto.lastName ?? null,
          },
          select: { id: true },
        });

        if (user.id === actorUserId) {
          throw new ForbiddenException(SELF_MEMBERSHIP);
        }

        const existing = await tx.membership.findUnique({
          where: {
            userId_tenantId: {
              userId: user.id,
              tenantId,
            },
          },
          select: { id: true },
        });
        if (existing) {
          throw new ConflictException(ALREADY_MEMBER);
        }

        const created = await tx.membership.create({
          data: {
            userId: user.id,
            tenantId,
            roleId: role.id,
          },
          include: MEMBER_INCLUDE,
        });
        return this.toSummary(created);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Database unique constraint is the final authority for a concurrent
        // duplicate User.email or Membership uniqueness violation — never
        // expose the internal Prisma error.
        throw new ConflictException(ALREADY_MEMBER);
      }
      throw error;
    }
  }

  private async resolveTargetRole(
    roleId?: string,
  ): Promise<{ id: string; key: string; isSystem: boolean } | null> {
    const tenantId = this.tenantContext.requireTenantId();
    if (roleId) {
      const role = await this.prisma.role.findUnique({
        where: { tenantId_id: { tenantId, id: roleId } },
        select: { id: true, key: true, isSystem: true },
      });
      return role;
    }
    return this.prisma.role.findFirst({
      where: { tenantId, key: SYSTEM_ROLE_KEYS.EMPLOYEE, isSystem: true },
      select: { id: true, key: true, isSystem: true },
    });
  }

  /** Tenant-scoped membership lookup by userId (composite unique key). */
  private findMemberByUserId(
    userId: string,
  ): Promise<MemberWithRelations | null> {
    return this.prisma.membership.findUnique({
      where: {
        userId_tenantId: {
          userId,
          tenantId: this.tenantContext.requireTenantId(),
        },
      },
      include: MEMBER_INCLUDE,
    });
  }

  /**
   * Tenant-scoped membership lookup by id. The extension merges the active
   * tenantId into the where clause, so a membershipId from another tenant
   * resolves to null.
   */
  private findMembership(
    membershipId: string,
  ): Promise<MemberWithRelations | null> {
    return this.prisma.membership.findUnique({
      where: { id: membershipId },
      include: MEMBER_INCLUDE,
    });
  }

  /**
   * Suspends an ACTIVE owner inside the shared last-active-owner transaction:
   * the FOR UPDATE row lock serializes concurrent suspensions so a tenant can
   * never lose its final active owner. Reuses the same security logic as
   * RoleService demotion (assertNotLastActiveOwner). The transaction returns
   * only the id; the full summary is re-read afterwards through the
   * tenant-scoped path.
   */
  private async updateWithOwnerLock(
    membershipId: string,
    status: string,
  ): Promise<MemberWithRelations> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.prisma.$transaction(async (tx) => {
      await assertNotLastActiveOwner(tx, tenantId, LAST_ACTIVE_OWNER);
      await tx.membership.update({
        where: { id: membershipId },
        data: { status: status as MembershipStatus },
        select: { id: true },
      });
    });
    const updated = await this.findMembership(membershipId);
    if (!updated) {
      throw new NotFoundException(MEMBERSHIP_NOT_FOUND);
    }
    return updated;
  }

  private toSummary(membership: MemberWithRelations): MemberSummary {
    return {
      membershipId: membership.id,
      userId: membership.userId,
      email: membership.user.email,
      firstName: membership.user.firstName,
      lastName: membership.user.lastName,
      role: {
        id: membership.role.id,
        key: membership.role.key,
        name: membership.role.name,
        isSystem: membership.role.isSystem,
      },
      status: membership.status,
      createdAt: membership.createdAt,
      updatedAt: membership.updatedAt,
    };
  }

  /** Asserts the actor holds member:read (owner semantics included). */
  private async assertRead(actorUserId: string): Promise<void> {
    await this.permissionService.assertPermissions(actorUserId, {
      mode: 'ALL',
      permissions: [PERMISSIONS.MEMBER_READ],
    });
  }

  /** Asserts the actor holds member:manage (owner semantics included). */
  private async assertManage(actorUserId: string): Promise<void> {
    await this.permissionService.assertPermissions(actorUserId, {
      mode: 'ALL',
      permissions: [PERMISSIONS.MEMBER_MANAGE],
    });
  }
}
