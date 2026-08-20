import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PermissionRequirement } from './permission.decorator';
import { SYSTEM_ROLE_KEYS } from './permission-catalog';

export interface PermissionSnapshot {
  isOwner: boolean;
  keys: readonly string[];
}

/**
 * Resolves a user's effective permissions inside the current TenantContext.
 * The tenant id is ALWAYS read from the AsyncLocalStorage context
 * (requireTenantId) and never accepted from client input, which makes
 * cross-tenant permission leakage impossible: the membership lookup is
 * tenant-scoped and the role is reached from that scoped membership only.
 */
@Injectable()
export class PermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async getPermissions(userId: string): Promise<PermissionSnapshot> {
    const tenantId = this.tenantContext.requireTenantId();
    const memoKey = `permissions:${tenantId}:${userId}`;
    const memo = this.tenantContext.getMemo();
    if (memo) {
      const cached = memo.get(memoKey);
      if (cached) {
        return cached as PermissionSnapshot;
      }
    }
    const snapshot = await this.loadSnapshot(userId, tenantId);
    if (memo) {
      memo.set(memoKey, snapshot);
    }
    return snapshot;
  }

  async assertPermissions(
    userId: string,
    requirement: PermissionRequirement,
  ): Promise<void> {
    const snapshot = await this.getPermissions(userId);
    if (!this.satisfies(snapshot, requirement)) {
      throw new ForbiddenException('Insufficient permissions');
    }
  }

  /** Clears the per-request permission memo after any RBAC mutation. */
  clearMemo(): void {
    this.tenantContext.clearMemo();
  }

  private satisfies(
    snapshot: PermissionSnapshot,
    requirement: PermissionRequirement,
  ): boolean {
    if (snapshot.isOwner) {
      return true;
    }
    return requirement.mode === 'ANY'
      ? requirement.permissions.some((key) => snapshot.keys.includes(key))
      : requirement.permissions.every((key) => snapshot.keys.includes(key));
  }

  private async loadSnapshot(
    userId: string,
    tenantId: string,
  ): Promise<PermissionSnapshot> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: {
        status: true,
        role: {
          select: {
            key: true,
            permissions: {
              select: { permission: { select: { key: true } } },
            },
          },
        },
      },
    });

    if (!membership || membership.status !== 'ACTIVE') {
      return { isOwner: false, keys: [] };
    }
    if (membership.role.key === SYSTEM_ROLE_KEYS.OWNER) {
      return { isOwner: true, keys: [] };
    }
    return {
      isOwner: false,
      keys: membership.role.permissions.map((rp) => rp.permission.key),
    };
  }
}
