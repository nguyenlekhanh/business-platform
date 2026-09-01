import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { PosOperation, PosOperationItem } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PermissionService } from '../rbac/permission.service';
import { PERMISSIONS } from '../rbac/permission-catalog';
import { PosDeviceService } from './pos-device.service';
import { PosSaleService } from './pos-sale.service';

const OPERATION_NOT_FOUND = 'POS operation not found';
const DEVICE_NOT_FOUND = 'Pos device not found';
const INVALID_DEVICE_CREDENTIAL = 'Invalid device credential';
const SYNC_IN_PROGRESS = 'Operation is already syncing';

/** Per-operation sync response (durable result). */
export interface SyncResult {
  operationId: string;
  clientUuid: string;
  seq: number;
  status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
  resultCode: string | null;
  orderId: string | null;
  paymentId: string | null;
}

/** One feed entry in the pull response. */
export interface FeedEntry {
  feedSeq: number;
  kind: string;
  entityId: string;
}

export interface FeedPage {
  entries: FeedEntry[];
  nextCursor: number;
}

type OperationWithItems = PosOperation & { items: PosOperationItem[] };

/**
 * PosSyncService — Phase 4 P4-U5 (server-side sync protocol).
 *
 * Executes the durable offline sale intents recorded by P4-U4 through the
 * EXISTING sale engine (PosSaleService.createSale -> Order T1 -> Payment
 * T5 -> cash T2) — never duplicated logic. The offline operation is an
 * INTENT; at sync the server is authoritative (D3 price, D4 stock, D7
 * authorization).
 *
 * AUTHENTICATION (D6): sync requires BOTH the cashier JWT (guard chain)
 * AND the server-issued device credential (X-POS-Device-Credential
 * header), verified constant-time against the operation's OWN device;
 * the device must be ACTIVE. Tenant identity is always server-derived.
 *
 * CONCURRENCY (exactly-once execution): Prisma interactive transactions
 * cannot nest (the inner tx client omits $transaction), so the sale
 * engine's own transactions cannot be wrapped in an outer claim. The
 * claim is therefore a DB-arbitrated guarded update on an EXISTING U4
 * column — processedAt (null = unclaimed):
 *   updateMany({ id, status: 'PENDING', processedAt: null },
 *              { processedAt: now })
 * Exactly one concurrent syncer wins (count 1); losers poll the durable
 * row (bounded await of the winner's in-flight engine transaction —
 * awaiting a concurrent transaction, not a correctness sleep) and both
 * return the SAME durable result. Business rejections are persisted
 * immutably (REJECTED + typed resultCode); a retried rejection returns
 * the persisted outcome unchanged. A crash after claim but before the
 * final result leaves status PENDING with processedAt set; a later sync
 * treats that op as claimable-in-error ONLY if resultOrderId is null
 * and the claim has expired (stale-claim recovery: the sale engine is
 * itself atomic, so no partial sale can exist — the claim is simply
 * re-taken; documented, deterministic).
 */
@Injectable()
export class PosSyncService {
  /** Stale-claim recovery window: a claim older than this with no result
   *  may be re-taken (crash recovery). Generous vs. engine latency. */
  private static readonly CLAIM_STALENESS_MS = 5 * 60 * 1000;
  /** Bounded await for a concurrent winner's engine transaction. */
  private static readonly RESULT_POLL_MS = 25;
  private static readonly RESULT_POLL_MAX = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly permissionService: PermissionService,
    private readonly deviceService: PosDeviceService,
    private readonly saleService: PosSaleService,
  ) {}

  // ------------------------------------------------------------------
  // PUSH: sync one offline operation
  // ------------------------------------------------------------------

  async syncOperation(
    userId: string,
    operationId: string,
    deviceCredential: string | undefined,
  ): Promise<SyncResult> {
    this.assertTenantContext();

    const operation = await this.loadOperation(operationId);
    await this.assertSyncAuthority(userId, operation, deviceCredential);

    // Durable replays: ACCEPTED / DUPLICATE / REJECTED return the
    // persisted result unchanged (idempotent, never re-executed, a
    // business rejection is never retried into a different outcome).
    if (operation.status !== 'PENDING') {
      return this.toSyncResult(operation);
    }

    // Deterministic validations BEFORE any mutation (D3/D4). These run on
    // current server state and leave nothing behind on rejection.
    const rejectionCode = await this.validateIntent(operation);
    if (rejectionCode) {
      const persisted = await this.persistRejection(
        operation.id,
        rejectionCode,
      );
      return this.toSyncResult(persisted);
    }

    // Claim (DB-arbitrated). Un-claimable within the freshness window =>
    // a concurrent syncer is mid-execution: await their durable result.
    const claimed = await this.prisma.posOperation.updateMany({
      where: {
        id: operation.id,
        status: 'PENDING',
        processedAt: null,
      },
      data: { processedAt: new Date() },
    });

    if (claimed.count === 0) {
      const settled = await this.awaitConcurrentResult(operation.id);
      if (settled) return this.toSyncResult(settled);
      // Claim held with no result and not stale: still in flight or the
      // concurrent winner's write is imminent; deterministic conflict.
      throw new ConflictException(SYNC_IN_PROGRESS);
    }

    // Winner: execute through the EXISTING sale engine (cash-only, D5),
    // then persist the final result in ONE guarded update. Any engine
    // failure rolls back nothing extra (T1/T5/T2 are independently
    // atomic); the claim is stale-recoverable on the next sync.
    try {
      const sale = await this.saleService.createSale(
        operation.userId,
        {
          sessionId: operation.sessionId,
          items: operation.items.map((i) => ({
            variantId: i.variantId,
            quantity: i.quantity,
          })),
          ...(operation.customerId ? { customerId: operation.customerId } : {}),
          method: 'CASH',
        },
        // D5 via the P4-U6 boundary: the sync path is structurally
        // cash-only at the payment-creation boundary.
        { allowClosedSession: true, offline: true },
      );

      const finalized = await this.prisma.posOperation.updateMany({
        where: { id: operation.id, status: 'PENDING' },
        data: {
          status: 'ACCEPTED',
          resultCode: null,
          resultOrderId: sale.orderId,
          resultPaymentId: sale.paymentId,
        },
      });
      if (finalized.count === 0) {
        // Should be impossible for the claim winner; treat as concurrent
        // resolution and return the durable state.
        const settled = await this.loadOperation(operation.id);
        return this.toSyncResult(settled);
      }

      const fresh = await this.loadOperation(operation.id);
      return this.toSyncResult(fresh);
    } catch (error) {
      // Engine business failure AFTER validation passed (e.g. a stock
      // race lost between validation and T1): the guarded decrement in T1
      // kept the state consistent (no negative stock, no partial order),
      // and ConflictException('Insufficient stock') is deterministic —
      // persist it as OUT_OF_STOCK so the client sees why sync failed.
      if (
        error instanceof ConflictException &&
        (error as { message?: string }).message === 'Insufficient stock'
      ) {
        const persisted = await this.persistRejection(
          operation.id,
          'OUT_OF_STOCK',
        );
        return this.toSyncResult(persisted);
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------
  // Authority checks (D6 + D7)
  // ------------------------------------------------------------------

  /** Tenant-scoped load; foreign ids resolve to null -> uniform 404. */
  private async loadOperation(
    operationId: string,
  ): Promise<OperationWithItems> {
    const operation = await this.prisma.posOperation.findUnique({
      where: { id: operationId },
      include: { items: true },
    });
    if (!operation) throw new NotFoundException(OPERATION_NOT_FOUND);
    return operation;
  }

  /**
   * D6: device credential verified against the operation's OWN device
   * (constant-time), device must be ACTIVE. D7: the authenticated
   * principal must BE the recorded cashier and hold CURRENT pos:create.
   * The recorded provenance is NEVER execution authority.
   */
  private async assertSyncAuthority(
    userId: string,
    operation: OperationWithItems,
    deviceCredential: string | undefined,
  ): Promise<void> {
    if (!deviceCredential) {
      throw new UnauthorizedException(INVALID_DEVICE_CREDENTIAL);
    }
    const device = await this.prisma.posDevice.findUnique({
      where: { id: operation.deviceId },
    });
    if (!device) throw new NotFoundException(DEVICE_NOT_FOUND);
    if (device.status !== 'ACTIVE') {
      throw new ConflictException('Device is not active');
    }
    if (!this.deviceService.verifyCredential(device, deviceCredential)) {
      throw new UnauthorizedException(INVALID_DEVICE_CREDENTIAL);
    }
    if (operation.userId !== userId) {
      throw new NotFoundException(OPERATION_NOT_FOUND);
    }
    await this.permissionService.assertPermissions(userId, {
      mode: 'ANY',
      permissions: [PERMISSIONS.POS_CREATE],
    });
  }

  // ------------------------------------------------------------------
  // Deterministic validation (D3 price authority + D4 stock)
  // ------------------------------------------------------------------

  /**
   * Runs entirely on current server state BEFORE any mutation:
   *  - variant exists and is ACTIVE;
   *  - exact BigInt comparison of the CURRENT server price against the
   *    device-observed price for the intent's currency — any difference
   *    => PRICE_CHANGED (never silent repricing; no floats, no rounding);
   *  - currency rule: the existing repository rule is a uniform single
   *    currency per order => CURRENCY_MIX for mixed intents;
   *  - all-or-nothing stock against the operation's STORE pool =>
   *    OUT_OF_STOCK (no negative stock, no partial fulfillment, no
   *    quantity reduction).
   * Returns the typed rejection code, or null when executable.
   */
  private async validateIntent(
    operation: OperationWithItems,
  ): Promise<string | null> {
    if (operation.items.length === 0) return 'EMPTY_INTENT';

    const variantIds = Array.from(
      new Set(operation.items.map((i) => i.variantId)),
    );

    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
    });
    if (variants.length !== variantIds.length) return 'VARIANT_NOT_FOUND';
    for (const v of variants) {
      if (v.status !== 'ACTIVE') return 'VARIANT_NOT_ACTIVE';
    }

    const prices = await this.prisma.price.findMany({
      where: { variantId: { in: variantIds } },
    });
    const priceMap = new Map<string, Map<string, bigint>>();
    for (const p of prices) {
      const byCur = priceMap.get(p.variantId) ?? new Map<string, bigint>();
      byCur.set(p.currency, BigInt(p.amountMinor));
      priceMap.set(p.variantId, byCur);
    }

    let targetCurrency: string | null = null;
    const aggregated = new Map<string, number>();
    for (const line of operation.items) {
      aggregated.set(
        line.variantId,
        (aggregated.get(line.variantId) ?? 0) + line.quantity,
      );
    }
    for (const line of operation.items) {
      if (targetCurrency === null) targetCurrency = line.currency;
      if (line.currency !== targetCurrency) return 'CURRENCY_MIX';
      const byCur = priceMap.get(line.variantId);
      if (!byCur || !byCur.has(line.currency)) return 'PRICE_NOT_FOUND';
      const serverPrice = byCur.get(line.currency)!;
      if (serverPrice !== BigInt(line.observedUnitAmountMinor)) {
        return 'PRICE_CHANGED';
      }
    }

    for (const [vid, qty] of aggregated.entries()) {
      const row = await this.prisma.inventory.findFirst({
        where: { variantId: vid, storeId: operation.storeId },
      });
      if (!row || row.quantityOnHand < qty) return 'OUT_OF_STOCK';
    }

    return null;
  }

  // ------------------------------------------------------------------
  // Durable result persistence
  // ------------------------------------------------------------------

  /** Persist a deterministic rejection; immutable once written. */
  private async persistRejection(
    operationId: string,
    resultCode: string,
  ): Promise<OperationWithItems> {
    await this.prisma.posOperation.updateMany({
      where: { id: operationId, status: 'PENDING' },
      data: { status: 'REJECTED', resultCode },
    });
    return this.loadOperation(operationId);
  }

  /**
   * Bounded await of a concurrent winner's durable result (awaiting an
   * in-flight transaction, NOT a correctness sleep). Returns the settled
   * operation, or null if the window elapsed.
   */
  private async awaitConcurrentResult(
    operationId: string,
  ): Promise<OperationWithItems | null> {
    for (let i = 0; i < PosSyncService.RESULT_POLL_MAX; i++) {
      const op = await this.prisma.posOperation.findUnique({
        where: { id: operationId },
        include: { items: true },
      });
      if (op && op.status !== 'PENDING') {
        return op;
      }
      // Stale claim (crash recovery window elapsed): allow re-claim by
      // treating it as unclaimed on the caller's next attempt.
      if (
        op &&
        op.processedAt !== null &&
        Date.now() - op.processedAt.getTime() >
          PosSyncService.CLAIM_STALENESS_MS
      ) {
        await this.prisma.posOperation.updateMany({
          where: { id: operationId, status: 'PENDING' },
          data: { processedAt: null },
        });
        return null;
      }
      await new Promise((r) => setTimeout(r, PosSyncService.RESULT_POLL_MS));
    }
    return null;
  }

  private toSyncResult(operation: OperationWithItems): SyncResult {
    return {
      operationId: operation.id,
      clientUuid: operation.clientUuid,
      seq: operation.seq,
      status: operation.status as SyncResult['status'],
      resultCode: operation.resultCode,
      orderId: operation.resultOrderId,
      paymentId: operation.resultPaymentId,
    };
  }

  // ------------------------------------------------------------------
  // PULL: watermark + tombstone feed (D8)
  // ------------------------------------------------------------------

  /**
   * Minimal pull: ordered feed entries with feedSeq > since (the device
   * cursor). Tenant-scoped by the extension. nextCursor is the highest
   * delivered feedSeq (or `since` when empty) — the unique per-tenant
   * monotonic feedSeq makes the half-open interval unambiguous:
   * deterministic resume, no missed changes, no duplicate application.
   */
  async pullFeed(since: number): Promise<FeedPage> {
    this.assertTenantContext();
    if (!Number.isInteger(since) || since < 0) {
      throw new ConflictException('Invalid feed cursor');
    }
    const entries = await this.prisma.posFeedEvent.findMany({
      where: { feedSeq: { gt: since } },
      orderBy: { feedSeq: 'asc' },
      take: 100,
    });
    const nextCursor =
      entries.length > 0 ? entries[entries.length - 1].feedSeq : since;
    return {
      entries: entries.map((e) => ({
        feedSeq: e.feedSeq,
        kind: e.kind,
        entityId: e.entityId,
      })),
      nextCursor,
    };
  }

  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }
}
