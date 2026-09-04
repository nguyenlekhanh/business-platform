import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { OrderService, OrderSummary } from '../order/order.service';
import { PaymentService } from '../payment/payment.service';
import { CreatePosSaleDto } from './dto/pos.dto';

const SESSION_NOT_FOUND = 'POS session not found';
const SESSION_NOT_OPEN = 'Only open sessions can create sales';
const DEVICE_NOT_ACTIVE = 'Device is not active';

/**
 * POS-sale provenance + final state — Phase 4 P4-U2.
 *
 * `paymentStatus` mirrors the existing Payment state machine (PROCESSING or
 * CAPTURED); `orderStatus` mirrors the existing Order state machine
 * (PENDING or PAID). Every amount/total is the Order/Payment string-BigInt
 * value computed by the Core Commerce services — this projection adds no
 * arithmetic of its own.
 */
export interface PosSaleSummary {
  id: string;
  tenantId: string;
  orderId: string;
  paymentId: string;
  sessionId: string;
  deviceId: string;
  storeId: string;
  userId: string; // cashier
  orderStatus: string;
  paymentStatus: string;
  method: string;
  currency: string;
  subtotalMinor: string;
  items: OrderSummary['items'];
  createdAt: Date;
}

/**
 * Online POS sale — Phase 4 P4-U2.
 *
 * CORE PRINCIPLE: POS is a store-scoped surface ON TOP of Core Commerce.
 * This service orchestrates; it never duplicates commerce logic:
 *   1. Resolve + validate the POS context INSIDE one tenant-scoped read:
 *      session must exist (uniform 404), be OPEN, belong to an ACTIVE
 *      device; store/device/cashier are ALL derived from the session —
 *      the client supplies only sessionId + items (+ optional method and
 *      customerId). No client authority fields are trusted.
 *   2. Create the Order via the EXISTING OrderService.createOrder (T1:
 *      server pricing, uniform currency, guarded stock decrement,
 *      immutable snapshots, exact BigInt totals).
 *   3. Create the Payment via the EXISTING PaymentService.createPayment
 *      (T5: amount/currency derived from the Order).
 *   4. CASH (default): capture immediately via the EXISTING
 *      PaymentService.capturePayment (T2: guarded PROCESSING->CAPTURED +
 *      Order PENDING->PAID, atomic) — cash is captured when tendered (the
 *      approved D5 pattern). CARD: leave PROCESSING for the existing
 *      POST /payments/:id/capture flow.
 *   5. Persist the PosSale provenance row linking order/payment to the
 *      session/device/store/cashier.
 *
 * SECURITY CONTRACT: identical to every tenant-scoped service — server-
 * derived tenantId, fail-closed context, uniform 404 for foreign ids.
 */
@Injectable()
export class PosSaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly orderService: OrderService,
    private readonly paymentService: PaymentService,
  ) {}

  async createSale(
    userId: string,
    dto: CreatePosSaleDto,
    options?: {
      /**
       * INTERNAL — P4-U5 sync consumer only. The online endpoint requires
       * an OPEN session; the sync protocol executes intents recorded
       * during a shift that has since CLOSED (D7: authorization is
       * revalidated at sync; provenance is not execution authority).
       * Sync sets allowClosedSession=true ONLY after its own full
       * revalidation (tenant, device ACTIVE, device-credential,
       * cashier = recorded opener, current RBAC pos:create). No HTTP
       * client can reach this path.
       */
      allowClosedSession?: boolean;
      /**
       * INTERNAL — P4-U6 offline payment boundary (approved D5: offline
       * payment is CASH-ONLY; card/external providers are online-only).
       * When offline=true, any method other than CASH is rejected AT THE
       * PAYMENT BOUNDARY with a deterministic 409 — the online CARD flow
       * is completely unaffected. The offline sync path is structurally
       * incapable of creating a card Payment, not merely by convention
       * of its call site.
       */
      offline?: boolean;
    },
  ): Promise<PosSaleSummary> {
    this.assertTenantContext();
    const tenantId = this.tenantContext.requireTenantId();

    // P4-U6: the offline payment boundary is enforced server-side at the
    // sale/payment creation boundary — never only at a controller.
    if (options?.offline && dto.method !== undefined && dto.method !== 'CASH') {
      throw new ConflictException('Offline payment must be cash');
    }

    // 1. POS context: everything derives from the session.
    const session = await this.prisma.posSession.findUnique({
      where: { id: dto.sessionId },
    });
    if (!session) throw new NotFoundException(SESSION_NOT_FOUND);
    if (session.status !== 'OPEN' && !options?.allowClosedSession) {
      throw new ConflictException(SESSION_NOT_OPEN);
    }
    const device = await this.prisma.posDevice.findUnique({
      where: { id: session.deviceId },
    });
    if (!device) throw new NotFoundException(SESSION_NOT_FOUND);
    if (device.status !== 'ACTIVE') {
      throw new ConflictException(DEVICE_NOT_ACTIVE);
    }

    // The session's opener is the cashier of record. A different
    // authenticated member using an open session is rejected: the sale is
    // attributed to exactly the cashier who opened the shift.
    if (session.userId !== userId) {
      throw new NotFoundException(SESSION_NOT_FOUND);
    }

    const method = dto.method ?? 'CASH';

    // 2. Order via the existing Core Commerce T1 (server-authoritative
    //    pricing + guarded stock decrement + snapshots). P4-U3: the sale
    //    consumes the STORE's pool (session -> device -> store), never the
    //    tenant-global pool and never a client-selected store.
    // P5-U5: pass bookingId for optional Booking->Order provenance link
    const order = await this.orderService.createOrder(
      userId,
      {
        items: dto.items.map((i) => ({
          variantId: i.variantId,
          quantity: i.quantity,
        })),
        ...(dto.customerId !== undefined ? { customerId: dto.customerId } : {}),
        ...(dto.bookingId !== undefined ? { bookingId: dto.bookingId } : {}),
      },
      { inventoryScope: { kind: 'store', storeId: session.storeId } },
    );

    // 3. Payment via the existing T5 (amount/currency derived from Order).
    const payment = await this.paymentService.createPayment({
      orderId: order.id,
      method,
    });

    // 4. CASH captures immediately via the existing T2 (guarded, atomic,
    //    flips the Order to PAID). CARD stays PROCESSING for the existing
    //    capture endpoint.
    let currentPayment = payment;
    let currentOrder = order;
    if (method === 'CASH') {
      currentPayment = await this.paymentService.capturePayment(payment.id);
      // Re-read the Order through the commerce service so the summary
      // reflects the post-capture state (PENDING -> PAID via T2).
      currentOrder = await this.orderService.getOrder(order.id);
    }

    // 5. Provenance row (one per Order/Payment — UNIQUE constraints).
    const sale = await this.prisma.posSale.create({
      data: {
        tenantId,
        orderId: order.id,
        paymentId: payment.id,
        sessionId: session.id,
        deviceId: session.deviceId,
        storeId: session.storeId,
        userId: session.userId,
      },
    });

    return this.toSummary(sale, currentOrder, currentPayment);
  }

  async getSale(saleId: string): Promise<PosSaleSummary> {
    this.assertTenantContext();
    const sale = await this.prisma.posSale.findUnique({
      where: { id: saleId },
    });
    if (!sale) throw new NotFoundException('POS sale not found');
    return this.projectSale(sale);
  }

  /** List a session's sales (provenance view of the shift). */
  async listSessionSales(sessionId: string): Promise<PosSaleSummary[]> {
    this.assertTenantContext();
    const session = await this.prisma.posSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) throw new NotFoundException(SESSION_NOT_FOUND);
    const sales = await this.prisma.posSale.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
    const summaries: PosSaleSummary[] = [];
    for (const sale of sales) {
      summaries.push(await this.projectSale(sale));
    }
    return summaries;
  }

  private async projectSale(sale: {
    id: string;
    tenantId: string;
    orderId: string;
    paymentId: string;
    sessionId: string;
    deviceId: string;
    storeId: string;
    userId: string;
    createdAt: Date;
  }): Promise<PosSaleSummary> {
    const order = await this.orderService.getOrder(sale.orderId);
    const payment = await this.paymentService.getPayment(sale.paymentId);
    return this.toSummary(sale, order, payment);
  }

  private toSummary(
    sale: {
      id: string;
      tenantId: string;
      orderId: string;
      paymentId: string;
      sessionId: string;
      deviceId: string;
      storeId: string;
      userId: string;
      createdAt: Date;
    },
    order: OrderSummary,
    payment: { status: string; method: string; currency: string },
  ): PosSaleSummary {
    return {
      id: sale.id,
      tenantId: sale.tenantId,
      orderId: sale.orderId,
      paymentId: sale.paymentId,
      sessionId: sale.sessionId,
      deviceId: sale.deviceId,
      storeId: sale.storeId,
      userId: sale.userId,
      orderStatus: order.status,
      paymentStatus: payment.status,
      method: payment.method,
      currency: payment.currency,
      subtotalMinor: order.subtotalMinor,
      items: order.items,
      createdAt: sale.createdAt,
    };
  }

  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }
}
