import { Injectable } from '@nestjs/common';
import type { Tenant } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';

@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves a tenant for a user by requiring an ACTIVE membership for that
   * tenant AND an ACTIVE tenant itself. Every failure mode collapses to null
   * so callers can reject with a single generic error without revealing
   * whether the tenant or membership exists.
   */
  async resolveTenant(
    userId: string,
    tenantId: string,
  ): Promise<Tenant | null> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      include: { tenant: true },
    });

    if (!membership || membership.status !== 'ACTIVE') {
      return null;
    }
    if (membership.tenant.status !== 'ACTIVE') {
      return null;
    }
    return membership.tenant;
  }
}
