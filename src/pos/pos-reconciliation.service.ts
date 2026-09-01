import { Injectable, NotFoundException } from '@nestjs/common';
import type { PosOperation } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';

const DEVICE_NOT_FOUND = 'Pos device not found';
const SESSION_NOT_FOUND = 'POS session not found';

/** One resolved operation in the report (read-only projection). */
export interface ReconciledOperation {
  operationId: string;
  clientUuid: string;
  seq: number;
  status: 'PENDING' | 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
  resultCode: string | null;
  orderId: string | null;
  paymentId: string | null;
  createdAt: Date;
}

/** Device-level reconciliation report (device recovery flow). */
export interface DeviceReconciliationReport {
  deviceId: string;
  storeId: string;
  totals: { pending: number; accepted: number; rejected: number };
  /** Every REJECTED operation with its deterministic code — the client
   *  must see why sync failed; nothing is silently swallowed. */
  rejected: ReconciledOperation[];
  /** Every ACCEPTED operation with its durable Order/Payment ids. */
  accepted: ReconciledOperation[];
  /** Unresolved PENDING operations the device should (re-)sync. */
  pending: ReconciledOperation[];
}

/** Session-level reconciliation report (the shift report, per D9). */
export interface SessionReconciliationReport {
  sessionId: string;
  deviceId: string;
  storeId: string;
  cashierId: string;
  totals: { pending: number; accepted: number; rejected: number };
  rejected: ReconciledOperation[];
  accepted: ReconciledOperation[];
  pending: ReconciledOperation[];
}

/**
 * PosReconciliationService — Phase 4 P4-U7.
 *
 * READ-ONLY conflict surfacing and reconciliation REPORTING. All offline
 * conflict outcomes were already made deterministic and terminal by the
 * approved decisions (D3 PRICE_CHANGED — never silent repricing; D4
 * OUT_OF_STOCK — never partial fulfillment; D7 authorization revalidated
 * at sync) and are durably recorded by P4-U4/U5 on PosOperation (status +
 * typed resultCode + result Order/Payment ids). P4-U7 does NOT mutate
 * anything, does NOT re-resolve conflicts (no manual-resolution
 * semantics are approved anywhere — a business rejection is terminal and
 * immutable), and does NOT alter any original intent field: it projects
 * the durable resolutions into staff/device-facing reports:
 *   - Device-level report (the device recovery flow): which operations
 *     are still PENDING (re-sync), which were ACCEPTED (with their
 *     Order/Payment ids), and which were REJECTED with the typed reason
 *     (PRICE_CHANGED, OUT_OF_STOCK, ...) so the client knows exactly why
 *     synchronization failed.
 *   - Session-level report (the shift report, per approved D9: PosSession
 *     anchors "intent ownership and reconciliation reports").
 *
 * SECURITY: tenant-scoped lookups (uniform 404 for foreign ids);
 * pos:read governs both endpoints (no new RBAC keys); the report is a
 * pure read — zero side effects, zero idempotency hazards.
 */
@Injectable()
export class PosReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Device-level reconciliation report (read-only). */
  async getDeviceReconciliation(
    deviceId: string,
  ): Promise<DeviceReconciliationReport> {
    this.assertTenantContext();
    const device = await this.prisma.posDevice.findUnique({
      where: { id: deviceId },
    });
    if (!device) throw new NotFoundException(DEVICE_NOT_FOUND);

    const operations = await this.prisma.posOperation.findMany({
      where: { deviceId },
      orderBy: { seq: 'asc' },
    });

    return this.buildDeviceReport(deviceId, device.storeId, operations);
  }

  /** Session-level (shift) reconciliation report (read-only). */
  async getSessionReconciliation(
    sessionId: string,
  ): Promise<SessionReconciliationReport> {
    this.assertTenantContext();
    const session = await this.prisma.posSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) throw new NotFoundException(SESSION_NOT_FOUND);

    const operations = await this.prisma.posOperation.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
    });

    const { rejected, accepted, pending } =
      this.partitionOperations(operations);
    return {
      sessionId: session.id,
      deviceId: session.deviceId,
      storeId: session.storeId,
      cashierId: session.userId,
      totals: {
        pending: pending.length,
        accepted: accepted.length,
        rejected: rejected.length,
      },
      rejected,
      accepted,
      pending,
    };
  }

  // ------------------------------------------------------------------

  private buildDeviceReport(
    deviceId: string,
    storeId: string,
    operations: PosOperation[],
  ): DeviceReconciliationReport {
    const { rejected, accepted, pending } =
      this.partitionOperations(operations);
    return {
      deviceId,
      storeId,
      totals: {
        pending: pending.length,
        accepted: accepted.length,
        rejected: rejected.length,
      },
      rejected,
      accepted,
      pending,
    };
  }

  private partitionOperations(operations: PosOperation[]): {
    rejected: ReconciledOperation[];
    accepted: ReconciledOperation[];
    pending: ReconciledOperation[];
  } {
    const rejected: ReconciledOperation[] = [];
    const accepted: ReconciledOperation[] = [];
    const pending: ReconciledOperation[] = [];
    for (const op of operations) {
      const projected = this.project(op);
      if (op.status === 'REJECTED') rejected.push(projected);
      else if (op.status === 'ACCEPTED' || op.status === 'DUPLICATE')
        accepted.push(projected);
      else pending.push(projected);
    }
    return { rejected, accepted, pending };
  }

  /** Never exposes the intent payload (frozen lines stay internal);
   *  projects only the identity + durable resolution. */
  private project(op: PosOperation): ReconciledOperation {
    return {
      operationId: op.id,
      clientUuid: op.clientUuid,
      seq: op.seq,
      status: op.status,
      resultCode: op.resultCode,
      orderId: op.resultOrderId,
      paymentId: op.resultPaymentId,
      createdAt: op.createdAt,
    };
  }

  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }
}
