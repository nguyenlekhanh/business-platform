import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SYSTEM_ROLE_KEYS } from './permission-catalog';

/**
 * Serializes operations that remove an active owner (demotion, suspension)
 * with a PostgreSQL FOR UPDATE row lock on the tenant's ACTIVE owner
 * memberships. Raw SQL is required because FOR UPDATE row locking is not
 * expressible through Prisma's query builder. Raw SQL bypasses the
 * tenant-scoping extension (contract #5), so the active tenant id is obtained
 * via requireTenantId() by the caller and bound as a parameter — never
 * interpolated — keeping the lock tenant-scoped. The owner count is re-read
 * inside the same transaction after the lock is acquired, so concurrent
 * operations can never both proceed past the last active owner.
 *
 * Callers MUST invoke this inside an interactive $transaction on the extended
 * Prisma client so the mutation and the lock commit atomically.
 */
export async function assertNotLastActiveOwner(
  tx: Prisma.TransactionClient,
  tenantId: string,
  message: string,
): Promise<void> {
  const owners = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Membership"
    WHERE "tenantId" = ${tenantId}
      AND "status" = 'ACTIVE'
      AND "roleId" IN (
        SELECT "id" FROM "Role"
        WHERE "tenantId" = ${tenantId}
          AND "key" = ${SYSTEM_ROLE_KEYS.OWNER}
      )
    FOR UPDATE
  `);
  if (owners.length <= 1) {
    throw new ConflictException(message);
  }
}
