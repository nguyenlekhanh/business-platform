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

describe('Cart (integration)', () => {
  interface CartBody {
    id: string;
    tenantId: string;
    userId: string;
    status: string;
    items: Array<{
      id: string;
      variantId: string;
      quantity: number;
      variant: { sku: string; name: string | null; status: string } | null;
      prices: Array<{ currency: string; amountMinor: string }>;
      lineTotals: Array<{ currency: string; totalMinor: string }>;
    }>;
    totals: Array<{ currency: string; totalMinor: string }>;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `cart-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
    perms: readonly string[],
  ) => {
    const role = await tenantContext.run(tenantId, async () =>
      prisma.role.create({ data: { tenantId, key, name: `${key} ${run}` } }),
    );
    roleIdsToDelete.push(role.id);
    if (perms.length > 0) {
      await tenantContext.run(tenantId, async () => {
        const permissions = await prisma.permission.findMany({
          where: { key: { in: [...perms] } },
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

  const createProduct = async (tenantId: string, code: string) =>
    tenantContext.run(tenantId, async () =>
      prisma.product.create({ data: { tenantId, code, name: code } }),
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
    method: 'get' | 'post' | 'patch' | 'delete',
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
  let managerAId: string;
  let ownerAId: string;
  let userA2Id: string;
  let adminBId: string;

  let adminA: Record<string, string>;
  let managerA: Record<string, string>;
  let ownerA: Record<string, string>;
  let userA2: Record<string, string>;
  let adminB: Record<string, string>;

  let variantAId: string;
  let variantA2Id: string;
  let variantBId: string;

  let seq = 0;

  beforeEach(async () => {
    seq += 1;
    const tenantA = await createTenant('a');
    tenantAId = tenantA.id;
    const adminRole = await grantRole(tenantAId, `admin-a-${run}`, [
      PERMISSIONS.CART_MANAGE,
      PERMISSIONS.PRODUCT_READ,
    ]);
    const managerRole = await grantRole(tenantAId, `manager-a-${run}`, []);
    const ownerRole = await grantRole(tenantAId, SYSTEM_ROLE_KEYS.OWNER, []);
    const userA2Role = await grantRole(tenantAId, `user2-a-${run}`, [
      PERMISSIONS.CART_MANAGE,
    ]);

    adminAId = (
      await createUser(`admin-${run}-${seq}@a.test`, tenantAId, adminRole.id)
    ).id;
    managerAId = (
      await createUser(
        `manager-${run}-${seq}@a.test`,
        tenantAId,
        managerRole.id,
      )
    ).id;
    ownerAId = (
      await createUser(`owner-${run}-${seq}@a.test`, tenantAId, ownerRole.id)
    ).id;
    userA2Id = (
      await createUser(`user2-${run}-${seq}@a.test`, tenantAId, userA2Role.id)
    ).id;

    const tenantB = await createTenant('b');
    tenantBId = tenantB.id;
    const adminRoleB = await grantRole(tenantBId, `admin-b-${run}`, [
      PERMISSIONS.CART_MANAGE,
    ]);
    adminBId = (
      await createUser(`admin-${run}-${seq}@b.test`, tenantBId, adminRoleB.id)
    ).id;

    const outsider = await prisma.user.create({
      data: { email: `outsider-${run}-${seq}@x.test`, passwordHash: 'hash-x' },
    });
    userIdsToDelete.push(outsider.id);

    adminA = await loginAs(adminAId, tenantAId);
    managerA = await loginAs(managerAId, tenantAId);
    ownerA = await loginAs(ownerAId, tenantAId);
    userA2 = await loginAs(userA2Id, tenantAId);
    adminB = await loginAs(adminBId, tenantBId);

    const pA = await createProduct(tenantAId, `PROD-A-${run}-${seq}`);
    const vA = await createVariant(tenantAId, pA.id, `SKU-A-${run}-${seq}`);
    variantAId = vA.id;
    const vA2 = await createVariant(tenantAId, pA.id, `SKU-A2-${run}-${seq}`);
    variantA2Id = vA2.id;
    await createPrice(tenantAId, variantAId, 'USD', 1000n);
    await createPrice(tenantAId, variantA2Id, 'EUR', 2000n);

    const pB = await createProduct(tenantBId, `PROD-B-${run}-${seq}`);
    const vB = await createVariant(tenantBId, pB.id, `SKU-B-${run}-${seq}`);
    variantBId = vB.id;
    await createPrice(tenantBId, variantBId, 'USD', 500n);
  });

  describe('authentication and authorization gates', () => {
    it('rejects unauthenticated with 401', async () => {
      expect((await call('get', '/cart', {})).status).toBe(401);
      expect(
        (
          await call(
            'post',
            '/cart/items',
            {},
            { variantId: variantAId, quantity: 1 },
          )
        ).status,
      ).toBe(401);
    });

    it('rejects outsider without membership with 403', async () => {
      const outsiderUser = await prisma.user.findUniqueOrThrow({
        where: { email: `outsider-${run}-${seq}@x.test` },
      });
      const headers = await loginAs(outsiderUser.id, tenantAId);
      expect((await call('get', '/cart', headers)).status).toBe(403);
      expect(
        (
          await call('post', '/cart/items', headers, {
            variantId: variantAId,
            quantity: 1,
          })
        ).status,
      ).toBe(403);
    });

    it('rejects member without cart:manage with 403', async () => {
      expect((await call('get', '/cart', managerA)).status).toBe(403);
      expect(
        (
          await call('post', '/cart/items', managerA, {
            variantId: variantAId,
            quantity: 1,
          })
        ).status,
      ).toBe(403);
      expect(
        (await call('patch', '/cart/items/some-id', managerA, { quantity: 2 }))
          .status,
      ).toBe(403);
      expect(
        (await call('delete', '/cart/items/some-id', managerA)).status,
      ).toBe(403);
      expect((await call('delete', '/cart', managerA)).status).toBe(403);
    });
  });

  describe('own-cart semantics and live totals', () => {
    it('creates empty cart on first GET and merges adds', async () => {
      const get0 = await call('get', '/cart', adminA);
      expect(get0.status).toBe(200);
      const cart0 = get0.body as unknown as CartBody;
      expect(cart0.items).toHaveLength(0);
      expect(cart0.totals).toHaveLength(0);
      const cartId0 = cart0.id;

      const add1 = await call('post', '/cart/items', adminA, {
        variantId: variantAId,
        quantity: 2,
      });
      expect(add1.status).toBe(201);
      const cart1 = add1.body as unknown as CartBody;
      expect(cart1.id).toBe(cartId0); // same cart, not new one
      expect(cart1.items).toHaveLength(1);
      expect(cart1.items[0].quantity).toBe(2);
      expect(cart1.items[0].prices).toEqual([
        { currency: 'USD', amountMinor: '1000' },
      ]);
      expect(cart1.items[0].lineTotals).toEqual([
        { currency: 'USD', totalMinor: '2000' },
      ]);
      expect(cart1.totals).toEqual([{ currency: 'USD', totalMinor: '2000' }]);

      // Merge same variant
      const add2 = await call('post', '/cart/items', adminA, {
        variantId: variantAId,
        quantity: 3,
      });
      expect(add2.status).toBe(201);
      const cart2 = add2.body as unknown as CartBody;
      expect(cart2.id).toBe(cartId0);
      expect(cart2.items).toHaveLength(1);
      expect(cart2.items[0].quantity).toBe(5);
      expect(cart2.totals).toEqual([{ currency: 'USD', totalMinor: '5000' }]);

      // Add second variant with different currency -> mixed totals
      const add3 = await call('post', '/cart/items', adminA, {
        variantId: variantA2Id,
        quantity: 1,
      });
      expect(add3.status).toBe(201);
      const cart3 = add3.body as unknown as CartBody;
      expect(cart3.items).toHaveLength(2);
      // Totals per currency sum separately, mixed allowed in cart
      expect(cart3.totals).toEqual(
        expect.arrayContaining([
          { currency: 'USD', totalMinor: '5000' },
          { currency: 'EUR', totalMinor: '2000' },
        ]),
      );

      // Live price update reflects on next GET
      await tenantContext.run(tenantAId, async () =>
        prisma.price.update({
          where: {
            variantId_currency: { variantId: variantAId, currency: 'USD' },
          },
          data: { amountMinor: 1500n },
        }),
      );
      const live = await call('get', '/cart', adminA);
      const liveCart = live.body as unknown as CartBody;
      expect(liveCart.totals).toEqual(
        expect.arrayContaining([
          { currency: 'USD', totalMinor: '7500' },
          { currency: 'EUR', totalMinor: '2000' },
        ]),
      );
    });

    it('patches quantity and removes item', async () => {
      await call('post', '/cart/items', adminA, {
        variantId: variantAId,
        quantity: 2,
      });
      const cart = (await call('get', '/cart', adminA))
        .body as unknown as CartBody;
      const itemId = cart.items[0].id;

      const patched = await call('patch', `/cart/items/${itemId}`, adminA, {
        quantity: 1,
      });
      expect(patched.status).toBe(200);
      expect((patched.body as unknown as CartBody).items[0].quantity).toBe(1);
      expect((patched.body as unknown as CartBody).totals).toEqual([
        { currency: 'USD', totalMinor: '1000' },
      ]);

      const removed = await call('delete', `/cart/items/${itemId}`, adminA);
      expect(removed.status).toBe(200);
      expect((removed.body as unknown as CartBody).items).toHaveLength(0);
      expect((removed.body as unknown as CartBody).totals).toHaveLength(0);
    });

    it('discards cart and creates new empty on next GET', async () => {
      await call('post', '/cart/items', adminA, {
        variantId: variantAId,
        quantity: 1,
      });
      const before = (await call('get', '/cart', adminA))
        .body as unknown as CartBody;
      expect(before.items).toHaveLength(1);
      const discard = await call('delete', '/cart', adminA);
      expect(discard.status).toBe(204);
      const after = await call('get', '/cart', adminA);
      expect(after.status).toBe(200);
      const afterCart = after.body as unknown as CartBody;
      expect(afterCart.items).toHaveLength(0);
      expect(afterCart.id).not.toBe(before.id);
    });

    it('returns 404 for unknown cart item and unknown variant', async () => {
      expect(
        (await call('patch', '/cart/items/no-such', adminA, { quantity: 1 }))
          .status,
      ).toBe(404);
      expect((await call('delete', '/cart/items/no-such', adminA)).status).toBe(
        404,
      );
      expect(
        (
          await call('post', '/cart/items', adminA, {
            variantId: 'no-such',
            quantity: 1,
          })
        ).status,
      ).toBe(404);
    });
  });

  describe('tenant isolation and cross-tenant variant protection', () => {
    it('rejects foreign variant from other tenant with 404', async () => {
      expect(
        (
          await call('post', '/cart/items', adminA, {
            variantId: variantBId,
            quantity: 1,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call('post', '/cart/items', adminB, {
            variantId: variantAId,
            quantity: 1,
          })
        ).status,
      ).toBe(404);
    });

    it('carts are isolated per X-Tenant-ID', async () => {
      await call('post', '/cart/items', adminA, {
        variantId: variantAId,
        quantity: 2,
      });
      const cartA = (await call('get', '/cart', adminA))
        .body as unknown as CartBody;
      expect(cartA.items).toHaveLength(1);
      const cartB = (await call('get', '/cart', adminB))
        .body as unknown as CartBody;
      expect(cartB.items).toHaveLength(0);
      expect(cartB.id).not.toBe(cartA.id);
    });
  });

  describe('ownership isolation within same tenant', () => {
    it('user cannot see or mutate other user cart items', async () => {
      await call('post', '/cart/items', adminA, {
        variantId: variantAId,
        quantity: 2,
      });
      const cartA = (await call('get', '/cart', adminA))
        .body as unknown as CartBody;
      const itemId = cartA.items[0].id;

      const cartA2 = (await call('get', '/cart', userA2))
        .body as unknown as CartBody;
      expect(cartA2.items).toHaveLength(0);
      expect(cartA2.id).not.toBe(cartA.id);

      expect(
        (await call('patch', `/cart/items/${itemId}`, userA2, { quantity: 5 }))
          .status,
      ).toBe(404);
      expect(
        (await call('delete', `/cart/items/${itemId}`, userA2)).status,
      ).toBe(404);

      // userA2 adds same variant to own cart separately
      await call('post', '/cart/items', userA2, {
        variantId: variantAId,
        quantity: 1,
      });
      const cartA2After = (await call('get', '/cart', userA2))
        .body as unknown as CartBody;
      expect(cartA2After.items).toHaveLength(1);
      expect(cartA2After.items[0].quantity).toBe(1);
      // adminA cart unchanged
      const cartAAfter = (await call('get', '/cart', adminA))
        .body as unknown as CartBody;
      expect(cartAAfter.items[0].quantity).toBe(2);
    });

    it('owner semantic-all can manage own cart without grants', async () => {
      const get = await call('get', '/cart', ownerA);
      expect(get.status).toBe(200);
      const add = await call('post', '/cart/items', ownerA, {
        variantId: variantAId,
        quantity: 1,
      });
      expect(add.status).toBe(201);
      const cart = add.body as unknown as CartBody;
      const itemId = cart.items[0].id;
      expect(
        (await call('patch', `/cart/items/${itemId}`, ownerA, { quantity: 3 }))
          .status,
      ).toBe(200);
      expect(
        (await call('delete', `/cart/items/${itemId}`, ownerA)).status,
      ).toBe(200);
      await call('post', '/cart/items', ownerA, {
        variantId: variantAId,
        quantity: 1,
      });
      expect((await call('delete', '/cart', ownerA)).status).toBe(204);
    });
  });

  describe('validation contract', () => {
    it('rejects invalid add payloads with 400', async () => {
      const cases: Array<Record<string, unknown>> = [
        {},
        { variantId: variantAId },
        { quantity: 1 },
        { variantId: '', quantity: 1 },
        { variantId: variantAId, quantity: 0 },
        { variantId: variantAId, quantity: -1 },
        { variantId: variantAId, quantity: 1.5 },
        { variantId: variantAId, quantity: '1' },
        { variantId: variantAId, quantity: 1, bogus: true },
      ];
      for (const payload of cases) {
        const res = await call('post', '/cart/items', adminA, payload);
        expect(res.status).toBe(400);
      }
    });

    it('rejects tenantId injection on add', async () => {
      expect(
        (
          await call('post', '/cart/items', adminA, {
            variantId: variantAId,
            quantity: 1,
            tenantId: tenantBId,
          })
        ).status,
      ).toBe(400);
    });

    it('rejects invalid patch payloads with 400', async () => {
      await call('post', '/cart/items', adminA, {
        variantId: variantAId,
        quantity: 1,
      });
      const itemId = (
        (await call('get', '/cart', adminA)).body as unknown as CartBody
      ).items[0].id;
      expect(
        (await call('patch', `/cart/items/${itemId}`, adminA, { quantity: 0 }))
          .status,
      ).toBe(400);
      expect(
        (await call('patch', `/cart/items/${itemId}`, adminA, {})).status,
      ).toBe(400);
      expect(
        (
          await call('patch', `/cart/items/${itemId}`, adminA, {
            quantity: '1',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call('patch', `/cart/items/${itemId}`, adminA, {
            quantity: 1,
            variantId: variantAId,
          })
        ).status,
      ).toBe(400);
    });

    it('discard without cart returns 404', async () => {
      expect((await call('delete', '/cart', adminA)).status).toBe(404);
    });
  });
});
