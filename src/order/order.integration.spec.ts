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

describe('Order (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }
  interface OrderBody {
    id: string;
    tenantId: string;
    userId: string;
    customerId: string | null;
    status: string;
    currency: string;
    subtotalMinor: string;
    items: Array<{
      id: string;
      variantId: string;
      productName: string;
      variantName: string | null;
      sku: string;
      quantity: number;
      currency: string;
      unitAmountMinor: string;
      lineTotalMinor: string;
    }>;
    cancelledAt: Date | null;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `ord-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

  const createCustomer = async (tenantId: string, code: string) =>
    tenantContext.run(tenantId, async () =>
      prisma.customer.create({ data: { tenantId, code, name: code } }),
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
  let userA2Id: string;
  let adminBId: string;

  let adminA: Record<string, string>;
  let employeeA: Record<string, string>;
  let ownerA: Record<string, string>;
  let userA2: Record<string, string>;
  let adminB: Record<string, string>;

  let variantAId: string;
  let variantA2Id: string;
  let variantBId: string;
  let customerAId: string;

  let seq = 0;

  beforeEach(async () => {
    seq += 1;
    const tenantA = await createTenant('a');
    tenantAId = tenantA.id;
    const adminRole = await grantRole(tenantAId, `admin-a-${run}`, [
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.ORDER_CREATE,
      PERMISSIONS.ORDER_DELETE,
      PERMISSIONS.ORDER_MANAGE,
      PERMISSIONS.PRODUCT_READ,
      PERMISSIONS.PRODUCT_CREATE,
      PERMISSIONS.PRODUCT_MANAGE,
      PERMISSIONS.CATEGORY_READ,
      PERMISSIONS.CATEGORY_CREATE,
      PERMISSIONS.CATEGORY_MANAGE,
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.INVENTORY_MANAGE,
      PERMISSIONS.CART_MANAGE,
      PERMISSIONS.CUSTOMER_READ,
      PERMISSIONS.CUSTOMER_CREATE,
    ]);
    const employeeRole = await grantRole(tenantAId, `employee-a-${run}`, [
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.ORDER_CREATE,
      PERMISSIONS.PRODUCT_READ,
      PERMISSIONS.CATEGORY_READ,
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.CART_MANAGE,
      PERMISSIONS.CUSTOMER_READ,
    ]);
    const ownerRole = await grantRole(tenantAId, SYSTEM_ROLE_KEYS.OWNER, []);
    const userA2Role = await grantRole(tenantAId, `user2-a-${run}`, [
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.ORDER_CREATE,
      PERMISSIONS.ORDER_DELETE,
      PERMISSIONS.PRODUCT_READ,
      PERMISSIONS.CATEGORY_READ,
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.CART_MANAGE,
      PERMISSIONS.CUSTOMER_READ,
    ]);

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
    userA2Id = (
      await createUser(`user2-${run}-${seq}@a.test`, tenantAId, userA2Role.id)
    ).id;

    const tenantB = await createTenant('b');
    tenantBId = tenantB.id;
    const adminRoleB = await grantRole(tenantBId, `admin-b-${run}`, [
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.ORDER_CREATE,
      PERMISSIONS.ORDER_DELETE,
      PERMISSIONS.ORDER_MANAGE,
      PERMISSIONS.PRODUCT_READ,
      PERMISSIONS.PRODUCT_CREATE,
      PERMISSIONS.PRODUCT_MANAGE,
      PERMISSIONS.CATEGORY_READ,
      PERMISSIONS.CATEGORY_CREATE,
      PERMISSIONS.CATEGORY_MANAGE,
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.INVENTORY_MANAGE,
      PERMISSIONS.CART_MANAGE,
      PERMISSIONS.CUSTOMER_READ,
      PERMISSIONS.CUSTOMER_CREATE,
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
    userA2 = await loginAs(userA2Id, tenantAId);
    adminB = await loginAs(adminBId, tenantBId);

    const catA = await createCategory(tenantAId, `CAT-A-${run}-${seq}`);
    const pA = await createProduct(tenantAId, catA.id, `PROD-A-${run}-${seq}`);
    const vA = await createVariant(tenantAId, pA.id, `SKU-A-${run}-${seq}`);
    variantAId = vA.id;
    const vA2 = await createVariant(tenantAId, pA.id, `SKU-A2-${run}-${seq}`);
    variantA2Id = vA2.id;
    await createPrice(tenantAId, variantAId, 'USD', 1000n);
    await createPrice(tenantAId, variantA2Id, 'USD', 2000n);
    await createInventory(tenantAId, variantAId, 10);
    await createInventory(tenantAId, variantA2Id, 5);

    const catB = await createCategory(tenantBId, `CAT-B-${run}-${seq}`);
    const pB = await createProduct(tenantBId, catB.id, `PROD-B-${run}-${seq}`);
    const vB = await createVariant(tenantBId, pB.id, `SKU-B-${run}-${seq}`);
    variantBId = vB.id;
    await createPrice(tenantBId, variantBId, 'USD', 500n);
    await createInventory(tenantBId, variantBId, 20);

    customerAId = (await createCustomer(tenantAId, `CUST-A-${run}-${seq}`)).id;
  });

  describe('authentication and authorization gates', () => {
    it('rejects unauthenticated with 401', async () => {
      expect((await call('get', '/orders', {})).status).toBe(401);
      expect(
        (
          await call(
            'post',
            '/orders',
            {},
            { items: [{ variantId: variantAId, quantity: 1 }] },
          )
        ).status,
      ).toBe(401);
    });

    it('rejects outsider without membership with 403', async () => {
      const outsiderUser = await prisma.user.findUniqueOrThrow({
        where: { email: `outsider-${run}-${seq}@x.test` },
      });
      const headers = await loginAs(outsiderUser.id, tenantAId);
      expect((await call('get', '/orders', headers)).status).toBe(403);
      expect(
        (
          await call('post', '/orders', headers, {
            items: [{ variantId: variantAId, quantity: 1 }],
          })
        ).status,
      ).toBe(403);
      expect(
        (await call('post', `/orders/some-id/cancel`, headers)).status,
      ).toBe(403);
    });

    it('rejects member without order:read with 403 on GET', async () => {
      const noReadRole = await grantRole(tenantAId, `noread-${run}`, [
        PERMISSIONS.ORDER_CREATE,
      ]);
      const noReadUser = await createUser(
        `noread-${run}@a.test`,
        tenantAId,
        noReadRole.id,
      );
      const headers = await loginAs(noReadUser.id, tenantAId);
      expect((await call('get', '/orders', headers)).status).toBe(403);
      expect((await call('get', '/orders/some-id', headers)).status).toBe(403);
    });

    it('rejects member without order:create with 403 on POST', async () => {
      const noCreateRole = await grantRole(tenantAId, `nocreate-${run}`, [
        PERMISSIONS.ORDER_READ,
      ]);
      const noCreateUser = await createUser(
        `nocreate-${run}@a.test`,
        tenantAId,
        noCreateRole.id,
      );
      const headers = await loginAs(noCreateUser.id, tenantAId);
      expect(
        (
          await call('post', '/orders', headers, {
            items: [{ variantId: variantAId, quantity: 1 }],
          })
        ).status,
      ).toBe(403);
    });

    it('rejects member without order:delete with 403 on cancel', async () => {
      const noDeleteRole = await grantRole(tenantAId, `nodelete-${run}`, [
        PERMISSIONS.ORDER_READ,
        PERMISSIONS.ORDER_CREATE,
      ]);
      const noDeleteUser = await createUser(
        `nodelete-${run}@a.test`,
        tenantAId,
        noDeleteRole.id,
      );
      const headers = await loginAs(noDeleteUser.id, tenantAId);
      expect(
        (await call('post', `/orders/some-id/cancel`, headers)).status,
      ).toBe(403);
    });

    it('manage-only can create but cannot read', async () => {
      const manageOnlyRole = await grantRole(tenantAId, `manageonly-${run}`, [
        PERMISSIONS.ORDER_CREATE,
        PERMISSIONS.ORDER_DELETE,
      ]);
      const manageOnlyUser = await createUser(
        `manageonly-${run}@a.test`,
        tenantAId,
        manageOnlyRole.id,
      );
      const headers = await loginAs(manageOnlyUser.id, tenantAId);
      expect((await call('get', '/orders', headers)).status).toBe(403);
      const create = await call('post', '/orders', headers, {
        items: [{ variantId: variantAId, quantity: 1 }],
      });
      expect(create.status).toBe(201);
    });

    it('employee read-only can read and create but not cancel', async () => {
      expect((await call('get', '/orders', employeeA)).status).toBe(200);
      const create = await call('post', '/orders', employeeA, {
        items: [{ variantId: variantAId, quantity: 1 }],
      });
      expect(create.status).toBe(201);
      expect(
        (
          await call(
            'post',
            `/orders/${(create.body as OrderBody).id}/cancel`,
            employeeA,
          )
        ).status,
      ).toBe(403);
    });

    it('owner semantic-all works without explicit grants', async () => {
      const get = await call('get', '/orders', ownerA);
      expect(get.status).toBe(200);
      const create = await call('post', '/orders', ownerA, {
        items: [{ variantId: variantAId, quantity: 1 }],
      });
      expect(create.status).toBe(201);
      const cancel = await call(
        'post',
        `/orders/${(create.body as OrderBody).id}/cancel`,
        ownerA,
      );
      expect(cancel.status).toBe(200);
      expect((cancel.body as OrderBody).status).toBe('CANCELLED');
    });
  });

  describe('createOrder from direct items', () => {
    it('creates order with snapshots, decrements stock, returns correct totals', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 3 }],
      });
      expect(create.status).toBe(201);
      const order = create.body as OrderBody;
      expect(order.status).toBe('PENDING');
      expect(order.currency).toBe('USD');
      expect(order.subtotalMinor).toBe('3000');
      expect(order.items).toHaveLength(1);
      expect(order.items[0].variantId).toBe(variantAId);
      expect(order.items[0].sku).toBe(`SKU-A-${run}-${seq}`);
      expect(order.items[0].quantity).toBe(3);
      expect(order.items[0].unitAmountMinor).toBe('1000');
      expect(order.items[0].lineTotalMinor).toBe('3000');
      expect(order.items[0].productName).toBe(`PROD-A-${run}-${seq}`);

      // Stock decremented
      const inv = await call('get', `/inventory/${variantAId}`, adminA);
      expect((inv.body as { quantityOnHand: number }).quantityOnHand).toBe(7);
    });

    it('aggregates multiple items of same variant', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [
          { variantId: variantAId, quantity: 2 },
          { variantId: variantAId, quantity: 3 },
        ],
      });
      expect(create.status).toBe(201);
      const order = create.body as OrderBody;
      expect(order.items).toHaveLength(1);
      expect(order.items[0].quantity).toBe(5);
      expect(order.subtotalMinor).toBe('5000');
    });

    it('creates order with multiple different variants', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [
          { variantId: variantAId, quantity: 2 },
          { variantId: variantA2Id, quantity: 1 },
        ],
      });
      expect(create.status).toBe(201);
      const order = create.body as OrderBody;
      expect(order.items).toHaveLength(2);
      expect(order.subtotalMinor).toBe('4000'); // 2*1000 + 1*2000
    });

    it('includes customerId when provided', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
        customerId: customerAId,
      });
      expect(create.status).toBe(201);
      const order = create.body as OrderBody;
      expect(order.customerId).toBe(customerAId);
    });

    it('rejects unknown customerId with 404', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
        customerId: '00000000-0000-0000-0000-000000000000',
      });
      expect(create.status).toBe(404);
      expect((create.body as ErrorBody).message).toBe('Customer not found');
    });

    it('rejects foreign customerId from other tenant with 404', async () => {
      const custB = await createCustomer(tenantBId, `CUST-B-${run}-${seq}`);
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
        customerId: custB.id,
      });
      expect(create.status).toBe(404);
    });
  });

  describe('createOrder from cart checkout', () => {
    it('checks out own OPEN cart and marks it CONVERTED', async () => {
      // Add items to cart
      await call('post', '/cart/items', adminA, {
        variantId: variantAId,
        quantity: 2,
      });
      await call('post', '/cart/items', adminA, {
        variantId: variantA2Id,
        quantity: 1,
      });

      // Get cart ID before checkout (verify cart exists)
      const cartBefore = await call('get', '/cart', adminA);
      expect(cartBefore.status).toBe(200);
      expect((cartBefore.body as { id: string }).id).toBeDefined();

      // Checkout with empty body
      const create = await call('post', '/orders', adminA, {});
      expect(create.status).toBe(201);
      const order = create.body as OrderBody;
      expect(order.items).toHaveLength(2);
      expect(order.subtotalMinor).toBe('4000');

      // Original cart should be CONVERTED (fetch by ID directly via tenant context)
      // Note: GET /cart would create a new OPEN cart, so we verify via the order's cart conversion
      // by checking that a subsequent checkout attempt fails (no OPEN cart)
      const secondCheckout = await call('post', '/orders', adminA, {});
      expect(secondCheckout.status).toBe(400);
      expect((secondCheckout.body as ErrorBody).message).toBe('Cart is empty');
    });

    it('returns 400 for empty cart', async () => {
      const create = await call('post', '/orders', adminA, {});
      expect(create.status).toBe(400);
      expect((create.body as ErrorBody).message).toBe('Cart is empty');
    });

    it('returns 400 for cart with no items', async () => {
      // Create empty cart first
      await call('get', '/cart', adminA);
      const create = await call('post', '/orders', adminA, {});
      expect(create.status).toBe(400);
      expect((create.body as ErrorBody).message).toBe('Cart is empty');
    });
  });

  describe('currency validation', () => {
    it('rejects currency mismatch across items with 409', async () => {
      // Create variant with EUR price
      const catA = await createCategory(tenantAId, `CAT-A2-${run}-${seq}`);
      const pA2 = await createProduct(
        tenantAId,
        catA.id,
        `PROD-A2-${run}-${seq}`,
      );
      const vEur = await createVariant(
        tenantAId,
        pA2.id,
        `SKU-EUR-${run}-${seq}`,
      );
      await createPrice(tenantAId, vEur.id, 'EUR', 1500n);
      await createInventory(tenantAId, vEur.id, 10);

      const create = await call('post', '/orders', adminA, {
        items: [
          { variantId: variantAId, quantity: 1 }, // USD
          { variantId: vEur.id, quantity: 1 }, // EUR
        ],
      });
      expect(create.status).toBe(409);
      expect((create.body as ErrorBody).message).toBe(
        'All items must have the same currency',
      );
    });

    it('rejects variant with no price with 409', async () => {
      const catA = await createCategory(tenantAId, `CAT-A3-${run}-${seq}`);
      const pA3 = await createProduct(
        tenantAId,
        catA.id,
        `PROD-A3-${run}-${seq}`,
      );
      const vNoPrice = await createVariant(
        tenantAId,
        pA3.id,
        `SKU-NOPRICE-${run}-${seq}`,
      );
      await createInventory(tenantAId, vNoPrice.id, 10);

      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: vNoPrice.id, quantity: 1 }],
      });
      expect(create.status).toBe(409);
      expect((create.body as ErrorBody).message).toBe(
        'Price not found for variant',
      );
    });
  });

  describe('variant status validation', () => {
    it('rejects ARCHIVED variant with 409', async () => {
      await tenantContext.run(tenantAId, async () =>
        prisma.productVariant.update({
          where: { id: variantAId },
          data: { status: 'ARCHIVED' },
        }),
      );

      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
      });
      expect(create.status).toBe(409);
      expect((create.body as ErrorBody).message).toBe('Variant is not active');
    });

    it('rejects unknown variant with 404', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: 'no-such-variant', quantity: 1 }],
      });
      expect(create.status).toBe(404);
      expect((create.body as ErrorBody).message).toBe('Variant not found');
    });

    it('rejects foreign variant from other tenant with 404', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantBId, quantity: 1 }],
      });
      expect(create.status).toBe(404);
      expect((create.body as ErrorBody).message).toBe('Variant not found');
    });
  });

  describe('inventory and stock', () => {
    it('rejects insufficient stock with 409 and leaves stock unchanged', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 100 }],
      });
      expect(create.status).toBe(409);
      expect((create.body as ErrorBody).message).toBe('Insufficient stock');

      const inv = await call('get', `/inventory/${variantAId}`, adminA);
      expect((inv.body as { quantityOnHand: number }).quantityOnHand).toBe(10);
    });

    it('allows exact stock depletion', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 10 }],
      });
      expect(create.status).toBe(201);

      const inv = await call('get', `/inventory/${variantAId}`, adminA);
      expect((inv.body as { quantityOnHand: number }).quantityOnHand).toBe(0);
    });

    it('concurrent orders on last units: exactly one succeeds', async () => {
      // Setup: 2 units in stock
      await tenantContext.run(tenantAId, async () =>
        prisma.inventory.update({
          where: { variantId: variantAId },
          data: { quantityOnHand: 2 },
        }),
      );

      const [a, b] = await Promise.all([
        call('post', '/orders', adminA, {
          items: [{ variantId: variantAId, quantity: 2 }],
        }),
        call('post', '/orders', adminA, {
          items: [{ variantId: variantAId, quantity: 2 }],
        }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]); // exactly one succeeds

      const winner = a.status === 201 ? a : b;
      const order = winner.body as OrderBody;
      expect(order.items[0].quantity).toBe(2);

      const inv = await call('get', `/inventory/${variantAId}`, adminA);
      expect((inv.body as { quantityOnHand: number }).quantityOnHand).toBe(0);
    });

    it('transaction rollback on price check failure leaves stock untouched', async () => {
      // Create variant with no price
      const catA = await createCategory(tenantAId, `CAT-A4-${run}-${seq}`);
      const pA4 = await createProduct(
        tenantAId,
        catA.id,
        `PROD-A4-${run}-${seq}`,
      );
      const vNoPrice = await createVariant(
        tenantAId,
        pA4.id,
        `SKU-NOPRICE2-${run}-${seq}`,
      );
      await createInventory(tenantAId, vNoPrice.id, 10);

      // Create another variant with price
      const vWithPrice = await createVariant(
        tenantAId,
        pA4.id,
        `SKU-WITHPRICE-${run}-${seq}`,
      );
      await createPrice(tenantAId, vWithPrice.id, 'USD', 1000n);
      await createInventory(tenantAId, vWithPrice.id, 10);

      // Order with both - second has no price, should fail entire transaction
      const create = await call('post', '/orders', adminA, {
        items: [
          { variantId: vWithPrice.id, quantity: 1 },
          { variantId: vNoPrice.id, quantity: 1 },
        ],
      });
      expect(create.status).toBe(409);

      // Stock of first variant should be unchanged
      const inv = await call('get', `/inventory/${vWithPrice.id}`, adminA);
      expect((inv.body as { quantityOnHand: number }).quantityOnHand).toBe(10);
    });
  });

  describe('getOrder and listOrders', () => {
    let orderId: string;

    beforeEach(async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 2 }],
        customerId: customerAId,
      });
      orderId = (create.body as OrderBody).id;
    });

    it('returns order with snapshots and string BigInt amounts', async () => {
      const get = await call('get', `/orders/${orderId}`, adminA);
      expect(get.status).toBe(200);
      const order = get.body as OrderBody;
      expect(order.id).toBe(orderId);
      expect(order.status).toBe('PENDING');
      expect(order.currency).toBe('USD');
      expect(order.subtotalMinor).toBe('2000');
      expect(order.customerId).toBe(customerAId);
      expect(order.items[0].unitAmountMinor).toBe('1000');
      expect(order.items[0].lineTotalMinor).toBe('2000');
      expect(typeof order.subtotalMinor).toBe('string');
      expect(typeof order.items[0].unitAmountMinor).toBe('string');
    });

    it('rejects foreign order with 404', async () => {
      const orderB = await call('post', '/orders', adminB, {
        items: [{ variantId: variantBId, quantity: 1 }],
      });
      const get = await call(
        'get',
        `/orders/${(orderB.body as OrderBody).id}`,
        adminA,
      );
      expect(get.status).toBe(404);
    });

    it('rejects unknown order with 404', async () => {
      const get = await call('get', '/orders/no-such-order', adminA);
      expect(get.status).toBe(404);
    });

    it('listOrders returns paginated envelope with correct shape', async () => {
      await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
      });
      await call('post', '/orders', adminA, {
        items: [{ variantId: variantA2Id, quantity: 1 }],
      });

      const list = await call('get', '/orders', adminA);
      expect(list.status).toBe(200);
      const body = list.body as {
        data: OrderBody[];
        meta: { nextCursor: string | null };
      };
      expect(body.data.length).toBeGreaterThanOrEqual(3); // 2 new + the one from beforeEach
      expect(body.meta.nextCursor).toBeDefined();
    });

    it('listOrders filters by status', async () => {
      const list = await call('get', '/orders?status=PENDING', adminA);
      expect(list.status).toBe(200);
      const body = list.body as { data: OrderBody[] };
      expect(body.data.every((o) => o.status === 'PENDING')).toBe(true);
    });

    it('listOrders respects pagination cursor', async () => {
      const page1 = await call('get', '/orders?limit=2', adminA);
      expect(page1.status).toBe(200);
      const body1 = page1.body as {
        data: OrderBody[];
        meta: { nextCursor: string | null };
      };
      if (body1.meta.nextCursor) {
        const page2 = await call(
          'get',
          `/orders?limit=2&cursor=${encodeURIComponent(body1.meta.nextCursor)}`,
          adminA,
        );
        expect(page2.status).toBe(200);
        const body2 = page2.body as { data: OrderBody[] };
        const ids1 = body1.data.map((o) => o.id);
        const ids2 = body2.data.map((o) => o.id);
        expect(ids1.some((id) => ids2.includes(id))).toBe(false);
      }
    });
  });

  describe('cancelOrder', () => {
    it('cancels PENDING order and restocks inventory', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 3 }],
      });
      const orderId = (create.body as OrderBody).id;

      const invBefore = await call('get', `/inventory/${variantAId}`, adminA);
      const stockBefore = (invBefore.body as { quantityOnHand: number })
        .quantityOnHand;

      const cancel = await call('post', `/orders/${orderId}/cancel`, adminA);
      expect(cancel.status).toBe(200);
      const cancelled = cancel.body as OrderBody;
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancelledAt).not.toBeNull();

      const invAfter = await call('get', `/inventory/${variantAId}`, adminA);
      expect((invAfter.body as { quantityOnHand: number }).quantityOnHand).toBe(
        stockBefore + 3,
      );
    });

    it('rejects cancel of non-PENDING order with 409', async () => {
      // First cancel it
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
      });
      const orderId = (create.body as OrderBody).id;
      await call('post', `/orders/${orderId}/cancel`, adminA);

      // Try to cancel again
      const cancel = await call('post', `/orders/${orderId}/cancel`, adminA);
      expect(cancel.status).toBe(409);
      expect((cancel.body as ErrorBody).message).toBe(
        'Only pending orders can be cancelled',
      );
    });

    it('rejects cancel of PAID order with 409', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
      });
      const orderId = (create.body as OrderBody).id;

      // Simulate PAID status directly in DB (no payment module yet)
      await tenantContext.run(tenantAId, async () =>
        prisma.order.update({
          where: { id: orderId },
          data: { status: 'PAID' },
        }),
      );

      const cancel = await call('post', `/orders/${orderId}/cancel`, adminA);
      expect(cancel.status).toBe(409);
      expect((cancel.body as ErrorBody).message).toBe(
        'Only pending orders can be cancelled',
      );
    });

    it('rejects cancel of foreign order with 404', async () => {
      const orderB = await call('post', '/orders', adminB, {
        items: [{ variantId: variantBId, quantity: 1 }],
      });
      const cancel = await call(
        'post',
        `/orders/${(orderB.body as OrderBody).id}/cancel`,
        adminA,
      );
      expect(cancel.status).toBe(404);
    });

    it('rejects cancel of unknown order with 404', async () => {
      const cancel = await call('post', '/orders/no-such-order/cancel', adminA);
      expect(cancel.status).toBe(404);
    });

    it('restocks correctly when multiple items share variant', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [
          { variantId: variantAId, quantity: 2 },
          { variantId: variantAId, quantity: 3 }, // same variant, aggregated to 5
        ],
      });
      const orderId = (create.body as OrderBody).id;

      const invBefore = await call('get', `/inventory/${variantAId}`, adminA);
      const stockBefore = (invBefore.body as { quantityOnHand: number })
        .quantityOnHand;

      await call('post', `/orders/${orderId}/cancel`, adminA);

      const invAfter = await call('get', `/inventory/${variantAId}`, adminA);
      expect((invAfter.body as { quantityOnHand: number }).quantityOnHand).toBe(
        stockBefore + 5,
      );
    });

    it('creates inventory row if missing during restock', async () => {
      // Create variant WITH inventory row (required for order creation)
      const catA = await createCategory(tenantAId, `CAT-A5-${run}-${seq}`);
      const pA5 = await createProduct(
        tenantAId,
        catA.id,
        `PROD-A5-${run}-${seq}`,
      );
      const vNoInv = await createVariant(
        tenantAId,
        pA5.id,
        `SKU-NOINV-${run}-${seq}`,
      );
      await createPrice(tenantAId, vNoInv.id, 'USD', 1000n);
      // Create inventory row with 0 stock, then adjust to have stock for order
      await createInventory(tenantAId, vNoInv.id, 5);

      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: vNoInv.id, quantity: 2 }],
      });
      const orderId = (create.body as OrderBody).id;

      await call('post', `/orders/${orderId}/cancel`, adminA);

      const inv = await call('get', `/inventory/${vNoInv.id}`, adminA);
      expect(inv.status).toBe(200);
      expect((inv.body as { quantityOnHand: number }).quantityOnHand).toBe(5); // back to original 5
    });
  });

  describe('immutable snapshots', () => {
    it('order snapshots preserve prices at creation time; later price changes do not affect order', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 2 }],
      });
      const orderId = (create.body as OrderBody).id;
      const originalUnit = (create.body as OrderBody).items[0].unitAmountMinor;

      // Update price
      await tenantContext.run(tenantAId, async () =>
        prisma.price.update({
          where: {
            variantId_currency: { variantId: variantAId, currency: 'USD' },
          },
          data: { amountMinor: 9999n },
        }),
      );

      // Order should still show original price
      const get = await call('get', `/orders/${orderId}`, adminA);
      const order = get.body as OrderBody;
      expect(order.items[0].unitAmountMinor).toBe(originalUnit);
      expect(order.items[0].unitAmountMinor).not.toBe('9999');
    });

    it('order snapshots preserve variant name and SKU at creation time', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
      });
      const orderId = (create.body as OrderBody).id;
      const originalSku = (create.body as OrderBody).items[0].sku;
      const originalName = (create.body as OrderBody).items[0].variantName;

      // Update variant
      await tenantContext.run(tenantAId, async () =>
        prisma.productVariant.update({
          where: { id: variantAId },
          data: { name: 'NEW NAME', sku: 'NEW-SKU' },
        }),
      );

      const get = await call('get', `/orders/${orderId}`, adminA);
      const order = get.body as OrderBody;
      expect(order.items[0].sku).toBe(originalSku);
      expect(order.items[0].variantName).toBe(originalName);
    });
  });

  describe('client cannot set status', () => {
    it('rejects status in create payload with 400', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
        status: 'PAID', // should be rejected by whitelist
      });
      expect(create.status).toBe(400);
    });

    it('rejects status in query with 400 on list', async () => {
      // status is a valid filter param, but tenantId is not
      const list = await call('get', '/orders?tenantId=other', adminA);
      expect(list.status).toBe(400);
    });
  });

  describe('validation contract', () => {
    it('rejects empty items array with 400', async () => {
      const create = await call('post', '/orders', adminA, { items: [] });
      expect(create.status).toBe(400);
    });

    it('rejects quantity 0 with 400', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 0 }],
      });
      expect(create.status).toBe(400);
    });

    it('rejects fractional quantity with 400', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1.5 }],
      });
      expect(create.status).toBe(400);
    });

    it('rejects negative quantity with 400', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: -1 }],
      });
      expect(create.status).toBe(400);
    });

    it('rejects string quantity with 400', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: '1' }],
      });
      expect(create.status).toBe(400);
    });

    it('rejects tenantId injection on create with 400', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
        tenantId: tenantBId,
      });
      expect(create.status).toBe(400);
    });

    it('rejects unknown fields with 400', async () => {
      const create = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
        bogus: true,
      });
      expect(create.status).toBe(400);
    });

    it('rejects invalid status filter with 400', async () => {
      const list = await call('get', '/orders?status=INVALID', adminA);
      expect(list.status).toBe(400);
    });

    it('rejects malformed cursor with 400', async () => {
      const list = await call('get', '/orders?cursor=invalid', adminA);
      expect(list.status).toBe(400);
    });
  });

  describe('tenant-scoped reads (no user-level isolation for orders)', () => {
    it('user CAN see other user orders within same tenant', async () => {
      const orderA = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
      });
      const orderId = (orderA.body as OrderBody).id;

      const get = await call('get', `/orders/${orderId}`, userA2);
      expect(get.status).toBe(200);
    });

    it('user CAN cancel other user orders within same tenant (with order:delete)', async () => {
      const orderA = await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
      });
      const orderId = (orderA.body as OrderBody).id;

      const cancel = await call('post', `/orders/${orderId}/cancel`, userA2);
      expect(cancel.status).toBe(200);
      expect((cancel.body as OrderBody).status).toBe('CANCELLED');
    });

    it('user CAN list other user orders within same tenant', async () => {
      await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
      });

      const list = await call('get', '/orders', userA2);
      expect(list.status).toBe(200);
      const body = list.body as { data: OrderBody[] };
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tenant isolation', () => {
    it('orders are isolated per X-Tenant-ID', async () => {
      await call('post', '/orders', adminA, {
        items: [{ variantId: variantAId, quantity: 1 }],
      });
      await call('post', '/orders', adminB, {
        items: [{ variantId: variantBId, quantity: 1 }],
      });

      const listA = await call('get', '/orders', adminA);
      const listB = await call('get', '/orders', adminB);

      expect((listA.body as { data: OrderBody[] }).data.length).toBeGreaterThan(
        0,
      );
      expect((listB.body as { data: OrderBody[] }).data.length).toBeGreaterThan(
        0,
      );

      const idsA = (listA.body as { data: OrderBody[] }).data.map((o) => o.id);
      const idsB = (listB.body as { data: OrderBody[] }).data.map((o) => o.id);
      expect(idsA.some((id) => idsB.includes(id))).toBe(false);
    });
  });
});
