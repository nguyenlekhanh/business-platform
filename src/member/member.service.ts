import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MembershipStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { assertNotLastActiveOwner } from '../rbac/last-active-owner';
import { PERMISSIONS, SYSTEM_ROLE_KEYS } from '../rbac/permission-catalog';
import { PermissionService } from '../rbac/permission.service';
import { UpdateMemberStatusDto } from './dto/member.dto';

const MEMBERSHIP_NOT_FOUND = 'Membership not found';
const SELF_STATUS_CHANGE = 'Cannot change your own membership status';
const LAST_ACTIVE_OWNER = 'Cannot suspend the last active owner of the tenant';

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
