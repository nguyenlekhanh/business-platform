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
 * Phase 4 P4-U2 — Online POS Sale integration suite.
 *
 * Verifies that the POS sale is a thin orchestration over the REAL Core
 * Commerce engines: full AppModule + supertest + real PostgreSQL, no mocks
 * for any behavior under test. Covers: the happy path (device -> session ->
 * sale -> Order + Payment CAPTURED + Order PAID + inventory decremented +
 * provenance row), session/device lifecycle gates, store + tenant
 * isolation, RBAC, authority-field injection, money invariants (exact BigInt
 * strings), insufficient stock, and a deterministic two-device last-unit
 * oversell race (the DB guarded decrement arbitrates).
 */
describe('POS Sale (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }
  interface SessionBody {
    id: string;
    status: string;
  }
  interface SaleBody {
    id: string;
    tenantId: string;
    orderId: string;
    paymentId: string;
    sessionId: string;
    deviceId: string;
    storeId: string;
    userId: string;
    orderStatus: string;
    paymentStatus: string;
    method: string;
    currency: string;
    subtotalMinor: string;
    items: Array<{
      variantId: string;
      sku: string;
      quantity: number;
      unitAmountMinor: string;
      lineTotalMinor: string;
    }>;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `psale-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
      await prisma.posSale
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.posSession
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.posDevice
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
      await prisma.customer
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.store
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
  let storeA1Id: string;
  let storeA2Id: string;
  let cashierA: Record<string, string>; // pos:create (register+sell)
  let managerA: Record<string, string>; // pos:manage + pos:create
  let employeeA: Record<string, string>; // pos:read only
  let ownerA: Record<string, string>;
  let adminB: Record<string, string>;
  let cashierAId: string;
  let managerAId: string;

  let seq = 0;

  beforeEach(async () => {
    seq += 1;
    const tenantA = await createTenant('a');
    tenantAId = tenantA.id;

    const mkStore = async (code: string) =>
      tenantContext.run(tenantAId, async () =>
        prisma.store.create({
          data: {
            tenantId: tenantAId,
            name: code,
            code,
            type: 'POS',
            status: 'ACTIVE',
          },
        }),
      );
    storeA1Id = (await mkStore(`S1-${run}-${seq}`)).id;
    storeA2Id = (await mkStore(`S2-${run}-${seq}`)).id;

    const cashierRole = await grantRole(tenantAId, `cashier-a-${run}`, [
      PERMISSIONS.POS_READ,
      PERMISSIONS.POS_CREATE,
    ]);
    const managerRole = await grantRole(tenantAId, `manager-a-${run}`, [
      PERMISSIONS.POS_READ,
      PERMISSIONS.POS_CREATE,
      PERMISSIONS.POS_MANAGE,
      PERMISSIONS.PAYMENT_READ,
      PERMISSIONS.PAYMENT_CREATE,
      PERMISSIONS.PAYMENT_MANAGE, // finalize CARD sales via the existing endpoint
    ]);
    const employeeRole = await grantRole(tenantAId, `employee-a-${run}`, [
      PERMISSIONS.POS_READ,
    ]);
    const ownerRole = await grantRole(tenantAId, SYSTEM_ROLE_KEYS.OWNER, []);

    cashierAId = (
      await createUser(
        `cashier-${run}-${seq}@a.test`,
        tenantAId,
        cashierRole.id,
      )
    ).id;
    managerAId = (
      await createUser(
        `manager-${run}-${seq}@a.test`,
        tenantAId,
        managerRole.id,
      )
    ).id;
    const employeeUserId = (
      await createUser(
        `employee-${run}-${seq}@a.test`,
        tenantAId,
        employeeRole.id,
      )
    ).id;
    const ownerUserId = (
      await createUser(`owner-${run}-${seq}@a.test`, tenantAId, ownerRole.id)
    ).id;

    const tenantB = await createTenant('b');
    tenantBId = tenantB.id;
    // Tenant B's store exists for tenant isolation, but no assertion needs
    // its id directly (cross-tenant probes go through adminB's headers).
    await tenantContext.run(tenantBId, async () =>
      prisma.store.create({
        data: {
          tenantId: tenantBId,
          name: `SB-${run}-${seq}`,
          code: `SB-${run}-${seq}`,
          type: 'POS',
          status: 'ACTIVE',
        },
      }),
    );
    const adminRoleB = await grantRole(tenantBId, `admin-b-${run}`, [
      PERMISSIONS.POS_READ,
      PERMISSIONS.POS_CREATE,
      PERMISSIONS.POS_MANAGE,
    ]);
    const adminBUser = await createUser(
      `admin-${run}-${seq}@b.test`,
      tenantBId,
      adminRoleB.id,
    );

    const outsider = await prisma.user.create({
      data: { email: `outsider-${run}-${seq}@x.test`, passwordHash: 'hash-x' },
    });
    userIdsToDelete.push(outsider.id);

    cashierA = await loginAs(cashierAId, tenantAId);
    managerA = await loginAs(managerAId, tenantAId);
    employeeA = await loginAs(employeeUserId, tenantAId);
    ownerA = await loginAs(ownerUserId, tenantAId);
    adminB = await loginAs(adminBUser.id, tenantBId);
  });

  // Provision a sellable variant through direct tenant-scoped Prisma (the
  // catalog APIs were verified end-to-end in Phase 3/U8; this suite focuses
  // on the POS layer over the commerce engines).
  const provisionVariant = async (
    tenantId: string,
    label: string,
    unitPrice: bigint,
    stock: number,
  ) => {
    const cat = await tenantContext.run(tenantId, async () =>
      prisma.category.create({ data: { tenantId, name: `CAT-${label}` } }),
    );
    const prod = await tenantContext.run(tenantId, async () =>
      prisma.product.create({
        data: {
          tenantId,
          categoryId: cat.id,
          name: `PROD-${label}`,
          code: `CODE-${label}`,
          status: 'ACTIVE',
        },
      }),
    );
    const variant = await tenantContext.run(tenantId, async () =>
      prisma.productVariant.create({
        data: { tenantId, productId: prod.id, sku: `SKU-${label}` },
      }),
    );
    await tenantContext.run(tenantId, async () =>
      prisma.price.create({
        data: {
          tenantId,
          variantId: variant.id,
          currency: 'USD',
          amountMinor: unitPrice,
        },
      }),
    );
    await tenantContext.run(tenantId, async () =>
      prisma.inventory.create({
        data: { tenantId, variantId: variant.id, quantityOnHand: stock },
      }),
    );
    return variant.id;
  };

  const registerDevice = async (
    headers: Record<string, string>,
    storeId: string,
    name: string,
  ) => {
    const res = await call('post', '/pos/devices', headers, {
      storeId,
      name,
    });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };

  const openSession = async (
    headers: Record<string, string>,
    deviceId: string,
  ) => {
    const res = await call('post', '/pos/sessions', headers, { deviceId });
    expect(res.status).toBe(201);
    return res.body as unknown as SessionBody;
  };

  const mkSale = async (
    headers: Record<string, string>,
    sessionId: string,
    items: Array<{ variantId: string; quantity: number }>,
    extra: Record<string, unknown> = {},
  ) => call('post', '/pos/sales', headers, { sessionId, items, ...extra });

  describe('happy path: device -> session -> sale -> PAID', () => {
    it('creates a complete CASH sale with correct Order, Payment, inventory, and provenance', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `${run}-${seq}`,
        1250n,
        30,
      );
      const device = await registerDevice(
        cashierA,
        storeA1Id,
        `DEV-${run}-${seq}`,
      );
      const session = await openSession(cashierA, device);

      const sale = await mkSale(cashierA, session.id, [
        { variantId, quantity: 2 },
        { variantId, quantity: 1 }, // aggregates to 3
      ]);
      expect(sale.status).toBe(201);
      const body = sale.body as unknown as SaleBody;

      // Order/Payment final states via the EXISTING state machines.
      expect(body.orderStatus).toBe('PAID');
      expect(body.paymentStatus).toBe('CAPTURED');
      expect(body.method).toBe('CASH');
      expect(body.currency).toBe('USD');
      // Exact integer minor-unit arithmetic, BigInt as strings.
      expect(body.subtotalMinor).toBe('3750'); // 3 * 1250
      expect(typeof body.subtotalMinor).toBe('string');
      expect(body.items).toHaveLength(1);
      expect(body.items[0].quantity).toBe(3);
      expect(body.items[0].unitAmountMinor).toBe('1250');
      expect(body.items[0].lineTotalMinor).toBe('3750');

      // Provenance anchored to the SESSION's context (never the client).
      expect(body.sessionId).toBe(session.id);
      expect(body.deviceId).toBe(device);
      expect(body.storeId).toBe(storeA1Id);
      expect(body.userId).toBe(cashierAId);

      // Persisted rows: Order PAID, Payment CAPTURED, stock 30 -> 27.
      const orderRow = await tenantContext.run(tenantAId, async () =>
        prisma.order.findUnique({ where: { id: body.orderId } }),
      );
      expect(orderRow?.status).toBe('PAID');
      expect(orderRow?.userId).toBe(cashierAId);
      const paymentRow = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findUnique({ where: { id: body.paymentId } }),
      );
      expect(paymentRow?.status).toBe('CAPTURED');
      expect(paymentRow?.amountMinor).toBe(3750n);
      const invRow = await tenantContext.run(tenantAId, async () =>
        prisma.inventory.findUnique({ where: { variantId } }),
      );
      expect(invRow?.quantityOnHand).toBe(27);

      // The sale is retrievable with the full provenance + shift history.
      const fetched = await call('get', `/pos/sales/${body.id}`, cashierA);
      expect(fetched.status).toBe(200);
      expect((fetched.body as SaleBody).orderId).toBe(body.orderId);
      const shift = await call(
        'get',
        `/pos/sessions/${session.id}/sales`,
        cashierA,
      );
      expect(shift.status).toBe(200);
      expect(shift.body as unknown as SaleBody[]).toHaveLength(1);
    });

    it('CARD sale leaves Payment PROCESSING and Order PENDING; existing capture endpoint finalizes it', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `CARD-${run}-${seq}`,
        2000n,
        10,
      );
      const device = await registerDevice(
        managerA,
        storeA1Id,
        `CDEV-${run}-${seq}`,
      );
      const session = await openSession(managerA, device);

      const sale = await mkSale(
        managerA,
        session.id,
        [{ variantId, quantity: 2 }],
        { method: 'CARD' },
      );
      expect(sale.status).toBe(201);
      const body = sale.body as unknown as SaleBody;
      expect(body.paymentStatus).toBe('PROCESSING');
      expect(body.orderStatus).toBe('PENDING');

      // The EXISTING Phase 3 capture endpoint finalizes the sale.
      const capture = await call(
        'post',
        `/payments/${body.paymentId}/capture`,
        managerA,
      );
      expect(capture.status).toBe(200);
      expect((capture.body as { status: string }).status).toBe('CAPTURED');

      const fetched = await call('get', `/pos/sales/${body.id}`, managerA);
      const fresh = fetched.body as unknown as SaleBody;
      expect(fresh.paymentStatus).toBe('CAPTURED');
      expect(fresh.orderStatus).toBe('PAID');
    });

    it('walk-in (anonymous) sale works without any customer', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `ANON-${run}-${seq}`,
        500n,
        5,
      );
      const device = await registerDevice(
        cashierA,
        storeA1Id,
        `ADEV-${run}-${seq}`,
      );
      const session = await openSession(cashierA, device);
      const sale = await mkSale(cashierA, session.id, [
        { variantId, quantity: 1 },
      ]);
      expect(sale.status).toBe(201);
      const orderRow = await tenantContext.run(tenantAId, async () =>
        prisma.order.findUnique({
          where: { id: (sale.body as SaleBody).orderId },
        }),
      );
      expect(orderRow?.customerId).toBeNull(); // documented Phase 3 rule
    });

    it('named-customer sale forwards customerId through the existing order path', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `CUST-${run}-${seq}`,
        700n,
        5,
      );
      const customer = await tenantContext.run(tenantAId, async () =>
        prisma.customer.create({
          data: {
            tenantId: tenantAId,
            name: 'POS Walkup',
            code: `PC-${run}-${seq}`,
          },
        }),
      );
      const device = await registerDevice(
        cashierA,
        storeA1Id,
        `CDEV2-${run}-${seq}`,
      );
      const session = await openSession(cashierA, device);
      const sale = await mkSale(
        cashierA,
        session.id,
        [{ variantId, quantity: 1 }],
        { customerId: customer.id },
      );
      expect(sale.status).toBe(201);
      const orderRow = await tenantContext.run(tenantAId, async () =>
        prisma.order.findUnique({
          where: { id: (sale.body as SaleBody).orderId },
        }),
      );
      expect(orderRow?.customerId).toBe(customer.id);
    });
  });

  describe('session/device lifecycle gates', () => {
    it('CLOSED session rejects sales; a new session on the same device works', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `CL-${run}-${seq}`,
        100n,
        5,
      );
      const device = await registerDevice(
        cashierA,
        storeA1Id,
        `CLDEV-${run}-${seq}`,
      );
      const session = await openSession(cashierA, device);
      const close = await call(
        'post',
        `/pos/sessions/${session.id}/close`,
        managerA,
      );
      expect(close.status).toBe(200);

      const rejected = await mkSale(cashierA, session.id, [
        { variantId, quantity: 1 },
      ]);
      expect(rejected.status).toBe(409);
      expect((rejected.body as ErrorBody).message).toBe(
        'Only open sessions can create sales',
      );

      // Re-open a NEW session on the same device and sell.
      const session2 = await openSession(cashierA, device);
      const sale = await mkSale(cashierA, session2.id, [
        { variantId, quantity: 1 },
      ]);
      expect(sale.status).toBe(201);
    });

    it('SUSPENDED device rejects sales; resume restores', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `SD-${run}-${seq}`,
        100n,
        5,
      );
      const device = await registerDevice(
        cashierA,
        storeA1Id,
        `SDDEV-${run}-${seq}`,
      );
      const session = await openSession(cashierA, device);
      await call('post', `/pos/devices/${device}/suspend`, managerA);

      const rejected = await mkSale(cashierA, session.id, [
        { variantId, quantity: 1 },
      ]);
      expect(rejected.status).toBe(409);
      expect((rejected.body as ErrorBody).message).toBe('Device is not active');

      await call('post', `/pos/devices/${device}/resume`, managerA);
      const sale = await mkSale(cashierA, session.id, [
        { variantId, quantity: 1 },
      ]);
      expect(sale.status).toBe(201);
    });

    it('RETIRED device rejects sales', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `RT-${run}-${seq}`,
        100n,
        5,
      );
      const device = await registerDevice(
        cashierA,
        storeA1Id,
        `RTDEV-${run}-${seq}`,
      );
      const session = await openSession(cashierA, device);
      await call('post', `/pos/devices/${device}/retire`, managerA);

      const rejected = await mkSale(cashierA, session.id, [
        { variantId, quantity: 1 },
      ]);
      expect(rejected.status).toBe(409);
      expect((rejected.body as ErrorBody).message).toBe('Device is not active');
    });

    it('a different member cannot sell on someone else’s open session', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `XS-${run}-${seq}`,
        100n,
        5,
      );
      const device = await registerDevice(
        cashierA,
        storeA1Id,
        `XSDEV-${run}-${seq}`,
      );
      const session = await openSession(cashierA, device);

      // managerA (also pos:create) tries to sell on cashierA's session.
      const rejected = await mkSale(managerA, session.id, [
        { variantId, quantity: 1 },
      ]);
      // The session is invisible to a non-opener for sale attribution:
      // uniform 404 (no existence oracle).
      expect(rejected.status).toBe(404);
      expect((rejected.body as ErrorBody).message).toBe(
        'POS session not found',
      );
    });
  });

  describe('inventory + money + rollback', () => {
    it('insufficient stock rejects the sale and leaves no Order/Payment/sale rows', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `IS-${run}-${seq}`,
        100n,
        2,
      );
      const device = await registerDevice(
        cashierA,
        storeA1Id,
        `ISDEV-${run}-${seq}`,
      );
      const session = await openSession(cashierA, device);

      const sale = await mkSale(cashierA, session.id, [
        { variantId, quantity: 5 },
      ]);
      expect(sale.status).toBe(409);
      expect((sale.body as ErrorBody).message).toBe('Insufficient stock');

      const invRow = await tenantContext.run(tenantAId, async () =>
        prisma.inventory.findUnique({ where: { variantId } }),
      );
      expect(invRow?.quantityOnHand).toBe(2); // untouched
      const orders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(orders).toHaveLength(0);
      const sales = await tenantContext.run(tenantAId, async () =>
        prisma.posSale.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(sales).toHaveLength(0);
    });

    it('two devices selling the last units concurrently: exactly one wins (DB arbitrates)', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `RC-${run}-${seq}`,
        100n,
        2,
      );
      const dev1 = await registerDevice(
        cashierA,
        storeA1Id,
        `RC1-${run}-${seq}`,
      );
      const dev2 = await registerDevice(
        managerA,
        storeA2Id,
        `RC2-${run}-${seq}`,
      );
      const s1 = await openSession(cashierA, dev1);
      const s2 = await openSession(managerA, dev2);

      const [a, b] = await Promise.all([
        mkSale(cashierA, s1.id, [{ variantId, quantity: 2 }]),
        mkSale(managerA, s2.id, [{ variantId, quantity: 2 }]),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]); // exactly one sale wins

      const invRow = await tenantContext.run(tenantAId, async () =>
        prisma.inventory.findUnique({ where: { variantId } }),
      );
      expect(invRow?.quantityOnHand).toBe(0); // never oversold
      const salesRows = await tenantContext.run(tenantAId, async () =>
        prisma.posSale.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(salesRows).toHaveLength(1);
    });
  });

  describe('security: RBAC, tenant, and injection', () => {
    it('401 unauthenticated / 403 outsider', async () => {
      expect(
        (await call('post', '/pos/sales', {}, { sessionId: 'x', items: [] }))
          .status,
      ).toBe(401);
      expect((await call('get', '/pos/sales/x', {})).status).toBe(401);
      const outsiderUser = await prisma.user.findUniqueOrThrow({
        where: { email: `outsider-${run}-${seq}@x.test` },
      });
      const headers = await loginAs(outsiderUser.id, tenantAId);
      expect(
        (
          await call('post', '/pos/sales', headers, {
            sessionId: 'x',
            items: [{ variantId: 'v', quantity: 1 }],
          })
        ).status,
      ).toBe(403);
    });

    it('employee (pos:read only) cannot create sales (A1)', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `EMP-${run}-${seq}`,
        100n,
        5,
      );
      const device = await registerDevice(
        managerA,
        storeA1Id,
        `EDEV-${run}-${seq}`,
      );
      const session = await openSession(managerA, device);
      const res = await mkSale(employeeA, session.id, [
        { variantId, quantity: 1 },
      ]);
      expect(res.status).toBe(403);
    });

    it('owner semantic-all sells without explicit grants', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `OWN-${run}-${seq}`,
        100n,
        5,
      );
      const device = await registerDevice(
        ownerA,
        storeA1Id,
        `ODEV-${run}-${seq}`,
      );
      const session = await openSession(ownerA, device);
      const sale = await mkSale(ownerA, session.id, [
        { variantId, quantity: 1 },
      ]);
      expect(sale.status).toBe(201);
      expect((sale.body as SaleBody).orderStatus).toBe('PAID');
    });

    it('cross-tenant session/device/sale access is uniformly 404 and mutates nothing', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `XT-${run}-${seq}`,
        100n,
        5,
      );
      const device = await registerDevice(
        cashierA,
        storeA1Id,
        `XTDEV-${run}-${seq}`,
      );
      const session = await openSession(cashierA, device);
      const sale = await mkSale(cashierA, session.id, [
        { variantId, quantity: 1 },
      ]);
      const saleBody = sale.body as unknown as SaleBody;

      // Tenant B cannot sell on A's session, read A's sale, or list A's shift.
      expect(
        (await mkSale(adminB, session.id, [{ variantId, quantity: 1 }])).status,
      ).toBe(404);
      expect(
        (await call('get', `/pos/sales/${saleBody.id}`, adminB)).status,
      ).toBe(404);
      expect(
        (await call('get', `/pos/sessions/${session.id}/sales`, adminB)).status,
      ).toBe(404);

      // Tenant A's rows intact.
      const saleRow = await tenantContext.run(tenantAId, async () =>
        prisma.posSale.findUnique({ where: { id: saleBody.id } }),
      );
      expect(saleRow?.id).toBe(saleBody.id);
      const ordersA = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(ordersA).toHaveLength(1);
      // Nothing leaked into tenant B.
      const ordersB = await tenantContext.run(tenantBId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantBId } }),
      );
      expect(ordersB).toHaveLength(0);
      const salesB = await tenantContext.run(tenantBId, async () =>
        prisma.posSale.findMany({ where: { tenantId: tenantBId } }),
      );
      expect(salesB).toHaveLength(0);
    });

    it('rejects tenantId/storeId/deviceId/cashierId/orderId/status injections with 400', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `INJ-${run}-${seq}`,
        100n,
        5,
      );
      const device = await registerDevice(
        cashierA,
        storeA1Id,
        `IDEV-${run}-${seq}`,
      );
      const session = await openSession(cashierA, device);

      const injections = [
        {
          sessionId: session.id,
          items: [{ variantId, quantity: 1 }],
          tenantId: tenantBId,
        },
        {
          sessionId: session.id,
          items: [{ variantId, quantity: 1 }],
          storeId: storeA2Id,
        },
        {
          sessionId: session.id,
          items: [{ variantId, quantity: 1 }],
          deviceId: 'other',
        },
        {
          sessionId: session.id,
          items: [{ variantId, quantity: 1 }],
          cashierId: 'other',
        },
        {
          sessionId: session.id,
          items: [{ variantId, quantity: 1 }],
          orderId: 'o',
        },
        {
          sessionId: session.id,
          items: [{ variantId, quantity: 1 }],
          paymentId: 'p',
        },
        {
          sessionId: session.id,
          items: [{ variantId, quantity: 1 }],
          status: 'PAID',
        },
        {
          sessionId: session.id,
          items: [{ variantId, quantity: 1 }],
          bogus: 1,
        },
      ];
      for (const payload of injections) {
        expect(
          (await mkSale(cashierA, session.id, payload.items, payload)).status,
        ).toBe(400);
      }
    });

    it('two stores in the same tenant: sale context follows the SESSION, never the client', async () => {
      const variantId = await provisionVariant(
        tenantAId,
        `ST2-${run}-${seq}`,
        100n,
        50,
      );
      const device = await registerDevice(
        cashierA,
        storeA1Id,
        `STDEV-${run}-${seq}`,
      );
      const session = await openSession(cashierA, device);

      // Sale on the store-1 device's session: provenance must say store 1.
      const sale = await mkSale(cashierA, session.id, [
        { variantId, quantity: 1 },
      ]);
      const body = sale.body as unknown as SaleBody;
      expect(body.storeId).toBe(storeA1Id);
      expect(body.storeId).not.toBe(storeA2Id);

      // A store-2 device has its own session and its own provenance.
      const device2 = await registerDevice(
        managerA,
        storeA2Id,
        `STDEV2-${run}-${seq}`,
      );
      const session2 = await openSession(managerA, device2);
      const sale2 = await mkSale(managerA, session2.id, [
        { variantId, quantity: 1 },
      ]);
      expect((sale2.body as SaleBody).storeId).toBe(storeA2Id);
    });
  });
});
