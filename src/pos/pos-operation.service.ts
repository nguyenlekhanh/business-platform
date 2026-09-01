import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PosOperation, PosOperationItem } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { RecordOfflineSaleIntentDto } from './dto/pos.dto';

const SESSION_NOT_FOUND = 'POS session not found';

/**
 * Frozen intent-line projection (money is a string in JSON per the
 * established BigInt convention; the DB stores exact BIGINT).
 */
export interface OfflineIntentItemSummary {
  id: string;
  variantId: string;
  quantity: number;
  currency: string;
  observedUnitAmountMinor: string;
}

/**
 * Offline sale intent â€” the durable sync-inbox record (P4-U4).
 * `status` describes the SYNC operation ONLY (PENDING until P4-U5
 * processes it); it is never an Order/Payment state.
 */
export interface OfflineOperationSummary {
  id: string;
  tenantId: string;
  deviceId: string;
  sessionId: string;
  storeId: string;
  userId: string; // cashier (session opener at record time)
  clientUuid: string;
  seq: number;
  type: string;
  status: string;
  resultCode: string | null;
  resultOrderId: string | null;
  resultPaymentId: string | null;
  customerId: string | null;
  processedAt: Date | null;
  createdAt: Date;
  items: OfflineIntentItemSummary[];
}

/** Get one operation joined with its frozen lines (typed via Prisma). */
/**
 * PosOperationService â€” Phase 4 P4-U4 (offline operation model ONLY).
 *
 * What this service does:
 *   - RECORDS a device's offline sale intent as a durable, immutable-
 *     provenance row + frozen normalized lines (the sync inbox).
 *   - Deduplicates by (deviceId, clientUuid) â€” the DB UNIQUE is the final
 *     idempotency authority: a second push of the same device op resolves
 *     to the SAME durable row (idempotent 200/201, never a second row).
 *   - Enforces per-device sequence uniqueness: a duplicate (deviceId, seq)
 *     from a DIFFERENT clientUuid is a deterministic 409 (the DB
 *     arbitrates; no read-then-increment, no application memory).
 *
 * What it deliberately does NOT do (P4-U5+): no sync, no execution, no
 * Order/Payment/Inventory/Cart mutation, no price or stock validation,
 * no reconciliation. The server remains the price authority AT SYNC (D3);
 * recording an intent grants the client NO authority to execute it.
 *
 * SECURITY CONTRACT: tenant is server-derived from the fail-closed
 * context; the session is resolved through a tenant-scoped lookup
 * (foreign/unknown -> uniform 404); device/store/cashier are DERIVED from
 * the session (immutable provenance â€” never client-writable); the
 * caller must be the session opener (a different member gets the same
 * uniform 404); sessionId/deviceId/storeId/tenantId/cashierId/status
 * injections are rejected by the DTO whitelist (400). The operation
 * RETAINS its session identity even after the session closes (U5 decides
 * historical acceptability).
 */
@Injectable()
export class PosOperationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Record one offline sale intent. The insert itself is the idempotency
   * gate: the (deviceId, clientUuid) UNIQUE arbitrates concurrent duplicate
   * pushes, and (deviceId, seq) arbitrates sequence collisions â€” both via
   * the database, inside one transaction that writes the parent row and
   * its frozen lines atomically.
   */
  async recordOfflineSaleIntent(
    userId: string,
    dto: RecordOfflineSaleIntentDto,
  ): Promise<OfflineOperationSummary> {
    this.assertTenantContext();
    const tenantId = this.tenantContext.requireTenantId();

    // Trusted context: everything derives from the session. A session from
    // another tenant resolves to null (uniform 404). OPEN or CLOSED are
    // both recordable â€” this is the historical outbox, and U5 decides
    // whether the historical session/authorization conditions are
    // acceptable at sync time.
    const session = await this.prisma.posSession.findUnique({
      where: { id: dto.sessionId },
    });
    if (!session) throw new NotFoundException(SESSION_NOT_FOUND);

    // Cashier binding: only the session opener may record intents for the
    // shift (same binding as the online sale; non-opener -> uniform 404).
    if (session.userId !== userId) {
      throw new NotFoundException(SESSION_NOT_FOUND);
    }

    try {
      const operation = await this.prisma.$transaction(async (tx) => {
        const created = await tx.posOperation.create({
          data: {
            tenantId,
            deviceId: session.deviceId,
            sessionId: session.id,
            storeId: session.storeId,
            userId: session.userId,
            clientUuid: dto.clientUuid,
            seq: dto.seq,
            type: 'SALE_INTENT',
            status: 'PENDING',
            ...(dto.customerId !== undefined
              ? { customerId: dto.customerId }
              : {}),
          },
        });
        // Frozen normalized lines: exact BIGINT observed prices (typed
        // columns, not a free-form JSON blob â€” D3 comparison reads these).
        for (const item of dto.items) {
          await tx.posOperationItem.create({
            data: {
              tenantId,
              operationId: created.id,
              variantId: item.variantId,
              quantity: item.quantity,
              currency: item.currency,
              observedUnitAmountMinor: BigInt(item.observedUnitAmountMinor),
            },
          });
        }
        const withItems = await tx.posOperation.findUniqueOrThrow({
          where: { id: created.id },
          include: { items: true },
        });
        return withItems;
      });
      return this.toSummary(operation);
    } catch (error) {
      // (deviceId, clientUuid): same op pushed again -> idempotent success
      // returning the ORIGINAL durable row (at-least-once delivery,
      // exactly-once effect).
      if (this.isP2002(error)) {
        const meta = this.p2002Meta(error);
        if (meta === 'clientUuid') {
          const existing = await this.prisma.posOperation.findFirst({
            where: { deviceId: session.deviceId, clientUuid: dto.clientUuid },
            include: { items: true },
          });
          if (existing) {
            return this.toSummary(existing);
          }
        }
        // (deviceId, seq): a DIFFERENT operation claimed this sequence â€”
        // deterministic conflict, never silent reordering.
        throw new ConflictException(
          'Device sequence number already used by another operation',
        );
      }
      throw error;
    }
  }

  async getOperation(operationId: string): Promise<OfflineOperationSummary> {
    this.assertTenantContext();
    const operation = await this.prisma.posOperation.findUnique({
      where: { id: operationId },
      include: { items: true },
    });
    if (!operation) throw new NotFoundException('POS operation not found');
    return this.toSummary(operation);
  }

  /**
   * The device's outbox view on the server: its operations ordered by seq
   * (the device-assigned outbox order). Scope: ONE authenticated device
   * (derived from its session or explicit device id) â€” a device can never
   * list another device's operations.
   */
  async listDeviceOperations(
    deviceId: string,
  ): Promise<OfflineOperationSummary[]> {
    this.assertTenantContext();
    const device = await this.prisma.posDevice.findUnique({
      where: { id: deviceId },
    });
    if (!device) throw new NotFoundException('Pos device not found');

    const operations = await this.prisma.posOperation.findMany({
      where: { deviceId },
      orderBy: { seq: 'asc' },
      include: { items: true },
    });
    return operations.map((op) => this.toSummary(op));
  }

  private toSummary(
    operation: PosOperation & { items: PosOperationItem[] },
  ): OfflineOperationSummary {
    return {
      id: operation.id,
      tenantId: operation.tenantId,
      deviceId: operation.deviceId,
      sessionId: operation.sessionId,
      storeId: operation.storeId,
      userId: operation.userId,
      clientUuid: operation.clientUuid,
      seq: operation.seq,
      type: operation.type,
      status: operation.status,
      resultCode: operation.resultCode,
      resultOrderId: operation.resultOrderId,
      resultPaymentId: operation.resultPaymentId,
      customerId: operation.customerId,
      processedAt: operation.processedAt,
      createdAt: operation.createdAt,
      items: operation.items
        .map((item) => ({
          id: item.id,
          variantId: item.variantId,
          quantity: item.quantity,
          currency: item.currency,
          observedUnitAmountMinor: item.observedUnitAmountMinor.toString(),
        }))
        // Deterministic line order for the frozen snapshot.
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  /** Identify WHICH unique index tripped P2002 (clientUuid vs seq). */
  private p2002Meta(error: Prisma.PrismaClientKnownRequestError): string {
    const target = (error.meta as { target?: string[] } | null)?.target;
    if (Array.isArray(target) && target.includes('clientUuid')) {
      return 'clientUuid';
    }
    return 'seq';
  }

  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }

  private isP2002(
    error: unknown,
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}
