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
 * Phase 4 P4-U5 — Sync Protocol integration suite.
 *
 * Proves over the REAL stack (full AppModule + supertest + real PostgreSQL):
 * the push protocol (D6 dual authentication: cashier JWT + device
 * credential header verified constant-time against the operation's OWN
 * device; D7 authorization revalidated at sync incl. demotion),
 * deterministic D3 PRICE_CHANGED (exact BigInt, never silent reprice),
 * deterministic D4 OUT_OF_STOCK (all-or-nothing, no partial state),
 * execution through the EXISTING sale engine (Order PAID + Payment
 * CAPTURED + store-stock decrement + PosSale provenance), durable
 * idempotent replays, REAL concurrent sync (exactly one execution, both
 * callers the same durable result), and the D8 pull feed (watermark +
 * tombstones, deterministic resume, tenant isolation).
 */
describe('POS Sync Protocol (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }
  interface SyncResultBody {
    operationId: string;
    clientUuid: string;
    seq: number;
    status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
    resultCode: string | null;
    orderId: string | null;
    paymentId: string | null;
  }
  interface FeedPageBody {
    entries: Array<{ feedSeq: number; kind: string; entityId: string }>;
    nextCursor: number;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `sync-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
    return { user, membership };
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
    method: 'get' | 'post',
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
  let tenantBId: string;
  let storeAId: string;
  let cashierA: Record<string, string>;
  let cashierAId: string;
  let managerA: Record<string, string>;
  let managerAId: string;
  let adminB: Record<string, string>;
  let outsiderId = '';

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
    ]);
    const ownerRole = await grantRole(tenantAId, SYSTEM_ROLE_KEYS.OWNER, []);

    const { user: cashierUser } = await createUser(
      `cashier-${run}-${seqCounter}@a.test`,
      tenantAId,
      cashierRole.id,
    );
    cashierAId = cashierUser.id;
    const { user: managerUser } = await createUser(
      `manager-${run}-${seqCounter}@a.test`,
      tenantAId,
      managerRole.id,
    );
    managerAId = managerUser.id;
    await createUser(
      `owner-${run}-${seqCounter}@a.test`,
      tenantAId,
      ownerRole.id,
    );

    const tenantB = await createTenant('b');
    tenantBId = tenantB.id;
    const adminRoleB = await grantRole(tenantBId, `admin-b-${run}`, [
      PERMISSIONS.POS_READ,
      PERMISSIONS.POS_CREATE,
      PERMISSIONS.POS_MANAGE,
    ]);
    const { user: adminBUser } = await createUser(
      `admin-${run}-${seqCounter}@b.test`,
      tenantBId,
      adminRoleB.id,
    );

    const outsider = await prisma.user.create({
      data: {
        email: `outsider-${run}-${seqCounter}@x.test`,
        passwordHash: 'hash-x',
      },
    });
    userIdsToDelete.push(outsider.id);
    outsiderId = outsider.id;

    cashierA = await loginAs(cashierAId, tenantAId);
    managerA = await loginAs(managerAId, tenantAId);
    adminB = await loginAs(adminBUser.id, tenantBId);
  });

  // ---- Fixture helpers ------------------------------------------------

  /** Registers a device, returning its id + one-time credential. */
  const registerDevice = async (name: string) => {
    const res = await call('post', '/pos/devices', managerA, {
      storeId: storeAId,
      name,
    });
    expect(res.status).toBe(201);
    const body = res.body as { id: string; credential: string };
    return { deviceId: body.id, credential: body.credential };
  };

  /** Opens a session (by the cashier) on the given device. */
  const openSession = async (deviceId: string, headers = cashierA) => {
    const res = await call('post', '/pos/sessions', headers, { deviceId });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };

  /** Full fixture: device + session + catalog variant + store stock. */
  const mkContext = async (
    opts: { unitPrice?: bigint; stock?: number } = {},
  ) => {
    const ctxSeq = ++seqCounter;
    const { deviceId, credential } = await registerDevice(
      `DEV-${run}-${ctxSeq}-${Math.floor(Math.random() * 1e6)}`,
    );
    const session = await openSession(deviceId);

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
    const stock = opts.stock ?? 10;
    await tenantContext.run(tenantAId, async () =>
      prisma.inventory.create({
        data: {
          tenantId: tenantAId,
          variantId: variant.id,
          storeId: storeAId,
          quantityOnHand: stock,
        },
      }),
    );

    return {
      deviceId,
      credential,
      sessionId: session.id,
      variantId: variant.id,
      unitPrice,
      stock,
    };
  };

  const uuid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  /** Records an offline sale intent through the real API. */
  const recordIntent = async (
    ctx: { sessionId: string; variantId: string },
    clientUuid: string,
    seq: number,
    opts: {
      quantity?: number;
      observedPrice?: number;
      currency?: string;
      customerId?: string;
    } = {},
  ) => {
    const res = await call('post', '/pos/offline/operations', cashierA, {
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
      ...(opts.customerId ? { customerId: opts.customerId } : {}),
    });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };

  const syncHeaders = (credential: string, headers = cashierA) => ({
    ...headers,
    'X-POS-Device-Credential': credential,
  });

  const sync = (operationId: string, credential: string, headers = cashierA) =>
    call(
      'post',
      `/pos/offline/operations/${operationId}/sync`,
      syncHeaders(credential, headers),
    );

  const storeStock = (variantId: string) =>
    tenantContext.run(tenantAId, async () =>
      prisma.inventory.findFirst({
        where: { variantId, storeId: storeAId },
      }),
    );

  // ------------------------------------------------------------------
  // Push: authentication + authorization (D6/D7)
  // ------------------------------------------------------------------

  describe('push authentication + authorization (D6/D7)', () => {
    it('401 without cashier JWT; 401 without device credential', async () => {
      const ctx = await mkContext();
      const op = await recordIntent(ctx, uuid(1), 1);
      // No JWT at all.
      expect(
        (
          await call('post', `/pos/offline/operations/${op.id}/sync`, {
            'X-Tenant-ID': tenantAId,
            'X-POS-Device-Credential': ctx.credential,
          })
        ).status,
      ).toBe(401);
      // JWT but no device credential.
      expect((await sync(op.id, '', cashierA)).status).toBe(401);
      const res = await call('post', `/pos/offline/operations/${op.id}/sync`, {
        ...cashierA,
      });
      expect(res.status).toBe(401);
      expect((res.body as ErrorBody).message).toBe('Invalid device credential');
    });

    it('401 with a WRONG device credential (constant-time verify fails)', async () => {
      const ctx = await mkContext();
      const op = await recordIntent(ctx, uuid(2), 1);
      const res = await sync(op.id, 'wrong-secret-entirely');
      expect(res.status).toBe(401);
      expect((res.body as ErrorBody).message).toBe('Invalid device credential');
      // Nothing executed.
      const orders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(orders).toHaveLength(0);
    });

    it('401 when the credential belongs to a DIFFERENT device (mismatch)', async () => {
      const ctx1 = await mkContext();
      const other = await registerDevice(`OTHER-${run}-${seqCounter}`);
      const op = await recordIntent(ctx1, uuid(3), 1);
      const res = await sync(op.id, other.credential);
      expect(res.status).toBe(401);
    });

    it('409 when the operation device is SUSPENDED (revocation at sync)', async () => {
      const ctx = await mkContext();
      const op = await recordIntent(ctx, uuid(4), 1);
      await call('post', `/pos/devices/${ctx.deviceId}/suspend`, managerA);
      const res = await sync(op.id, ctx.credential);
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe('Device is not active');
    });

    it('404 when the caller is NOT the recorded cashier (ownership violation)', async () => {
      const ctx = await mkContext();
      const op = await recordIntent(ctx, uuid(5), 1);
      const res = await sync(op.id, ctx.credential, managerA);
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('POS operation not found');
    });

    it('403 + no execution when the cashier was DEMOTED after recording (D7)', async () => {
      const ctx = await mkContext();
      const op = await recordIntent(ctx, uuid(6), 1);

      // Demote: strip the cashier's pos:create by moving membership to a
      // read-only role.
      const readOnly = await grantRole(tenantAId, `demoted-${run}`, [
        PERMISSIONS.POS_READ,
      ]);
      await tenantContext.run(tenantAId, async () =>
        prisma.membership.update({
          where: {
            userId_tenantId: { userId: cashierAId, tenantId: tenantAId },
          },
          data: { roleId: readOnly.id },
        }),
      );

      const res = await sync(op.id, ctx.credential);
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).message).toBe('Insufficient permissions');
      // Nothing executed.
      const orders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(orders).toHaveLength(0);
      const row = await tenantContext.run(tenantAId, async () =>
        prisma.posOperation.findUniqueOrThrow({ where: { id: op.id } }),
      );
      expect(row.status).toBe('PENDING'); // not silently resolved
    });

    it('401/403 gates: outsider, employee, cross-tenant', async () => {
      const ctx = await mkContext();
      const op = await recordIntent(ctx, uuid(7), 1);

      const outsiderUser = await prisma.user.findUniqueOrThrow({
        where: { id: outsiderId },
      });
      const outsiderHeaders = await loginAs(outsiderUser.id, tenantAId);
      expect((await sync(op.id, ctx.credential, outsiderHeaders)).status).toBe(
        403,
      );

      // Cross-tenant: tenant B admin sees a uniform 404 (no oracle).
      const res = await sync(op.id, ctx.credential, adminB);
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('POS operation not found');
      // Tenant A state untouched.
      const row = await tenantContext.run(tenantAId, async () =>
        prisma.posOperation.findUniqueOrThrow({ where: { id: op.id } }),
      );
      expect(row.status).toBe('PENDING');
    });
  });

  // ------------------------------------------------------------------
  // Push: deterministic validations (D3/D4)
  // ------------------------------------------------------------------

  describe('deterministic validations (D3/D4)', () => {
    it('PRICE_CHANGED: server price differs from the observed snapshot -> REJECTED, nothing executed', async () => {
      const ctx = await mkContext({ unitPrice: 999n });
      const op = await recordIntent(ctx, uuid(10), 1, { observedPrice: 1250 });

      const res = await sync(op.id, ctx.credential);
      expect(res.status).toBe(200);
      const body = res.body as unknown as SyncResultBody;
      expect(body.status).toBe('REJECTED');
      expect(body.resultCode).toBe('PRICE_CHANGED');
      expect(body.orderId).toBeNull();

      // NO execution: no orders/payments, stock untouched.
      const orders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(orders).toHaveLength(0);
      expect((await storeStock(ctx.variantId))?.quantityOnHand).toBe(10);

      // The rejection is durable and immutable: retry returns it unchanged.
      const retry = await sync(op.id, ctx.credential);
      expect((retry.body as unknown as SyncResultBody).status).toBe('REJECTED');
      expect((retry.body as unknown as SyncResultBody).resultCode).toBe(
        'PRICE_CHANGED',
      );
    });

    it('OUT_OF_STOCK: insufficient store stock -> REJECTED all-or-nothing, stock untouched', async () => {
      const ctx = await mkContext({ stock: 1 });
      const op = await recordIntent(ctx, uuid(11), 1, { quantity: 5 });

      const res = await sync(op.id, ctx.credential);
      expect(res.status).toBe(200);
      const body = res.body as unknown as SyncResultBody;
      expect(body.status).toBe('REJECTED');
      expect(body.resultCode).toBe('OUT_OF_STOCK');

      const orders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(orders).toHaveLength(0);
      expect((await storeStock(ctx.variantId))?.quantityOnHand).toBe(1); // untouched
    });

    it('VARIANT_NOT_FOUND: an intent referencing a missing variant is a deterministic rejection', async () => {
      const ctx = await mkContext();
      // Record an intent for a variant that does not exist.
      const res0 = await call('post', '/pos/offline/operations', cashierA, {
        sessionId: ctx.sessionId,
        clientUuid: uuid(12),
        seq: 1,
        items: [
          {
            variantId: 'no-such-variant',
            quantity: 1,
            currency: 'USD',
            observedUnitAmountMinor: 100,
          },
        ],
      });
      expect(res0.status).toBe(201);
      const op = res0.body as { id: string };

      const res = await sync(op.id, ctx.credential);
      expect(res.status).toBe(200);
      expect((res.body as unknown as SyncResultBody).resultCode).toBe(
        'VARIANT_NOT_FOUND',
      );
    });

    it('CURRENCY_MIX: mixed-currency intent is rejected (existing uniform rule)', async () => {
      const ctx = await mkContext();
      // A second variant priced in EUR.
      const cat = await tenantContext.run(tenantAId, async () =>
        prisma.category.create({
          data: { tenantId: tenantAId, name: `CATE-${run}-${seqCounter}` },
        }),
      );
      const prod = await tenantContext.run(tenantAId, async () =>
        prisma.product.create({
          data: {
            tenantId: tenantAId,
            categoryId: cat.id,
            name: `PRODE-${run}-${seqCounter}`,
            code: `CODEE-${run}-${seqCounter}`,
            status: 'ACTIVE',
          },
        }),
      );
      const eurVariant = await tenantContext.run(tenantAId, async () =>
        prisma.productVariant.create({
          data: {
            tenantId: tenantAId,
            productId: prod.id,
            sku: `SKUE-${run}-${seqCounter}`,
          },
        }),
      );
      await tenantContext.run(tenantAId, async () =>
        prisma.price.create({
          data: {
            tenantId: tenantAId,
            variantId: eurVariant.id,
            currency: 'EUR',
            amountMinor: 900n,
          },
        }),
      );

      const res0 = await call('post', '/pos/offline/operations', cashierA, {
        sessionId: ctx.sessionId,
        clientUuid: uuid(13),
        seq: 1,
        items: [
          {
            variantId: ctx.variantId,
            quantity: 1,
            currency: 'USD',
            observedUnitAmountMinor: 1250,
          },
          {
            variantId: eurVariant.id,
            quantity: 1,
            currency: 'EUR',
            observedUnitAmountMinor: 900,
          },
        ],
      });
      expect(res0.status).toBe(201);
      const op = res0.body as { id: string };

      const res = await sync(op.id, ctx.credential);
      expect((res.body as unknown as SyncResultBody).resultCode).toBe(
        'CURRENCY_MIX',
      );
    });
  });

  // ------------------------------------------------------------------
  // Push: execution through the EXISTING sale engine
  // ------------------------------------------------------------------

  describe('execution (existing engine, cash-only D5)', () => {
    it('happy path: ACCEPTED with Order PAID, Payment CAPTURED, stock decremented, provenance', async () => {
      const ctx = await mkContext({ unitPrice: 1250n, stock: 10 });
      const op = await recordIntent(ctx, uuid(20), 1, { quantity: 3 });

      const res = await sync(op.id, ctx.credential);
      expect(res.status).toBe(200);
      const body = res.body as unknown as SyncResultBody;
      expect(body.status).toBe('ACCEPTED');
      expect(body.resultCode).toBeNull();
      expect(body.orderId).not.toBeNull();
      expect(body.paymentId).not.toBeNull();

      // Full durable verification through the existing state machines.
      const orderRow = await tenantContext.run(tenantAId, async () =>
        prisma.order.findUniqueOrThrow({ where: { id: body.orderId! } }),
      );
      expect(orderRow.status).toBe('PAID');
      expect(orderRow.subtotalMinor).toBe(3750n); // 3 * 1250 server price
      const paymentRow = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findUniqueOrThrow({ where: { id: body.paymentId! } }),
      );
      expect(paymentRow.status).toBe('CAPTURED');
      expect(paymentRow.method).toBe('CASH'); // D5 cash-only
      expect(paymentRow.amountMinor).toBe(3750n);

      // Store pool decremented exactly the quantity.
      expect((await storeStock(ctx.variantId))?.quantityOnHand).toBe(7);

      // PosSale provenance links order/payment to the session context.
      const saleRow = await tenantContext.run(tenantAId, async () =>
        prisma.posSale.findUniqueOrThrow({
          where: { orderId: body.orderId! },
        }),
      );
      expect(saleRow.sessionId).toBe(ctx.sessionId);
      expect(saleRow.storeId).toBe(storeAId);

      // The operation's durable result is persisted.
      const opRow = await tenantContext.run(tenantAId, async () =>
        prisma.posOperation.findUniqueOrThrow({ where: { id: op.id } }),
      );
      expect(opRow.status).toBe('ACCEPTED');
      expect(opRow.resultOrderId).toBe(body.orderId);
      expect(opRow.resultPaymentId).toBe(body.paymentId);
      expect(opRow.processedAt).not.toBeNull();
    });

    it('retry after ACCEPTED returns the durable result WITHOUT a second execution', async () => {
      const ctx = await mkContext({ stock: 10 });
      const op = await recordIntent(ctx, uuid(21), 1, { quantity: 2 });

      const first = await sync(op.id, ctx.credential);
      const firstBody = first.body as unknown as SyncResultBody;
      expect(firstBody.status).toBe('ACCEPTED');

      const second = await sync(op.id, ctx.credential);
      const secondBody = second.body as unknown as SyncResultBody;
      expect(secondBody.status).toBe('ACCEPTED');
      expect(secondBody.orderId).toBe(firstBody.orderId); // same durable ids
      expect(secondBody.paymentId).toBe(firstBody.paymentId);

      // Exactly one order/payment/sale; stock decremented once.
      const orders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(orders).toHaveLength(1);
      const payments = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(payments).toHaveLength(1);
      expect((await storeStock(ctx.variantId))?.quantityOnHand).toBe(8);
    });

    it('a CLOSED historical session still syncs (provenance retained; authority revalidated)', async () => {
      const ctx = await mkContext();
      const op = await recordIntent(ctx, uuid(22), 1);
      // Close the shift AFTER the intent was recorded.
      await call('post', `/pos/sessions/${ctx.sessionId}/close`, managerA);

      const res = await sync(op.id, ctx.credential);
      expect(res.status).toBe(200);
      expect((res.body as unknown as SyncResultBody).status).toBe('ACCEPTED');
    });

    it('two DIFFERENT operations from the same device sync independently; different devices too', async () => {
      const ctx = await mkContext({ stock: 20 });
      const op1 = await recordIntent(ctx, uuid(23), 1, { quantity: 1 });
      const op2 = await recordIntent(ctx, uuid(24), 2, { quantity: 1 });

      const r1 = await sync(op1.id, ctx.credential);
      const r2 = await sync(op2.id, ctx.credential);
      expect((r1.body as unknown as SyncResultBody).status).toBe('ACCEPTED');
      expect((r2.body as unknown as SyncResultBody).status).toBe('ACCEPTED');
      expect((r1.body as unknown as SyncResultBody).orderId).not.toBe(
        (r2.body as unknown as SyncResultBody).orderId,
      );
      expect((await storeStock(ctx.variantId))?.quantityOnHand).toBe(18);

      // A second device + session records and syncs its own op.
      const ctx2 = await mkContext({ stock: 5 });
      const op3 = await recordIntent(ctx2, uuid(25), 1, { quantity: 1 });
      const r3 = await sync(op3.id, ctx2.credential);
      expect((r3.body as unknown as SyncResultBody).status).toBe('ACCEPTED');
      expect((await storeStock(ctx2.variantId))?.quantityOnHand).toBe(4);
    });
  });

  // ------------------------------------------------------------------
  // Concurrent sync (the mandatory race)
  // ------------------------------------------------------------------

  describe('concurrent sync (deterministic, DB-arbitrated)', () => {
    it('two concurrent syncs: exactly one execution; both callers the SAME durable result', async () => {
      const ctx = await mkContext({ stock: 10 });
      const op = await recordIntent(ctx, uuid(30), 1, { quantity: 4 });

      const [a, b] = await Promise.all([
        sync(op.id, ctx.credential),
        sync(op.id, ctx.credential),
      ]);

      const aBody = a.body as unknown as SyncResultBody;
      const bBody = b.body as unknown as SyncResultBody;

      // Both callers receive the SAME durable result.
      expect(aBody.status).toBe('ACCEPTED');
      expect(bBody.status).toBe('ACCEPTED');
      expect(aBody.orderId).toBe(bBody.orderId);
      expect(aBody.paymentId).toBe(bBody.paymentId);

      // EXACTLY one execution: one order, one payment, one sale.
      const orders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(orders).toHaveLength(1);
      const payments = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(payments).toHaveLength(1);
      // Stock decremented exactly once: 10 -> 6, never 2.
      expect((await storeStock(ctx.variantId))?.quantityOnHand).toBe(6);
    });
  });

  // ------------------------------------------------------------------
  // Pull feed (D8)
  // ------------------------------------------------------------------

  describe('pull feed (D8: watermark + tombstones)', () => {
    it('returns ordered entries above the cursor; deterministic resume; tenant isolation', async () => {
      // Seed the feed for tenant A with real rows.
      const seed = [1, 2, 3].map((n) => ({ feedSeq: n }));
      for (const s of seed) {
        await tenantContext.run(tenantAId, async () =>
          prisma.posFeedEvent.create({
            data: {
              tenantId: tenantAId,
              feedSeq: s.feedSeq,
              kind: 'PRODUCT',
              entityId: `p-${s.feedSeq}`,
            },
          }),
        );
      }
      // And one row for tenant B (must never leak).
      await tenantContext.run(tenantBId, async () =>
        prisma.posFeedEvent.create({
          data: {
            tenantId: tenantBId,
            feedSeq: 1,
            kind: 'DELETED',
            entityId: 'b-only',
          },
        }),
      );

      const page1 = await call('get', '/pos/feed?since=0', cashierA);
      expect(page1.status).toBe(200);
      const body1 = page1.body as unknown as FeedPageBody;
      expect(body1.entries).toHaveLength(3);
      expect(body1.entries.map((e) => e.feedSeq)).toEqual([1, 2, 3]);
      expect(body1.nextCursor).toBe(3);
      // Tenant B's rows are absent (tenant-scoped feed).
      expect(body1.entries.every((e) => e.entityId !== 'b-only')).toBe(true);

      // Deterministic resume: since=3 returns nothing new.
      const page2 = await call(
        'get',
        `/pos/feed?since=${body1.nextCursor}`,
        cashierA,
      );
      const body2 = page2.body as unknown as FeedPageBody;
      expect(body2.entries).toHaveLength(0);
      expect(body2.nextCursor).toBe(3);

      // A new event appears above the cursor.
      await tenantContext.run(tenantAId, async () =>
        prisma.posFeedEvent.create({
          data: {
            tenantId: tenantAId,
            feedSeq: 4,
            kind: 'DELETED', // a tombstone
            entityId: 'p-2',
          },
        }),
      );
      const page3 = await call('get', `/pos/feed?since=3`, cashierA);
      const body3 = page3.body as unknown as FeedPageBody;
      expect(body3.entries).toHaveLength(1);
      expect(body3.entries[0].kind).toBe('DELETED');
      expect(body3.nextCursor).toBe(4);
    });

    it('403/404 gates: employee read-only CAN pull (pos:read); tenant isolation holds', async () => {
      // Cashier (pos:read) pulls fine — verified above; tenant B's admin
      // pulling sees ONLY tenant B rows (cross-check the isolation).
      const page = await call('get', '/pos/feed?since=0', adminB);
      expect(page.status).toBe(200);
      const body = page.body as unknown as FeedPageBody;
      expect(body.entries.every((e) => e.entityId === 'b-only')).toBe(true);
    });
  });
});
