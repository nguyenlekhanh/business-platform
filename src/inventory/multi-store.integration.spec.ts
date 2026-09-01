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
 * Phase 4 P4-U3 — Multi-store Inventory integration suite (approved D2
 * Option A: the existing Inventory model extended with nullable storeId +
 * store-scoped uniqueness; the tenant-global pool preserved verbatim).
 *
 * Covers: pool independence (Store A / Variant X = 5, Store B = 7: selling
 * from A leaves B untouched), global-pool backward compatibility for the
 * Phase 3 routes, deterministic concurrency (same-store last-unit race;
 * cross-store independence under concurrent decrements), restock-on-cancel
 * (POS order -> its store pool exactly once; other store + global
 * untouched; non-POS order -> global pool), POS store-consumption, and the
 * full security matrix (401/403, cross-tenant 404s, store/tenant injection).
 */
describe('Multi-store Inventory (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }
  interface InventoryBody {
    id: string | null;
    tenantId: string;
    storeId: string | null;
    variantId: string;
    quantityOnHand: number;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `msi-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
      // Order-dependent teardown: sales/payments/orders first, then the
      // RESTRICT-bound stock rows, then the rest of the established chain.
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
  let storeAId: string;
  let storeA2Id: string;
  let storeBId: string;
  let adminA: Record<string, string>;
  let employeeA: Record<string, string>;
  let ownerA: Record<string, string>;
  let adminB: Record<string, string>;
  let adminAId: string;
  let ownerAId: string;

  let seq = 0;

  const grants = [
    PERMISSIONS.INVENTORY_READ,
    PERMISSIONS.INVENTORY_MANAGE,
    PERMISSIONS.STORE_READ,
    PERMISSIONS.PRODUCT_READ,
    PERMISSIONS.PRODUCT_MANAGE,
    PERMISSIONS.CATEGORY_READ,
    PERMISSIONS.CATEGORY_MANAGE,
    PERMISSIONS.ORDER_READ,
    PERMISSIONS.ORDER_CREATE,
    PERMISSIONS.ORDER_DELETE,
    PERMISSIONS.ORDER_MANAGE,
    PERMISSIONS.PAYMENT_READ,
    PERMISSIONS.PAYMENT_CREATE,
    PERMISSIONS.PAYMENT_MANAGE,
    PERMISSIONS.POS_READ,
    PERMISSIONS.POS_CREATE,
    PERMISSIONS.POS_MANAGE,
  ];

  beforeEach(async () => {
    seq += 1;
    const tenantA = await createTenant('a');
    tenantAId = tenantA.id;
    const adminRole = await grantRole(tenantAId, `admin-a-${run}`, grants);
    const employeeRole = await grantRole(tenantAId, `employee-a-${run}`, [
      PERMISSIONS.INVENTORY_READ,
    ]);
    const ownerRole = await grantRole(tenantAId, SYSTEM_ROLE_KEYS.OWNER, []);

    adminAId = (
      await createUser(`admin-${run}-${seq}@a.test`, tenantAId, adminRole.id)
    ).id;
    const employeeUserId = (
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
    const adminRoleB = await grantRole(tenantBId, `admin-b-${run}`, grants);
    const adminBUser = await createUser(
      `admin-${run}-${seq}@b.test`,
      tenantBId,
      adminRoleB.id,
    );

    const outsider = await prisma.user.create({
      data: { email: `outsider-${run}-${seq}@x.test`, passwordHash: 'hash-x' },
    });
    userIdsToDelete.push(outsider.id);

    adminA = await loginAs(adminAId, tenantAId);
    employeeA = await loginAs(employeeUserId, tenantAId);
    ownerA = await loginAs(ownerAId, tenantAId);
    adminB = await loginAs(adminBUser.id, tenantBId);

    const mkStore = async (tenantId: string, code: string) =>
      tenantContext.run(tenantId, async () =>
        prisma.store.create({
          data: { tenantId, name: code, code, type: 'POS', status: 'ACTIVE' },
        }),
      );
    storeAId = (await mkStore(tenantAId, `SA-${run}-${seq}`)).id;
    storeA2Id = (await mkStore(tenantAId, `SA2-${run}-${seq}`)).id;
    storeBId = (await mkStore(tenantBId, `SB-${run}-${seq}`)).id;
  });

  const provisionVariant = async (
    tenantId: string,
    label: string,
    unitPrice = 1000n,
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
    return variant.id;
  };

  const stockRow = (storeId: string | null, variantId: string) =>
    tenantContext.run(tenantAId, async () =>
      prisma.inventory.findFirst({
        where: { variantId, storeId },
      }),
    );

  const registerDevice = async (storeId: string, name: string) => {
    const res = await call('post', '/pos/devices', adminA, { storeId, name });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };

  const openSession = async (deviceId: string) => {
    const res = await call('post', '/pos/sessions', adminA, { deviceId });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };

  const posSale = async (
    sessionId: string,
    variantId: string,
    quantity: number,
  ) =>
    call('post', '/pos/sales', adminA, {
      sessionId,
      items: [{ variantId, quantity }],
    });

  describe('store pool independence (D2 Option A core example)', () => {
    it('Store A = 5, Store B = 7: selling 2 from A leaves B untouched', async () => {
      const variantId = await provisionVariant(tenantAId, `IND-${run}-${seq}`);

      // Seed two INDEPENDENT store pools.
      await call('post', `/inventory/stores/${storeAId}/adjust`, adminA, {
        variantId,
        delta: 5,
      });
      await call('post', `/inventory/stores/${storeA2Id}/adjust`, adminA, {
        variantId,
        delta: 7,
      });

      // POS sale of 2 from Store A.
      const device = await registerDevice(storeAId, `D1-${run}-${seq}`);
      const session = await openSession(device);
      const sale = await posSale(session.id, variantId, 2);
      expect(sale.status).toBe(201);

      // Store A: 5 -> 3; Store B: 7 -> 7 (never touched); global: absent.
      expect((await stockRow(storeAId, variantId))?.quantityOnHand).toBe(3);
      expect((await stockRow(storeA2Id, variantId))?.quantityOnHand).toBe(7);
      expect(await stockRow(null, variantId)).toBeNull();

      const global = await call('get', `/inventory/${variantId}`, adminA);
      expect((global.body as InventoryBody).quantityOnHand).toBe(0);
      const storeA = await call(
        'get',
        `/inventory/stores/${storeAId}/variants/${variantId}`,
        adminA,
      );
      expect((storeA.body as InventoryBody).quantityOnHand).toBe(3);
      expect((storeA.body as InventoryBody).storeId).toBe(storeAId);
    });

    it('insufficient STORE stock rejects the sale without touching any pool', async () => {
      const variantId = await provisionVariant(tenantAId, `INS-${run}-${seq}`);
      await call('post', `/inventory/stores/${storeAId}/adjust`, adminA, {
        variantId,
        delta: 1,
      });
      await call('post', `/inventory/stores/${storeA2Id}/adjust`, adminA, {
        variantId,
        delta: 9,
      });
      await call('post', '/inventory/adjust', adminA, { variantId, delta: 50 });

      const device = await registerDevice(storeAId, `D2-${run}-${seq}`);
      const session = await openSession(device);
      const sale = await posSale(session.id, variantId, 5);
      expect(sale.status).toBe(409);
      expect((sale.body as ErrorBody).message).toBe('Insufficient stock');

      // NOTHING moved: A=1, B=9, global=50; no order/sale rows.
      expect((await stockRow(storeAId, variantId))?.quantityOnHand).toBe(1);
      expect((await stockRow(storeA2Id, variantId))?.quantityOnHand).toBe(9);
      expect((await stockRow(null, variantId))?.quantityOnHand).toBe(50);
      const orders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(orders).toHaveLength(0);
    });
  });

  describe('global pool backward compatibility (Phase 3 routes)', () => {
    it('the Phase 3 routes still read/adjust the tenant-global pool only', async () => {
      const variantId = await provisionVariant(tenantAId, `GLB-${run}-${seq}`);
      await call('post', '/inventory/adjust', adminA, { variantId, delta: 10 });
      await call('post', `/inventory/stores/${storeAId}/adjust`, adminA, {
        variantId,
        delta: 4,
      });

      // Phase 3 GET sees the GLOBAL pool (10), never the store pool.
      const get = await call('get', `/inventory/${variantId}`, adminA);
      const body = get.body as InventoryBody;
      expect(body.quantityOnHand).toBe(10);
      expect(body.storeId).toBeNull();

      // Phase 3 adjust still targets the global pool.
      const adj = await call('post', '/inventory/adjust', adminA, {
        variantId,
        delta: -3,
      });
      expect((adj.body as InventoryBody).quantityOnHand).toBe(7);
      expect((await stockRow(storeAId, variantId))?.quantityOnHand).toBe(4);
    });

    it('a regular (non-POS) order still decrements the GLOBAL pool', async () => {
      const variantId = await provisionVariant(tenantAId, `ORD-${run}-${seq}`);
      await call('post', '/inventory/adjust', adminA, { variantId, delta: 6 });
      await call('post', `/inventory/stores/${storeAId}/adjust`, adminA, {
        variantId,
        delta: 2,
      });

      const order = await call('post', '/orders', adminA, {
        items: [{ variantId, quantity: 2 }],
      });
      expect(order.status).toBe(201);

      expect((await stockRow(null, variantId))?.quantityOnHand).toBe(4);
      expect((await stockRow(storeAId, variantId))?.quantityOnHand).toBe(2);

      // Cancelling the non-POS order restocks the GLOBAL pool exactly once.
      const cancel = await call(
        'post',
        `/orders/${(order.body as { id: string }).id}/cancel`,
        adminA,
      );
      expect(cancel.status).toBe(200);
      expect((await stockRow(null, variantId))?.quantityOnHand).toBe(6);
      expect((await stockRow(storeAId, variantId))?.quantityOnHand).toBe(2);
    });
  });

  describe('restock on POS order cancellation', () => {
    it('cancelling a Store A POS sale restores Store A exactly once; Store B and global untouched', async () => {
      const variantId = await provisionVariant(tenantAId, `RS-${run}-${seq}`);
      await call('post', `/inventory/stores/${storeAId}/adjust`, adminA, {
        variantId,
        delta: 5,
      });
      await call('post', `/inventory/stores/${storeA2Id}/adjust`, adminA, {
        variantId,
        delta: 7,
      });
      await call('post', '/inventory/adjust', adminA, { variantId, delta: 99 });

      const device = await registerDevice(storeAId, `D3-${run}-${seq}`);
      const session = await openSession(device);
      const sale = await posSale(session.id, variantId, 3);
      expect(sale.status).toBe(201);
      expect((await stockRow(storeAId, variantId))?.quantityOnHand).toBe(2);

      // Cancel: CASH sale is PAID -> 409 (Phase 3 rule: paid orders cannot
      // be cancelled). Use a CARD sale to keep the order PENDING instead.
      const device2 = await registerDevice(storeAId, `D4-${run}-${seq}`);
      const session2 = await openSession(device2);
      const cardSale = await call('post', '/pos/sales', adminA, {
        sessionId: session2.id,
        items: [{ variantId, quantity: 2 }],
        method: 'CARD',
      });
      expect(cardSale.status).toBe(201);
      expect((await stockRow(storeAId, variantId))?.quantityOnHand).toBe(0);

      const cancel = await call(
        'post',
        `/orders/${(cardSale.body as { orderId: string }).orderId}/cancel`,
        adminA,
      );
      expect(cancel.status).toBe(200);

      // Store A restored exactly once (0 -> 2, not -> 4, not -> 5).
      expect((await stockRow(storeAId, variantId))?.quantityOnHand).toBe(2);
      // Store B untouched; global untouched.
      expect((await stockRow(storeA2Id, variantId))?.quantityOnHand).toBe(7);
      expect((await stockRow(null, variantId))?.quantityOnHand).toBe(99);

      // Repeated cancellation does NOT double-restock.
      const cancelAgain = await call(
        'post',
        `/orders/${(cardSale.body as { orderId: string }).orderId}/cancel`,
        adminA,
      );
      expect(cancelAgain.status).toBe(409);
      expect((await stockRow(storeAId, variantId))?.quantityOnHand).toBe(2);
    });
  });

  describe('deterministic concurrency', () => {
    it('same store, same variant: last-unit race -> exactly one winner, no oversell', async () => {
      const variantId = await provisionVariant(tenantAId, `RC1-${run}-${seq}`);
      await call('post', `/inventory/stores/${storeAId}/adjust`, adminA, {
        variantId,
        delta: 2,
      });
      const device = await registerDevice(storeAId, `D5-${run}-${seq}`);
      const session = await openSession(device);

      const [a, b] = await Promise.all([
        posSale(session.id, variantId, 2),
        posSale(session.id, variantId, 2),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      expect((await stockRow(storeAId, variantId))?.quantityOnHand).toBe(0);
    });

    it('different stores, same variant: concurrent decrements stay independent', async () => {
      const variantId = await provisionVariant(tenantAId, `RC2-${run}-${seq}`);
      await call('post', `/inventory/stores/${storeAId}/adjust`, adminA, {
        variantId,
        delta: 3,
      });
      await call('post', `/inventory/stores/${storeA2Id}/adjust`, adminA, {
        variantId,
        delta: 4,
      });

      const devA = await registerDevice(storeAId, `D6-${run}-${seq}`);
      const sessA = await openSession(devA);
      const devB = await registerDevice(storeA2Id, `D7-${run}-${seq}`);
      const sessB = await openSession(devB);

      const [a, b] = await Promise.all([
        posSale(sessA.id, variantId, 3),
        posSale(sessB.id, variantId, 4),
      ]);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);

      // Both pools decremented INDEPENDENTLY.
      expect((await stockRow(storeAId, variantId))?.quantityOnHand).toBe(0);
      expect((await stockRow(storeA2Id, variantId))?.quantityOnHand).toBe(0);
    });
  });

  describe('security matrix', () => {
    it('401 unauthenticated / 403 outsider / 403 employee without inventory:manage', async () => {
      const variantId = await provisionVariant(tenantAId, `SEC-${run}-${seq}`);
      expect(
        (
          await call(
            'post',
            `/inventory/stores/${storeAId}/adjust`,
            {},
            { variantId, delta: 1 },
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await call(
            'get',
            `/inventory/stores/${storeAId}/variants/${variantId}`,
            {},
          )
        ).status,
      ).toBe(401);

      const outsiderUser = await prisma.user.findUniqueOrThrow({
        where: { email: `outsider-${run}-${seq}@x.test` },
      });
      const outsiderHeaders = await loginAs(outsiderUser.id, tenantAId);
      expect(
        (
          await call(
            'post',
            `/inventory/stores/${storeAId}/adjust`,
            outsiderHeaders,
            {
              variantId,
              delta: 1,
            },
          )
        ).status,
      ).toBe(403);

      // Employee has inventory:read but NOT manage.
      const read = await call(
        'get',
        `/inventory/stores/${storeAId}/variants/${variantId}`,
        employeeA,
      );
      expect(read.status).toBe(200);
      const write = await call(
        'post',
        `/inventory/stores/${storeAId}/adjust`,
        employeeA,
        { variantId, delta: 1 },
      );
      expect(write.status).toBe(403);
    });

    it('cross-tenant store reference and inventory access are uniformly 404', async () => {
      const variantId = await provisionVariant(tenantAId, `XT1-${run}-${seq}`);

      // Tenant B admin adjusting via tenant A's store id + variant id:
      // both resolve to null under B's context, so the first server-side
      // check (variant) fires -> uniform 404. Either documented message
      // proves no cross-tenant leak.
      const adjustForeign = await call(
        'post',
        `/inventory/stores/${storeAId}/adjust`,
        adminB,
        { variantId, delta: 1 },
      );
      expect(adjustForeign.status).toBe(404);
      expect(['Variant not found', 'Store not found']).toContain(
        (adjustForeign.body as ErrorBody).message,
      );

      // Tenant B reading A's store pool: also 404.
      const readForeign = await call(
        'get',
        `/inventory/stores/${storeAId}/variants/${variantId}`,
        adminB,
      );
      expect(readForeign.status).toBe(404);

      // Foreign-tenant VARIANT under a valid own store: 404 (variant
      // resolves to null under B's context).
      const variantForeign = await call(
        'post',
        `/inventory/stores/${storeBId}/adjust`,
        adminB,
        { variantId, delta: 1 },
      );
      expect(variantForeign.status).toBe(404);
      expect((variantForeign.body as ErrorBody).message).toBe(
        'Variant not found',
      );

      // No rows were created anywhere.
      const rowsA = await tenantContext.run(tenantAId, async () =>
        prisma.inventory.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(rowsA).toHaveLength(0);
    });

    it('storeId injection in the body is rejected with 400', async () => {
      const variantId = await provisionVariant(tenantAId, `INJ-${run}-${seq}`);
      const res = await call(
        'post',
        `/inventory/stores/${storeAId}/adjust`,
        adminA,
        { variantId, delta: 1, storeId: storeA2Id },
      );
      expect(res.status).toBe(400);
      const tenantInject = await call(
        'post',
        `/inventory/stores/${storeAId}/adjust`,
        adminA,
        { variantId, delta: 1, tenantId: tenantBId },
      );
      expect(tenantInject.status).toBe(400);
    });

    it('a POS sale cannot affect another store: session store is the only pool', async () => {
      const variantId = await provisionVariant(tenantAId, `PSM-${run}-${seq}`);
      // Only store A2 has stock; the device is bound to store A.
      await call('post', `/inventory/stores/${storeA2Id}/adjust`, adminA, {
        variantId,
        delta: 10,
      });

      const device = await registerDevice(storeAId, `D8-${run}-${seq}`);
      const session = await openSession(device);
      const sale = await posSale(session.id, variantId, 1);

      // The sale consumes STORE A's pool — which is empty -> 409. It can
      // never silently fall back to another store's or the global pool.
      expect(sale.status).toBe(409);
      expect((await stockRow(storeA2Id, variantId))?.quantityOnHand).toBe(10);
      expect(await stockRow(null, variantId)).toBeNull();
    });

    it('owner semantic-all manages store-scoped inventory without grants', async () => {
      const variantId = await provisionVariant(tenantAId, `OWN-${run}-${seq}`);
      const res = await call(
        'post',
        `/inventory/stores/${storeAId}/adjust`,
        ownerA,
        { variantId, delta: 3 },
      );
      expect(res.status).toBe(201);
      expect((res.body as InventoryBody).quantityOnHand).toBe(3);
    });

    it('store delete is blocked while store-scoped stock references it (RESTRICT)', async () => {
      const variantId = await provisionVariant(tenantAId, `SD-${run}-${seq}`);
      await call('post', `/inventory/stores/${storeAId}/adjust`, adminA, {
        variantId,
        delta: 1,
      });
      const err = await tenantContext
        .run(tenantAId, async () =>
          prisma.store.delete({ where: { id: storeAId } }),
        )
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).not.toBeNull();
      expect((err as { code?: string }).code).toBe('P2003');
    });
  });
});
