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
 * Phase 3 U7 CP7 — Payment integration suite.
 *
 * Exercises the real HTTP endpoints (POST /payments, GET /payments/:id,
 * POST /payments/:id/capture, POST /payments/:id/fail) against the real
 * database, mirroring the order.integration.spec.ts architecture:
 * tenantA/B fixtures, role grants, supertest through the full AppModule.
 *
 * Covered: authentication gates, RBAC matrix (payment:read/create/manage,
 * admin/employee/owner semantics), tenant isolation + IDOR (uniform 404),
 * T5 creation invariants (amount/currency derived from Order, BigInt as
 * strings), T2 capture/fail state machine, idempotent terminal states,
 * transaction rollback (no partial CAPTURED/CANCELLED state), and real
 * concurrent-capture arbitration via guarded updateMany.
 */
describe('Payment (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }
  interface PaymentBody {
    id: string;
    tenantId: string;
    orderId: string;
    status: string;
    method: string;
    amountMinor: string;
    currency: string;
    createdAt: string;
    updatedAt: string;
  }
  interface OrderBody {
    id: string;
    status: string;
    currency: string;
    subtotalMinor: string;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `pay-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

  const createCategory = async (tenantId: string, name: string) =>
    tenantContext.run(tenantId, async () =>
      prisma.category.create({ data: { tenantId, name } }),
    );

  const createProduct = async (
    tenantId: string,
    categoryId: string,
    code: string,
  ) =>
    tenantContext.run(tenantId, async () =>
      prisma.product.create({
        data: { tenantId, categoryId, code, name: code, status: 'ACTIVE' },
      }),
    );

  const createVariant = async (
    tenantId: string,
    productId: string,
    sku: string,
  ) =>
    tenantContext.run(tenantId, async () =>
      prisma.productVariant.create({ data: { tenantId, productId, sku } }),
    );

  const createPrice = async (
    tenantId: string,
    variantId: string,
    currency: string,
    amountMinor: bigint,
  ) =>
    tenantContext.run(tenantId, async () =>
      prisma.price.create({
        data: { tenantId, variantId, currency, amountMinor },
      }),
    );

  const createInventory = async (
    tenantId: string,
    variantId: string,
    quantity: number,
  ) =>
    tenantContext.run(tenantId, async () =>
      prisma.inventory.create({
        data: { tenantId, variantId, quantityOnHand: quantity },
      }),
    );

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
      await prisma.payment
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.orderItem
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.order
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.cartItem
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.cart
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
      await prisma.tenant
        .deleteMany({ where: { id: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
    }
    if (app) await app.close();
  });

  let tenantAId: string;
  let tenantBId: string;
  let adminAId: string;
  let employeeAId: string;
  let ownerAId: string;
  let adminBId: string;

  let adminA: Record<string, string>;
  let employeeA: Record<string, string>;
  let ownerA: Record<string, string>;
  let adminB: Record<string, string>;

  let variantAId: string;
  let variantBId: string;

  let seq = 0;

  beforeEach(async () => {
    seq += 1;
    const tenantA = await createTenant('a');
    tenantAId = tenantA.id;
    const adminRole = await grantRole(tenantAId, `admin-a-${run}`, [
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.ORDER_CREATE,
      PERMISSIONS.ORDER_DELETE,
      PERMISSIONS.PAYMENT_READ,
      PERMISSIONS.PAYMENT_CREATE,
      PERMISSIONS.PAYMENT_MANAGE,
    ]);
    const employeeRole = await grantRole(tenantAId, `employee-a-${run}`, [
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.ORDER_CREATE,
      PERMISSIONS.PAYMENT_CREATE,
    ]);
    const ownerRole = await grantRole(tenantAId, SYSTEM_ROLE_KEYS.OWNER, []);

    adminAId = (
      await createUser(`admin-${run}-${seq}@a.test`, tenantAId, adminRole.id)
    ).id;
    employeeAId = (
      await createUser(
        `employee-${run}-${seq}@a.test`,
        tenantAId,
        employeeRole.id,
      )
    ).id;
    ownerAId = (
      await createUser(`owner-${run}-${seq}@a.test`, tenantAId, ownerRole.id)
    ).id;

    const tenantB = await createTenant('b');
    tenantBId = tenantB.id;
    const adminRoleB = await grantRole(tenantBId, `admin-b-${run}`, [
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.ORDER_CREATE,
      PERMISSIONS.PAYMENT_READ,
      PERMISSIONS.PAYMENT_CREATE,
      PERMISSIONS.PAYMENT_MANAGE,
    ]);
    adminBId = (
      await createUser(`admin-${run}-${seq}@b.test`, tenantBId, adminRoleB.id)
    ).id;

    const outsider = await prisma.user.create({
      data: { email: `outsider-${run}-${seq}@x.test`, passwordHash: 'hash-x' },
    });
    userIdsToDelete.push(outsider.id);

    adminA = await loginAs(adminAId, tenantAId);
    employeeA = await loginAs(employeeAId, tenantAId);
    ownerA = await loginAs(ownerAId, tenantAId);
    adminB = await loginAs(adminBId, tenantBId);

    const catA = await createCategory(tenantAId, `CAT-A-${run}-${seq}`);
    const pA = await createProduct(tenantAId, catA.id, `PROD-A-${run}-${seq}`);
    const vA = await createVariant(tenantAId, pA.id, `SKU-A-${run}-${seq}`);
    variantAId = vA.id;
    await createPrice(tenantAId, variantAId, 'USD', 1000n);
    await createInventory(tenantAId, variantAId, 50);

    const catB = await createCategory(tenantBId, `CAT-B-${run}-${seq}`);
    const pB = await createProduct(tenantBId, catB.id, `PROD-B-${run}-${seq}`);
    const vB = await createVariant(tenantBId, pB.id, `SKU-B-${run}-${seq}`);
    variantBId = vB.id;
    await createPrice(tenantBId, variantBId, 'USD', 500n);
    await createInventory(tenantBId, variantBId, 20);
  });

  // ---- API convenience helpers (real HTTP, real DB) ----

  const createOrderViaApi = async (
    headers: Record<string, string>,
    quantity = 2,
    variantId?: string,
  ): Promise<OrderBody> => {
    const res = await call('post', '/orders', headers, {
      items: [{ variantId: variantId ?? variantAId, quantity }],
    });
    expect(res.status).toBe(201);
    return res.body as unknown as OrderBody;
  };

  const createPaymentViaApi = async (
    headers: Record<string, string>,
    orderId: string,
    method = 'CARD',
  ): Promise<PaymentBody> => {
    const res = await call('post', '/payments', headers, { orderId, method });
    expect(res.status).toBe(201);
    return res.body as unknown as PaymentBody;
  };

  // NOTE: per the tenant-scoping extension contract, the Prisma await MUST
  // happen inside the tenantContext.run callback (async callback) — a bare
  // () => arrow would return an unawaited PrismaPromise that resolves
  // outside the AsyncLocalStorage context and fail closed.
  const getPaymentRow = (paymentId: string) =>
    tenantContext.run(tenantAId, async () =>
      prisma.payment.findUnique({ where: { id: paymentId } }),
    );

  const getOrderRow = (orderId: string) =>
    tenantContext.run(tenantAId, async () =>
      prisma.order.findUnique({ where: { id: orderId } }),
    );

  describe('authentication and authorization gates', () => {
    it('rejects unauthenticated with 401', async () => {
      expect((await call('get', '/payments/some-id', {})).status).toBe(401);
      expect(
        (
          await call(
            'post',
            '/payments',
            {},
            {
              orderId: 'x',
              method: 'CARD',
            },
          )
        ).status,
      ).toBe(401);
      expect((await call('post', '/payments/some-id/capture', {})).status).toBe(
        401,
      );
      expect((await call('post', '/payments/some-id/fail', {})).status).toBe(
        401,
      );
    });

    it('rejects outsider without membership with 403', async () => {
      const outsiderUser = await prisma.user.findUniqueOrThrow({
        where: { email: `outsider-${run}-${seq}@x.test` },
      });
      const headers = await loginAs(outsiderUser.id, tenantAId);
      expect((await call('get', '/payments/some-id', headers)).status).toBe(
        403,
      );
      expect(
        (
          await call('post', '/payments', headers, {
            orderId: 'x',
            method: 'CARD',
          })
        ).status,
      ).toBe(403);
      expect(
        (await call('post', '/payments/some-id/capture', headers)).status,
      ).toBe(403);
      expect(
        (await call('post', '/payments/some-id/fail', headers)).status,
      ).toBe(403);
    });

    it('rejects member without payment:read with 403 on GET', async () => {
      const noReadRole = await grantRole(tenantAId, `noread-${run}`, [
        PERMISSIONS.PAYMENT_CREATE,
      ]);
      const noReadUser = await createUser(
        `noread-${run}@a.test`,
        tenantAId,
        noReadRole.id,
      );
      const headers = await loginAs(noReadUser.id, tenantAId);
      expect((await call('get', '/payments/some-id', headers)).status).toBe(
        403,
      );
    });

    it('rejects member without payment:create with 403 on POST', async () => {
      const noCreateRole = await grantRole(tenantAId, `nocreate-${run}`, [
        PERMISSIONS.PAYMENT_READ,
      ]);
      const noCreateUser = await createUser(
        `nocreate-${run}@a.test`,
        tenantAId,
        noCreateRole.id,
      );
      const headers = await loginAs(noCreateUser.id, tenantAId);
      expect(
        (
          await call('post', '/payments', headers, {
            orderId: 'x',
            method: 'CARD',
          })
        ).status,
      ).toBe(403);
    });

    it('rejects member without payment:manage with 403 on capture and fail', async () => {
      const noManageRole = await grantRole(tenantAId, `nomanage-${run}`, [
        PERMISSIONS.PAYMENT_READ,
        PERMISSIONS.PAYMENT_CREATE,
      ]);
      const noManageUser = await createUser(
        `nomanage-${run}@a.test`,
        tenantAId,
        noManageRole.id,
      );
      const headers = await loginAs(noManageUser.id, tenantAId);
      expect(
        (await call('post', '/payments/some-id/capture', headers)).status,
      ).toBe(403);
      expect(
        (await call('post', '/payments/some-id/fail', headers)).status,
      ).toBe(403);
    });

    it('manage-only can capture but cannot read or create', async () => {
      const order = await createOrderViaApi(adminA);
      const payment = await createPaymentViaApi(adminA, order.id);

      const manageOnlyRole = await grantRole(tenantAId, `manageonly-${run}`, [
        PERMISSIONS.PAYMENT_MANAGE,
      ]);
      const manageOnlyUser = await createUser(
        `manageonly-${run}@a.test`,
        tenantAId,
        manageOnlyRole.id,
      );
      const headers = await loginAs(manageOnlyUser.id, tenantAId);

      expect(
        (await call('get', `/payments/${payment.id}`, headers)).status,
      ).toBe(403);
      expect(
        (
          await call('post', '/payments', headers, {
            orderId: order.id,
            method: 'CARD',
          })
        ).status,
      ).toBe(403);
      const capture = await call(
        'post',
        `/payments/${payment.id}/capture`,
        headers,
      );
      expect(capture.status).toBe(200);
      expect((capture.body as PaymentBody).status).toBe('CAPTURED');
    });

    it('employee can create orders and payments but cannot capture or fail', async () => {
      const order = await createOrderViaApi(employeeA);
      const payment = await createPaymentViaApi(employeeA, order.id, 'CASH');
      expect(payment.status).toBe('PROCESSING');

      expect(
        (await call('get', `/payments/${payment.id}`, employeeA)).status,
      ).toBe(403);
      expect(
        (await call('post', `/payments/${payment.id}/capture`, employeeA))
          .status,
      ).toBe(403);
      expect(
        (await call('post', `/payments/${payment.id}/fail`, employeeA)).status,
      ).toBe(403);
    });

    it('owner semantic-all works without explicit grants', async () => {
      const order = await createOrderViaApi(ownerA);
      const payment = await createPaymentViaApi(ownerA, order.id);
      expect(
        (await call('get', `/payments/${payment.id}`, ownerA)).status,
      ).toBe(200);
      const capture = await call(
        'post',
        `/payments/${payment.id}/capture`,
        ownerA,
      );
      expect(capture.status).toBe(200);
      expect((capture.body as PaymentBody).status).toBe('CAPTURED');
      const orderAfter = await call('get', `/orders/${order.id}`, ownerA);
      expect((orderAfter.body as OrderBody).status).toBe('PAID');
    });
  });

  describe('createPayment (T5)', () => {
    it('creates PROCESSING payment deriving amount/currency/method from order', async () => {
      const order = await createOrderViaApi(adminA, 3); // subtotal 3000
      const payment = await createPaymentViaApi(adminA, order.id, 'CARD');

      expect(payment.status).toBe('PROCESSING');
      expect(payment.orderId).toBe(order.id);
      expect(payment.tenantId).toBe(tenantAId);
      expect(payment.method).toBe('CARD');
      expect(payment.currency).toBe('USD');
      expect(payment.amountMinor).toBe('3000');
      // BigInt money is serialized as a JSON string
      expect(typeof payment.amountMinor).toBe('string');
    });

    it('derives currency from order for EUR-priced variants', async () => {
      const cat = await createCategory(tenantAId, `CAT-EUR-${run}-${seq}`);
      const prod = await createProduct(
        tenantAId,
        cat.id,
        `PROD-EUR-${run}-${seq}`,
      );
      const vEur = await createVariant(
        tenantAId,
        prod.id,
        `SKU-EUR-${run}-${seq}`,
      );
      await createPrice(tenantAId, vEur.id, 'EUR', 2500n);
      await createInventory(tenantAId, vEur.id, 5);

      const order = await createOrderViaApi(adminA, 2, vEur.id);
      expect(order.currency).toBe('EUR');
      expect(order.subtotalMinor).toBe('5000');

      const payment = await createPaymentViaApi(adminA, order.id);
      expect(payment.currency).toBe('EUR');
      expect(payment.amountMinor).toBe('5000');
    });

    it('rejects unknown order with 404', async () => {
      const res = await call('post', '/payments', adminA, {
        orderId: 'no-such-order',
        method: 'CARD',
      });
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Order not found');
    });

    it('rejects foreign order from other tenant with 404', async () => {
      const orderB = await createOrderViaApi(adminB, 1, variantBId);
      const res = await call('post', '/payments', adminA, {
        orderId: orderB.id,
        method: 'CARD',
      });
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Order not found');
    });

    it('rejects non-PENDING (cancelled) order with 409', async () => {
      const order = await createOrderViaApi(adminA);
      const cancel = await call('post', `/orders/${order.id}/cancel`, adminA);
      expect(cancel.status).toBe(200);

      const res = await call('post', '/payments', adminA, {
        orderId: order.id,
        method: 'CARD',
      });
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe('Order is not pending');
    });

    it('rejects when a CAPTURED payment already exists with 409', async () => {
      const order = await createOrderViaApi(adminA);
      const payment = await createPaymentViaApi(adminA, order.id);
      const capture = await call(
        'post',
        `/payments/${payment.id}/capture`,
        adminA,
      );
      expect(capture.status).toBe(200);

      const res = await call('post', '/payments', adminA, {
        orderId: order.id,
        method: 'CARD',
      });
      expect(res.status).toBe(409);
      // The service validates Order PENDING before the duplicate-CAPTURED
      // guard (CP4 check order), so after a capture the Order-PENDING check
      // fires first. Both documented T5 rejections return 409; either
      // message proves the duplicate payment was refused.
      const message = (res.body as ErrorBody).message;
      expect([
        'Order is not pending',
        'Payment already captured for this order',
      ]).toContain(message);
    });

    it('allows multiple PROCESSING payments for the same order', async () => {
      const order = await createOrderViaApi(adminA);
      const first = await createPaymentViaApi(adminA, order.id, 'CARD');
      const second = await createPaymentViaApi(adminA, order.id, 'CASH');

      expect(first.status).toBe('PROCESSING');
      expect(second.status).toBe('PROCESSING');
      expect(first.id).not.toBe(second.id);

      const rows = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findMany({ where: { orderId: order.id } }),
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === 'PROCESSING')).toBe(true);
    });

    it('rejects missing/invalid create payloads with 400', async () => {
      const cases: Array<Record<string, unknown>> = [
        {},
        { method: 'CARD' },
        { orderId: 'order-1' },
        { orderId: '', method: 'CARD' },
        { orderId: 'order-1', method: '' },
        { orderId: 'order-1', method: 'x'.repeat(51) },
        { orderId: 'order-1', method: 123 },
      ];
      for (const payload of cases) {
        const res = await call('post', '/payments', adminA, payload);
        expect(res.status).toBe(400);
      }
    });

    it('rejects injected tenantId/amountMinor/currency/status/id/timestamps and unknown fields with 400', async () => {
      const injections: Array<Record<string, unknown>> = [
        { orderId: 'o', method: 'CARD', tenantId: tenantBId },
        { orderId: 'o', method: 'CARD', amountMinor: 100 },
        { orderId: 'o', method: 'CARD', currency: 'USD' },
        { orderId: 'o', method: 'CARD', status: 'CAPTURED' },
        { orderId: 'o', method: 'CARD', id: 'payment-1' },
        { orderId: 'o', method: 'CARD', createdAt: new Date().toISOString() },
        { orderId: 'o', method: 'CARD', bogus: true },
      ];
      for (const payload of injections) {
        const res = await call('post', '/payments', adminA, payload);
        expect(res.status).toBe(400);
      }
    });
  });

  describe('getPayment', () => {
    it('returns payment by id with correct shape and string BigInt amount', async () => {
      const order = await createOrderViaApi(adminA, 2);
      const payment = await createPaymentViaApi(adminA, order.id);

      const res = await call('get', `/payments/${payment.id}`, adminA);
      expect(res.status).toBe(200);
      const body = res.body as PaymentBody;
      expect(body.id).toBe(payment.id);
      expect(body.orderId).toBe(order.id);
      expect(body.status).toBe('PROCESSING');
      expect(body.amountMinor).toBe('2000');
      expect(typeof body.amountMinor).toBe('string');
      expect(body.currency).toBe('USD');
    });

    it('rejects unknown payment with 404', async () => {
      const res = await call('get', '/payments/no-such-payment', adminA);
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Payment not found');
    });

    it('rejects cross-tenant payment with 404 while same-tenant access works', async () => {
      const orderB = await createOrderViaApi(adminB, 1, variantBId);
      const paymentB = await createPaymentViaApi(adminB, orderB.id);

      // Same tenant can read it
      const own = await call('get', `/payments/${paymentB.id}`, adminB);
      expect(own.status).toBe(200);

      // Foreign tenant gets the uniform 404 (no existence oracle)
      const foreign = await call('get', `/payments/${paymentB.id}`, adminA);
      expect(foreign.status).toBe(404);
      expect((foreign.body as ErrorBody).message).toBe('Payment not found');
    });
  });

  describe('centralized tenant scoping', () => {
    it('direct prisma reads are scoped by the ambient tenant context', async () => {
      const order = await createOrderViaApi(adminA);
      const payment = await createPaymentViaApi(adminA, order.id);

      // Visible inside tenant A context (extension injects tenantId)...
      const inA = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findUnique({ where: { id: payment.id } }),
      );
      expect(inA?.id).toBe(payment.id);
      expect(inA?.tenantId).toBe(tenantAId);

      // ...and invisible inside tenant B context: the extension merges
      // tenantId into the where clause, so the row resolves to null.
      const inB = await tenantContext.run(tenantBId, async () =>
        prisma.payment.findUnique({ where: { id: payment.id } }),
      );
      expect(inB).toBeNull();
    });
  });

  describe('capturePayment (T2)', () => {
    it('captures PROCESSING payment and marks order PAID atomically', async () => {
      const order = await createOrderViaApi(adminA, 2);
      const payment = await createPaymentViaApi(adminA, order.id);

      const res = await call('post', `/payments/${payment.id}/capture`, adminA);
      expect(res.status).toBe(200);
      const body = res.body as PaymentBody;
      expect(body.status).toBe('CAPTURED');
      expect(body.amountMinor).toBe('2000');

      // Order flipped to PAID via the API
      const orderAfter = await call('get', `/orders/${order.id}`, adminA);
      expect((orderAfter.body as OrderBody).status).toBe('PAID');

      // Verified directly in the database (BigInt column intact)
      const paymentRow = await getPaymentRow(payment.id);
      expect(paymentRow?.status).toBe('CAPTURED');
      expect(paymentRow?.amountMinor).toBe(2000n);
      expect(paymentRow?.currency).toBe('USD');
      const orderRow = await getOrderRow(order.id);
      expect(orderRow?.status).toBe('PAID');
    });

    it('rolls back the payment update when the order is no longer PENDING', async () => {
      const order = await createOrderViaApi(adminA, 2);
      const payment = await createPaymentViaApi(adminA, order.id);

      // Cancel the order while the payment is PROCESSING; the guarded
      // Order update inside the capture transaction then matches 0 rows.
      const cancel = await call('post', `/orders/${order.id}/cancel`, adminA);
      expect(cancel.status).toBe(200);

      const res = await call('post', `/payments/${payment.id}/capture`, adminA);
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe('Order is not pending');

      // The transaction rolled back: NO partial CAPTURED/CANCELLED state.
      const paymentRow = await getPaymentRow(payment.id);
      expect(paymentRow?.status).toBe('PROCESSING');
      const orderRow = await getOrderRow(order.id);
      expect(orderRow?.status).toBe('CANCELLED');
    });

    it('rejects capture of FAILED payment with 409 and leaves state unchanged', async () => {
      const order = await createOrderViaApi(adminA);
      const payment = await createPaymentViaApi(adminA, order.id);
      const fail = await call('post', `/payments/${payment.id}/fail`, adminA);
      expect(fail.status).toBe(200);

      const res = await call('post', `/payments/${payment.id}/capture`, adminA);
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe(
        'Failed payment cannot be captured',
      );

      const paymentRow = await getPaymentRow(payment.id);
      expect(paymentRow?.status).toBe('FAILED');
      const orderRow = await getOrderRow(order.id);
      expect(orderRow?.status).toBe('PENDING');
    });

    it('idempotent re-capture returns CAPTURED without further state changes', async () => {
      const order = await createOrderViaApi(adminA);
      const payment = await createPaymentViaApi(adminA, order.id);

      const first = await call(
        'post',
        `/payments/${payment.id}/capture`,
        adminA,
      );
      expect(first.status).toBe(200);

      const second = await call(
        'post',
        `/payments/${payment.id}/capture`,
        adminA,
      );
      expect(second.status).toBe(200);
      expect((second.body as PaymentBody).status).toBe('CAPTURED');
      expect((second.body as PaymentBody).id).toBe(payment.id);

      const paymentRow = await getPaymentRow(payment.id);
      expect(paymentRow?.status).toBe('CAPTURED');
      const orderRow = await getOrderRow(order.id);
      expect(orderRow?.status).toBe('PAID');
    });

    it('rejects capture of unknown payment with 404', async () => {
      const res = await call(
        'post',
        '/payments/no-such-payment/capture',
        adminA,
      );
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Payment not found');
    });

    it('rejects capture of cross-tenant payment with 404', async () => {
      const orderB = await createOrderViaApi(adminB, 1, variantBId);
      const paymentB = await createPaymentViaApi(adminB, orderB.id);

      const res = await call(
        'post',
        `/payments/${paymentB.id}/capture`,
        adminA,
      );
      expect(res.status).toBe(404);

      // Tenant B's state is untouched
      const rowB = await tenantContext.run(tenantBId, async () =>
        prisma.payment.findUnique({ where: { id: paymentB.id } }),
      );
      expect(rowB?.status).toBe('PROCESSING');
    });
  });

  describe('failPayment (T2)', () => {
    it('fails PROCESSING payment and leaves order PENDING', async () => {
      const order = await createOrderViaApi(adminA, 2);
      const payment = await createPaymentViaApi(adminA, order.id);

      const res = await call('post', `/payments/${payment.id}/fail`, adminA);
      expect(res.status).toBe(200);
      const body = res.body as PaymentBody;
      expect(body.status).toBe('FAILED');

      // Order stays PENDING — fail never touches the Order row
      const orderAfter = await call('get', `/orders/${order.id}`, adminA);
      expect((orderAfter.body as OrderBody).status).toBe('PENDING');

      const paymentRow = await getPaymentRow(payment.id);
      expect(paymentRow?.status).toBe('FAILED');
      const orderRow = await getOrderRow(order.id);
      expect(orderRow?.status).toBe('PENDING');
    });

    it('rejects fail of CAPTURED payment with 409 and leaves state unchanged', async () => {
      const order = await createOrderViaApi(adminA);
      const payment = await createPaymentViaApi(adminA, order.id);
      const capture = await call(
        'post',
        `/payments/${payment.id}/capture`,
        adminA,
      );
      expect(capture.status).toBe(200);

      const res = await call('post', `/payments/${payment.id}/fail`, adminA);
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe(
        'Captured payment cannot be failed',
      );

      const paymentRow = await getPaymentRow(payment.id);
      expect(paymentRow?.status).toBe('CAPTURED');
      const orderRow = await getOrderRow(order.id);
      expect(orderRow?.status).toBe('PAID');
    });

    it('idempotent re-fail returns FAILED without further state changes', async () => {
      const order = await createOrderViaApi(adminA);
      const payment = await createPaymentViaApi(adminA, order.id);

      const first = await call('post', `/payments/${payment.id}/fail`, adminA);
      expect(first.status).toBe(200);

      const second = await call('post', `/payments/${payment.id}/fail`, adminA);
      expect(second.status).toBe(200);
      expect((second.body as PaymentBody).status).toBe('FAILED');

      const paymentRow = await getPaymentRow(payment.id);
      expect(paymentRow?.status).toBe('FAILED');
      const orderRow = await getOrderRow(order.id);
      expect(orderRow?.status).toBe('PENDING');
    });

    it('rejects fail of unknown payment with 404', async () => {
      const res = await call('post', '/payments/no-such-payment/fail', adminA);
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Payment not found');
    });

    it('rejects fail of cross-tenant payment with 404', async () => {
      const orderB = await createOrderViaApi(adminB, 1, variantBId);
      const paymentB = await createPaymentViaApi(adminB, orderB.id);

      const res = await call('post', `/payments/${paymentB.id}/fail`, adminA);
      expect(res.status).toBe(404);

      const rowB = await tenantContext.run(tenantBId, async () =>
        prisma.payment.findUnique({ where: { id: paymentB.id } }),
      );
      expect(rowB?.status).toBe('PROCESSING');
    });
  });

  describe('concurrency and atomicity', () => {
    it('two concurrent captures: exactly one transition, final state CAPTURED + PAID', async () => {
      const order = await createOrderViaApi(adminA, 2);
      const payment = await createPaymentViaApi(adminA, order.id);

      const [a, b] = await Promise.all([
        call('post', `/payments/${payment.id}/capture`, adminA),
        call('post', `/payments/${payment.id}/capture`, adminA),
      ]);

      // Exactly one guarded update wins. The loser either observes the
      // terminal state (idempotent 200) or fails its guarded update (409);
      // a 500 or corrupted state must never occur.
      for (const res of [a, b]) {
        expect(res.status === 200 || res.status === 409).toBe(true);
      }
      expect(a.status === 200 || b.status === 200).toBe(true);

      const paymentRow = await getPaymentRow(payment.id);
      expect(paymentRow?.status).toBe('CAPTURED');
      const orderRow = await getOrderRow(order.id);
      expect(orderRow?.status).toBe('PAID');
    });

    it('concurrent capture vs fail: exactly one transition wins and the final state is consistent', async () => {
      const order = await createOrderViaApi(adminA, 2);
      const payment = await createPaymentViaApi(adminA, order.id);

      const [capture, fail] = await Promise.all([
        call('post', `/payments/${payment.id}/capture`, adminA),
        call('post', `/payments/${payment.id}/fail`, adminA),
      ]);

      // Deterministically one 200 and one 409: only one guarded update can
      // flip PROCESSING, and the loser can never idempotent-return the
      // winner's terminal state (capture sees FAILED -> 409, fail sees
      // CAPTURED -> 409).
      const statuses = [capture.status, fail.status].sort();
      expect(statuses).toEqual([200, 409]);

      const paymentRow = await getPaymentRow(payment.id);
      const orderRow = await getOrderRow(order.id);
      if ((capture.body as PaymentBody).status === 'CAPTURED') {
        expect(paymentRow?.status).toBe('CAPTURED');
        expect(orderRow?.status).toBe('PAID');
      } else {
        expect((fail.body as PaymentBody).status).toBe('FAILED');
        expect(paymentRow?.status).toBe('FAILED');
        expect(orderRow?.status).toBe('PENDING');
      }
    });

    it('two concurrent payment creations for the same order both succeed', async () => {
      const order = await createOrderViaApi(adminA, 2);

      const [a, b] = await Promise.all([
        call('post', '/payments', adminA, {
          orderId: order.id,
          method: 'CARD',
        }),
        call('post', '/payments', adminA, {
          orderId: order.id,
          method: 'CASH',
        }),
      ]);

      // Documented T5 rule: multiple PROCESSING payments are allowed while
      // the order is PENDING and no CAPTURED payment exists.
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);

      const rows = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findMany({ where: { orderId: order.id } }),
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === 'PROCESSING')).toBe(true);
      expect(new Set(rows.map((r) => r.method)).size).toBe(2);
    });
  });
});
