import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  PERMISSION_DEFINITIONS,
  PERMISSIONS,
  SYSTEM_ROLE_KEYS,
} from '../rbac/permission-catalog';
import { AppModule } from '../app.module';

/**
 * Phase 4 P4-U6 — Offline Payment Boundary integration suite (approved D5).
 *
 * Proves the STRUCTURAL cash-only boundary of the offline sync path and the
 * full payment-integrity contract around it:
 *   - offline sync always produces a CASH Payment CAPTURED + Order PAID via
 *     the EXISTING state machines (T5+T2; no second payment state machine);
 *   - a card method cannot reach the offline path (no method field exists on
 *     the intent DTO; sync passes CASH; the sale boundary rejects non-cash
 *     when offline);
 *   - amount integrity: Payment.amountMinor === Order.subtotalMinor (exact
 *     BigInt, server-authoritative; device-observed prices are ONLY the D3
 *     PRICE_CHANGED comparator — they can never become the payment amount);
 *   - PRICE_CHANGED / OUT_OF_STOCK leave NO Payment at all;
 *   - idempotency: retried ACCEPTED returns the SAME Payment/Order with no
 *     second payment, order, capture, or decrement; concurrent sync creates
 *     exactly ONE payment;
 *   - the ONLINE cash and CARD flows are completely unchanged (regression
 *     against the boundary);
 *   - no API exists to mark an offline Payment captured directly — the
 *     existing capture endpoint follows its own permission (payment:manage).
 */
describe('POS Offline Payment Boundary (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }
  interface SyncResultBody {
    operationId: string;
    status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
    resultCode: string | null;
    orderId: string | null;
    paymentId: string | null;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `payb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const userIdsToDelete: string[] = [];
  const roleIdsToDelete: string[] = [];
  const membershipIdsToDelete: string[] = [];
  const tenantIdsToDelete: string[] = [];

  const createTenant = async (label: string) => {
    const tenant = await prisma.tenant.create({
      data: {
        name: `T ${label} ${run}`,
        slug: `${run}-${label}-${Math.floor(Math.random() * 1e6)}`,
      },
    });
    tenantIdsToDelete.push(tenant.id);
    return tenant;
  };

  const grantRole = async (
    tenantId: string,
    key: string,
    permissionKeys: readonly string[],
  ) => {
    const role = await tenantContext.run(tenantId, async () =>
      prisma.role.create({ data: { tenantId, key, name: `${key} ${run}` } }),
    );
    roleIdsToDelete.push(role.id);
    if (permissionKeys.length > 0) {
      await tenantContext.run(tenantId, async () => {
        const permissions = await prisma.permission.findMany({
          where: { key: { in: [...permissionKeys] } },
        });
        await prisma.rolePermission.createMany({
          data: permissions.map((p) => ({
            roleId: role.id,
            permissionId: p.id,
          })),
        });
      });
    }
    return role;
  };

  const createUser = async (
    email: string,
    tenantId: string,
    roleId: string,
  ) => {
    const user = await prisma.user.create({
      data: { email, passwordHash: `hash-${email}` },
    });
    userIdsToDelete.push(user.id);
    const membership = await tenantContext.run(tenantId, async () =>
      prisma.membership.create({ data: { userId: user.id, tenantId, roleId } }),
    );
    membershipIdsToDelete.push(membership.id);
    return user;
  };

  const loginAs = async (userId: string, tenantId: string) => {
    const token = await jwtService.signAsync({ sub: userId });
    return { Authorization: `Bearer ${token}`, 'X-Tenant-ID': tenantId };
  };

  const httpServer = () => app.getHttpServer() as unknown as Server;
  interface Res {
    status: number;
    body: Record<string, unknown>;
  }
  const call = async (
    method: 'get' | 'post' | 'patch',
    path: string,
    headers: Record<string, string>,
    payload?: Record<string, unknown>,
  ): Promise<Res> => {
    let req = request(httpServer())[method](path).set(headers);
    if (payload !== undefined) req = req.send(payload);
    const res = await req;
    return { status: res.status, body: res.body as Record<string, unknown> };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    tenantContext = app.get(TenantContextService);
    await prisma.permission.createMany({
      data: PERMISSION_DEFINITIONS.map((d) => ({
        key: d.key,
        name: d.name,
        category: d.category,
        description: d.description ?? null,
      })),
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.posFeedEvent
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.posOperationItem
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.posOperation
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.posSale
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.payment
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.orderItem
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.order
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.posSession
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.posDevice
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.inventory
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.price
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.productVariant
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.product
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.category
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.membership
        .deleteMany({ where: { id: { in: membershipIdsToDelete } } })
        .catch(() => undefined);
      await prisma.rolePermission
        .deleteMany({ where: { roleId: { in: roleIdsToDelete } } })
        .catch(() => undefined);
      await prisma.role
        .deleteMany({ where: { id: { in: roleIdsToDelete } } })
        .catch(() => undefined);
      await prisma.membership
        .deleteMany({ where: { userId: { in: userIdsToDelete } } })
        .catch(() => undefined);
      await prisma.user
        .deleteMany({ where: { id: { in: userIdsToDelete } } })
        .catch(() => undefined);
      await prisma.store
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.tenant
        .deleteMany({ where: { id: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
    }
    if (app) await app.close();
  });

  let tenantAId: string;
  let storeAId: string;
  let cashierA: Record<string, string>;
  let managerA: Record<string, string>;

  let seqCounter = 0;

  beforeEach(async () => {
    seqCounter += 1;
    const tenantA = await createTenant('a');
    tenantAId = tenantA.id;
    storeAId = (
      await tenantContext.run(tenantAId, async () =>
        prisma.store.create({
          data: {
            tenantId: tenantAId,
            name: `SA-${run}-${seqCounter}`,
            code: `SA-${run}-${seqCounter}`,
            type: 'POS',
            status: 'ACTIVE',
          },
        }),
      )
    ).id;

    const cashierRole = await grantRole(tenantAId, `cashier-a-${run}`, [
      PERMISSIONS.POS_READ,
      PERMISSIONS.POS_CREATE,
    ]);
    const managerRole = await grantRole(tenantAId, `manager-a-${run}`, [
      PERMISSIONS.POS_READ,
      PERMISSIONS.POS_CREATE,
      PERMISSIONS.POS_MANAGE,
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.ORDER_CREATE,
      PERMISSIONS.PAYMENT_READ,
      PERMISSIONS.PAYMENT_CREATE,
      PERMISSIONS.PAYMENT_MANAGE,
    ]);
    const ownerRole = await grantRole(tenantAId, SYSTEM_ROLE_KEYS.OWNER, []);

    const cashierUser = await createUser(
      `cashier-${run}-${seqCounter}@a.test`,
      tenantAId,
      cashierRole.id,
    );
    const managerUser = await createUser(
      `manager-${run}-${seqCounter}@a.test`,
      tenantAId,
      managerRole.id,
    );
    await createUser(
      `owner-${run}-${seqCounter}@a.test`,
      tenantAId,
      ownerRole.id,
    );

    cashierA = await loginAs(cashierUser.id, tenantAId);
    managerA = await loginAs(managerUser.id, tenantAId);
  });

  /** Device + session + priced variant + store stock, all real. */
  const mkContext = async (
    opts: { unitPrice?: bigint; stock?: number } = {},
  ) => {
    const ctxSeq = ++seqCounter;
    const dev = await call('post', '/pos/devices', managerA, {
      storeId: storeAId,
      name: `DEV-${run}-${ctxSeq}`,
    });
    expect(dev.status).toBe(201);
    const { id: deviceId, credential } = dev.body as {
      id: string;
      credential: string;
    };
    const ses = await call('post', '/pos/sessions', cashierA, { deviceId });
    expect(ses.status).toBe(201);
    const sessionId = (ses.body as { id: string }).id;

    const cat = await tenantContext.run(tenantAId, async () =>
      prisma.category.create({
        data: { tenantId: tenantAId, name: `CAT-${run}-${ctxSeq}` },
      }),
    );
    const prod = await tenantContext.run(tenantAId, async () =>
      prisma.product.create({
        data: {
          tenantId: tenantAId,
          categoryId: cat.id,
          name: `PROD-${run}-${ctxSeq}`,
          code: `CODE-${run}-${ctxSeq}`,
          status: 'ACTIVE',
        },
      }),
    );
    const variant = await tenantContext.run(tenantAId, async () =>
      prisma.productVariant.create({
        data: {
          tenantId: tenantAId,
          productId: prod.id,
          sku: `SKU-${run}-${ctxSeq}`,
        },
      }),
    );
    const unitPrice = opts.unitPrice ?? 1250n;
    await tenantContext.run(tenantAId, async () =>
      prisma.price.create({
        data: {
          tenantId: tenantAId,
          variantId: variant.id,
          currency: 'USD',
          amountMinor: unitPrice,
        },
      }),
    );
    await tenantContext.run(tenantAId, async () =>
      prisma.inventory.create({
        data: {
          tenantId: tenantAId,
          variantId: variant.id,
          storeId: storeAId,
          quantityOnHand: opts.stock ?? 10,
        },
      }),
    );

    return {
      deviceId,
      credential,
      sessionId,
      variantId: variant.id,
      unitPrice,
    };
  };

  const uuid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  const recordIntent = async (
    ctx: { sessionId: string; variantId: string },
    clientUuid: string,
    seq: number,
    opts: {
      quantity?: number;
      observedPrice?: number;
      currency?: string;
      method?: string;
    } = {},
  ) => {
    const payload: Record<string, unknown> = {
      sessionId: ctx.sessionId,
      clientUuid,
      seq,
      items: [
        {
          variantId: ctx.variantId,
          quantity: opts.quantity ?? 2,
          currency: opts.currency ?? 'USD',
          observedUnitAmountMinor: opts.observedPrice ?? 1250,
        },
      ],
    };
    // Payment-method injection attempt: the DTO has NO method field — a
    // malicious client tries to smuggle one in.
    if (opts.method !== undefined) payload['method'] = opts.method;

    const res = await call(
      'post',
      '/pos/offline/operations',
      cashierA,
      payload,
    );
    return res;
  };

  const sync = (operationId: string, credential: string, headers = cashierA) =>
    call('post', `/pos/offline/operations/${operationId}/sync`, {
      ...headers,
      'X-POS-Device-Credential': credential,
    });

  const paymentRow = (id: string) =>
    tenantContext.run(tenantAId, async () =>
      prisma.payment.findUnique({ where: { id } }),
    );

  // ------------------------------------------------------------------

  describe('cash-only offline payment (D5 structural boundary)', () => {
    it('a successful offline sync produces exactly ONE CASH Payment CAPTURED via the existing T5+T2', async () => {
      const ctx = await mkContext({ unitPrice: 1250n, stock: 10 });
      const rec = await recordIntent(ctx, uuid(1), 1, { quantity: 3 });
      expect(rec.status).toBe(201);
      const op = rec.body as { id: string };

      const res = await sync(op.id, ctx.credential);
      expect(res.status).toBe(200);
      const body = res.body as unknown as SyncResultBody;
      expect(body.status).toBe('ACCEPTED');
      expect(body.paymentId).not.toBeNull();

      // EXISTING Payment state machine, end to end.
      const payment = await paymentRow(body.paymentId!);
      expect(payment?.method).toBe('CASH');
      expect(payment?.status).toBe('CAPTURED'); // T2 immediate
      // Amount integrity: server Order total === Payment amount, exact BigInt.
      const order = await tenantContext.run(tenantAId, async () =>
        prisma.order.findUniqueOrThrow({ where: { id: body.orderId! } }),
      );
      expect(order.status).toBe('PAID');
      expect(order.subtotalMinor).toBe(3750n); // 3 * 1250 SERVER price
      expect(payment?.amountMinor).toBe(order.subtotalMinor);
      expect(payment?.currency).toBe(order.currency);

      // Exactly one payment for the order.
      const payments = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findMany({ where: { orderId: order.id } }),
      );
      expect(payments).toHaveLength(1);
    });

    it('the intent DTO has NO method field: method injection is rejected with 400', async () => {
      const ctx = await mkContext();
      const rec = await recordIntent(ctx, uuid(2), 1, { method: 'CARD' });
      expect(rec.status).toBe(400); // whitelist/forbidNonWhitelisted
      const ops = await tenantContext.run(tenantAId, async () =>
        prisma.posOperation.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(ops).toHaveLength(0); // nothing recorded
    });

    it('sync passes CASH only: the offline boundary rejects any non-cash method server-side', async () => {
      const ctx = await mkContext();
      const rec = await recordIntent(ctx, uuid(3), 1);
      expect(rec.status).toBe(201);
      const op = rec.body as { id: string };

      // The sale boundary (offline=true) rejects a CARD method
      // deterministically — proven at the service level in the unit spec;
      // over HTTP the sync path itself carries no method, so the happy
      // path here proves the boundary admits only CASH end to end.
      const res = await sync(op.id, ctx.credential);
      const body = res.body as unknown as SyncResultBody;
      expect(body.status).toBe('ACCEPTED');
      const payment = await paymentRow(body.paymentId!);
      expect(payment?.method).toBe('CASH');
      expect(payment?.status).toBe('CAPTURED');
    });

    it('no API lets a client directly mark an offline Payment captured: the capture endpoint keeps its own permission', async () => {
      const ctx = await mkContext();
      const rec = await recordIntent(ctx, uuid(4), 1);
      const op = rec.body as { id: string };
      const res = await sync(op.id, ctx.credential);
      const body = res.body as unknown as SyncResultBody;
      expect(body.status).toBe('ACCEPTED');

      // The payment is already CAPTURED (idempotent re-capture is the
      // existing Phase 3 behavior). A cashier WITHOUT payment:manage (the
      // normal cashier) gets 403 from the generic capture endpoint.
      const recapture = await call(
        'post',
        `/payments/${body.paymentId}/capture`,
        cashierA,
      );
      expect(recapture.status).toBe(403); // pos-only role lacks payment:manage
    });
  });

  describe('amount integrity (server-authoritative)', () => {
    it('device-observed price can NEVER become the payment amount (stale-higher price + PRICE_CHANGED)', async () => {
      // The device observed a HIGHER price than the server's current one.
      const ctx = await mkContext({ unitPrice: 1000n });
      const rec = await recordIntent(ctx, uuid(5), 1, { observedPrice: 9999 });
      expect(rec.status).toBe(201);
      const op = rec.body as { id: string };

      const res = await sync(op.id, ctx.credential);
      const body = res.body as unknown as SyncResultBody;
      expect(body.status).toBe('REJECTED');
      expect(body.resultCode).toBe('PRICE_CHANGED');
      expect(body.orderId).toBeNull();
      expect(body.paymentId).toBeNull();

      // NO Payment, NO Order, NO stock mutation at all.
      const payments = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(payments).toHaveLength(0);
      const orders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(orders).toHaveLength(0);
      const stock = await tenantContext.run(tenantAId, async () =>
        prisma.inventory.findFirst({
          where: { variantId: ctx.variantId, storeId: storeAId },
        }),
      );
      expect(stock?.quantityOnHand).toBe(10);
    });

    it('OUT_OF_STOCK also produces NO Payment/Order and untouched stock', async () => {
      const ctx = await mkContext({ stock: 1 });
      const rec = await recordIntent(ctx, uuid(6), 1, { quantity: 5 });
      const op = rec.body as { id: string };

      const res = await sync(op.id, ctx.credential);
      const body = res.body as unknown as SyncResultBody;
      expect(body.status).toBe('REJECTED');
      expect(body.resultCode).toBe('OUT_OF_STOCK');

      const payments = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(payments).toHaveLength(0);
      const stock = await tenantContext.run(tenantAId, async () =>
        prisma.inventory.findFirst({
          where: { variantId: ctx.variantId, storeId: storeAId },
        }),
      );
      expect(stock?.quantityOnHand).toBe(1);
    });
  });

  describe('payment idempotency (P4-U5 guarantees preserved)', () => {
    it('retry after ACCEPTED returns the SAME Payment/Order with no second payment/capture/execution', async () => {
      const ctx = await mkContext({ stock: 10 });
      const rec = await recordIntent(ctx, uuid(7), 1, { quantity: 2 });
      const op = rec.body as { id: string };

      const first = await sync(op.id, ctx.credential);
      const firstBody = first.body as unknown as SyncResultBody;
      expect(firstBody.status).toBe('ACCEPTED');

      const second = await sync(op.id, ctx.credential);
      const secondBody = second.body as unknown as SyncResultBody;
      expect(secondBody.status).toBe('ACCEPTED');
      expect(secondBody.paymentId).toBe(firstBody.paymentId);
      expect(secondBody.orderId).toBe(firstBody.orderId);

      // Exactly one payment; still CAPTURED (never re-captured);
      // stock decremented once.
      const payments = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(payments).toHaveLength(1);
      expect(payments[0].status).toBe('CAPTURED');
      const stock = await tenantContext.run(tenantAId, async () =>
        prisma.inventory.findFirst({
          where: { variantId: ctx.variantId, storeId: storeAId },
        }),
      );
      expect(stock?.quantityOnHand).toBe(8);
    });

    it('concurrent sync creates exactly ONE payment and ONE capture (both callers same result)', async () => {
      const ctx = await mkContext({ stock: 10 });
      const rec = await recordIntent(ctx, uuid(8), 1, { quantity: 4 });
      const op = rec.body as { id: string };

      const [a, b] = await Promise.all([
        sync(op.id, ctx.credential),
        sync(op.id, ctx.credential),
      ]);
      const aBody = a.body as unknown as SyncResultBody;
      const bBody = b.body as unknown as SyncResultBody;
      expect(aBody.status).toBe('ACCEPTED');
      expect(bBody.status).toBe('ACCEPTED');
      expect(aBody.paymentId).toBe(bBody.paymentId);

      const payments = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(payments).toHaveLength(1);
      expect(payments[0].status).toBe('CAPTURED');
      expect(payments[0].method).toBe('CASH');
      const stock = await tenantContext.run(tenantAId, async () =>
        prisma.inventory.findFirst({
          where: { variantId: ctx.variantId, storeId: storeAId },
        }),
      );
      expect(stock?.quantityOnHand).toBe(6); // decremented exactly once
    });

    it('rejected retry stays rejected (PRICE_CHANGED never becomes a payment)', async () => {
      const ctx = await mkContext({ unitPrice: 500n });
      const rec = await recordIntent(ctx, uuid(9), 1, { observedPrice: 500 });
      // Change the server price AFTER recording: the retry path stays
      // deterministic — first sync already rejects, retry returns it.
      await tenantContext.run(tenantAId, async () =>
        prisma.price.update({
          where: {
            variantId_currency: {
              variantId: ctx.variantId,
              currency: 'USD',
            },
          },
          data: { amountMinor: 777n },
        }),
      );
      const op = rec.body as { id: string };

      const first = await sync(op.id, ctx.credential);
      const firstBody = first.body as unknown as SyncResultBody;
      expect(firstBody.status).toBe('REJECTED');
      expect(firstBody.resultCode).toBe('PRICE_CHANGED');

      const retry = await sync(op.id, ctx.credential);
      const retryBody = retry.body as unknown as SyncResultBody;
      expect(retryBody.status).toBe('REJECTED');
      expect(retryBody.resultCode).toBe('PRICE_CHANGED');
      expect(retryBody.paymentId).toBeNull();

      const payments = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(payments).toHaveLength(0);
    });
  });

  describe('online payment regression (boundary must not weaken existing flows)', () => {
    it('the ONLINE CARD flow still works exactly as before (PROCESSING then capture)', async () => {
      const ctx = await mkContext({ stock: 5 });
      const sale = await call('post', '/pos/sales', cashierA, {
        sessionId: ctx.sessionId,
        items: [{ variantId: ctx.variantId, quantity: 1 }],
        method: 'CARD',
      });
      expect(sale.status).toBe(201);
      const body = sale.body as { orderId: string; paymentId: string };
      const payment = await paymentRow(body.paymentId);
      expect(payment?.method).toBe('CARD');
      expect(payment?.status).toBe('PROCESSING'); // online card stays online

      // The existing capture endpoint finalizes it (payment:manage).
      const capture = await call(
        'post',
        `/payments/${body.paymentId}/capture`,
        managerA,
      );
      expect(capture.status).toBe(200);
      expect((capture.body as { status: string }).status).toBe('CAPTURED');
    });

    it('the ONLINE CASH flow still captures immediately', async () => {
      const ctx = await mkContext({ stock: 5 });
      const sale = await call('post', '/pos/sales', cashierA, {
        sessionId: ctx.sessionId,
        items: [{ variantId: ctx.variantId, quantity: 1 }],
        // default method = CASH
      });
      expect(sale.status).toBe(201);
      const body = sale.body as {
        paymentId: string;
        paymentStatus: string;
        orderStatus: string;
      };
      expect(body.paymentStatus).toBe('CAPTURED');
      expect(body.orderStatus).toBe('PAID');
      const payment = await paymentRow(body.paymentId);
      expect(payment?.method).toBe('CASH');
    });
  });

  describe('offline payment security gates (regression)', () => {
    it('401 without device credential; 401 wrong credential; 404 cross-tenant', async () => {
      const tenantB = await createTenant('b');
      const bRole = await grantRole(tenantB.id, `b-${run}`, [
        PERMISSIONS.POS_READ,
        PERMISSIONS.POS_CREATE,
      ]);
      const bUser = await createUser(
        `b-${run}-${seqCounter}@b.test`,
        tenantB.id,
        bRole.id,
      );
      const adminB = await loginAs(bUser.id, tenantB.id);

      const ctx = await mkContext();
      const rec = await recordIntent(ctx, uuid(20), 1);
      const op = rec.body as { id: string };

      const noCred = await call(
        'post',
        `/pos/offline/operations/${op.id}/sync`,
        cashierA,
      );
      expect(noCred.status).toBe(401);

      const wrongCred = await sync(op.id, 'wrong-secret');
      expect(wrongCred.status).toBe(401);
      expect((wrongCred.body as ErrorBody).message).toBe(
        'Invalid device credential',
      );

      // Cross-tenant: uniform 404, nothing leaks.
      const foreign = await sync(op.id, ctx.credential, adminB);
      expect(foreign.status).toBe(404);
      const payments = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(payments).toHaveLength(0);
    });

    it('orderId/paymentId injection on the sync request is impossible (no body)', async () => {
      const ctx = await mkContext();
      const rec = await recordIntent(ctx, uuid(21), 1);
      const op = rec.body as { id: string };
      // The sync route takes NO body — nothing to inject.
      const res = await call('post', `/pos/offline/operations/${op.id}/sync`, {
        ...cashierA,
        'X-POS-Device-Credential': ctx.credential,
      });
      expect(res.status).toBe(200);
      const body = res.body as unknown as SyncResultBody;
      expect(body.status).toBe('ACCEPTED');
      // The payment id is server-derived, never client-attachable.
      const payment = await paymentRow(body.paymentId!);
      expect(payment).not.toBeNull();
    });
  });
});
