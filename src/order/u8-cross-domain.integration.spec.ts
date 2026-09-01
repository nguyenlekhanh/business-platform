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
 * Phase 3 U8 — Cross-Domain Verification (integration).
 *
 * Verifies the two explicitly documented cross-domain requirements of the
 * approved Phase 3 assessment (§15 U8):
 *
 *   A. Customer deletion with existing Orders -> HTTP 409 (the D1-flagged
 *      additive P2003 branch in CustomerService.deleteCustomer). Customer
 *      with no Orders keeps the normal documented deletion behavior.
 *
 *   B. End-to-end commerce flow over the REAL application stack:
 *      Category -> Product -> ProductVariant -> Price -> Inventory ->
 *      Cart -> Order -> Payment -> Capture -> Order PAID, asserting
 *      actual persisted database state at every boundary (not just HTTP
 *      2xx), plus the cancellation/restock path (Order CANCELLED ->
 *      inventory restored exactly once; repeated cancellation does not
 *      double-restock).
 *
 * Uses the same architecture as every Phase 3 suite: full AppModule +
 * supertest, tenantA/B fixtures, real JWT + X-Tenant-ID, direct Prisma
 * row verification inside tenantContext.run(async () => ...).
 */
describe('U8 Cross-Domain (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }
  interface CartBody {
    id: string;
    status: string;
    items: Array<{ variantId: string; quantity: number }>;
    totals: Array<{ currency: string; totalMinor: string }>;
  }
  interface OrderBody {
    id: string;
    status: string;
    currency: string;
    subtotalMinor: string;
    customerId: string | null;
    items: Array<{
      variantId: string;
      sku: string;
      quantity: number;
      currency: string;
      unitAmountMinor: string;
      lineTotalMinor: string;
    }>;
  }
  interface PaymentBody {
    id: string;
    orderId: string;
    status: string;
    amountMinor: string;
    currency: string;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `u8-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
    method: 'get' | 'post' | 'patch' | 'delete' | 'put',
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
      await prisma.customer
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

  // ---- Shared fixtures -------------------------------------------------
  let tenantAId: string;
  let tenantBId: string;
  let adminA: Record<string, string>;
  let adminB: Record<string, string>;
  let ownerA: Record<string, string>;
  let adminAId: string;
  let ownerAId: string;
  let adminBId: string;

  const seqRef = { seq: 0 };

  const fullGrants = [
    PERMISSIONS.CATEGORY_READ,
    PERMISSIONS.CATEGORY_CREATE,
    PERMISSIONS.CATEGORY_MANAGE,
    PERMISSIONS.PRODUCT_READ,
    PERMISSIONS.PRODUCT_CREATE,
    PERMISSIONS.PRODUCT_MANAGE,
    PERMISSIONS.INVENTORY_READ,
    PERMISSIONS.INVENTORY_MANAGE,
    PERMISSIONS.CART_MANAGE,
    PERMISSIONS.ORDER_READ,
    PERMISSIONS.ORDER_CREATE,
    PERMISSIONS.ORDER_DELETE,
    PERMISSIONS.PAYMENT_READ,
    PERMISSIONS.PAYMENT_CREATE,
    PERMISSIONS.PAYMENT_MANAGE,
    PERMISSIONS.CUSTOMER_READ,
    PERMISSIONS.CUSTOMER_CREATE,
    PERMISSIONS.CUSTOMER_DELETE,
  ];

  beforeEach(async () => {
    seqRef.seq += 1;
    const seq = seqRef.seq;
    const tenantA = await createTenant('a');
    tenantAId = tenantA.id;
    const adminRole = await grantRole(tenantAId, `admin-a-${run}`, fullGrants);
    const ownerRole = await grantRole(tenantAId, SYSTEM_ROLE_KEYS.OWNER, []);
    adminAId = (
      await createUser(`admin-${run}-${seq}@a.test`, tenantAId, adminRole.id)
    ).id;
    ownerAId = (
      await createUser(`owner-${run}-${seq}@a.test`, tenantAId, ownerRole.id)
    ).id;

    const tenantB = await createTenant('b');
    tenantBId = tenantB.id;
    const adminRoleB = await grantRole(tenantBId, `admin-b-${run}`, fullGrants);
    adminBId = (
      await createUser(`admin-${run}-${seq}@b.test`, tenantBId, adminRoleB.id)
    ).id;

    adminA = await loginAs(adminAId, tenantAId);
    adminB = await loginAs(adminBId, tenantBId);
    ownerA = await loginAs(ownerAId, tenantAId);
  });

  /**
   * Provisions the full commerce catalog for tenant A through the REAL
   * HTTP APIs (not direct Prisma) so every cross-domain link is created
   * exactly the way production clients create it. Returns the variant id.
   * unitPrice is a BigInt for exact assertions; the price PUT payload sends
   * it as a JSON number (the validated DTO input form).
   */
  const provisionCatalogViaApi = async (
    headers: Record<string, string>,
    seq: number,
    unitPrice: bigint,
    currency: string,
    initialStock: number,
  ) => {
    const cat = await call('post', '/categories', headers, {
      name: `U8-CAT-${run}-${seq}`,
    });
    expect(cat.status).toBe(201);
    const catBody = cat.body as unknown as { id: string };
    expect(catBody.id).toBeDefined();

    const prod = await call('post', '/products', headers, {
      name: `U8-PROD-${run}-${seq}`,
      code: `U8CODE${seq}${run.slice(0, 6)}`,
      categoryId: catBody.id,
      status: 'ACTIVE',
    });
    expect(prod.status).toBe(201);
    const prodBody = prod.body as unknown as { id: string };

    const variant = await call(
      'post',
      `/products/${prodBody.id}/variants`,
      headers,
      { sku: `U8SKU-${run}-${seq}` },
    );
    expect(variant.status).toBe(201);
    const variantBody = variant.body as unknown as {
      id: string;
      prices: Array<{ currency: string; amountMinor: string }>;
    };

    const price = await call(
      'put',
      `/variants/${variantBody.id}/price`,
      headers,
      { currency, amountMinor: Number(unitPrice) },
    );
    // PUT price upsert: NestJS @Put default is 200 OK (no @HttpCode override
    // on this route) — either 200 (overwrite) or 201 (create) is the
    // documented upsert success envelope.
    expect([200, 201]).toContain(price.status);
    const priceBody = price.body as unknown as { amountMinor: string };

    const adjust = await call('post', '/inventory/adjust', headers, {
      variantId: variantBody.id,
      delta: initialStock,
      reason: 'U8 initial stock',
    });
    expect(adjust.status).toBe(201);

    return {
      categoryId: catBody.id,
      productId: prodBody.id,
      variantId: variantBody.id,
      priceMinor: priceBody.amountMinor,
    };
  };

  // P4-U3: the non-POS flows in this suite consume the tenant-GLOBAL pool
  // (storeId null) — read it with findFirst on the scoped pair.
  const getInventoryRow = (variantId: string) =>
    tenantContext.run(tenantAId, async () =>
      prisma.inventory.findFirst({ where: { variantId, storeId: null } }),
    );

  // ------------------------------------------------------------------
  // A. CUSTOMER DELETION WITH EXISTING ORDERS (documented D1 branch)
  // ------------------------------------------------------------------
  describe('customer deletion with orders (P2003 -> 409)', () => {
    it('customer with NO orders keeps the normal documented delete behavior', async () => {
      const create = await call('post', '/customers', adminA, {
        name: `U8 Free Customer ${run}`,
        code: `U8FREE-${run}`,
      });
      expect(create.status).toBe(201);
      const customer = create.body as unknown as { id: string };

      const del = await call('delete', `/customers/${customer.id}`, adminA);
      // Documented customer-delete success envelope: 204 No Content.
      expect(del.status).toBe(204);

      const row = await tenantContext.run(tenantAId, async () =>
        prisma.customer.findUnique({ where: { id: customer.id } }),
      );
      expect(row).toBeNull();
    });

    it('customer WITH an existing order cannot be deleted -> 409, order intact, no partial deletion', async () => {
      const seq = seqRef.seq;
      const cat = provisionCatalogViaApi(adminA, seq, 1500n, 'USD', 20);
      const { variantId } = await cat;

      const cust = await call('post', '/customers', adminA, {
        name: `U8 Ordered Customer ${run}`,
        code: `U8ORD-${run}`,
      });
      expect(cust.status).toBe(201);
      const customer = cust.body as unknown as { id: string };

      const order = await call('post', '/orders', adminA, {
        items: [{ variantId, quantity: 2 }],
        customerId: customer.id,
      });
      expect(order.status).toBe(201);
      const orderBody = order.body as unknown as OrderBody;
      expect(orderBody.customerId).toBe(customer.id);

      // THE flagged U8 requirement: deletion is blocked with 409.
      const del = await call('delete', `/customers/${customer.id}`, adminA);
      expect(del.status).toBe(409);
      expect((del.body as ErrorBody).message).toBe(
        'Customer has orders and cannot be deleted',
      );

      // No partial deletion: both the Customer and the Order rows remain.
      const customerRow = await tenantContext.run(tenantAId, async () =>
        prisma.customer.findUnique({ where: { id: customer.id } }),
      );
      expect(customerRow?.id).toBe(customer.id);
      const orderRow = await tenantContext.run(tenantAId, async () =>
        prisma.order.findUnique({ where: { id: orderBody.id } }),
      );
      expect(orderRow?.id).toBe(orderBody.id);
      expect(orderRow?.customerId).toBe(customer.id);
      expect(orderRow?.status).toBe('PENDING');

      // The order (and its items) remain fully queryable through the API.
      const fetched = await call('get', `/orders/${orderBody.id}`, adminA);
      expect(fetched.status).toBe(200);
      expect((fetched.body as OrderBody).customerId).toBe(customer.id);

      // Cleanup order first so afterAll tenant cascade can run cleanly.
      await call('post', `/orders/${orderBody.id}/cancel`, adminA);
    });

    it('customer with reservations (not orders) keeps the documented reservation message', async () => {
      // Direct Prisma fixture for the frozen rental domain (FROZEN code —
      // creation via API would need reservation permissions; direct tenant-
      // scoped inserts are the established pattern for reservation specs).
      const cust = await call('post', '/customers', adminA, {
        name: `U8 Resv Customer ${run}`,
        code: `U8RESV-${run}`,
      });
      expect(cust.status).toBe(201);
      const customer = cust.body as unknown as { id: string };

      // Minimum reservation row to trip the Reservation RESTRICT FK.
      const base = Date.now() + 24 * 60 * 60 * 1000;
      const iso = (h: number) =>
        new Date(base + h * 60 * 60 * 1000).toISOString();
      const asset = await tenantContext.run(tenantAId, async () =>
        prisma.asset.create({
          data: {
            tenantId: tenantAId,
            name: `U8 asset ${run}`,
            code: `U8A${run.slice(0, 8)}`,
            type: 'CRANE',
          },
        }),
      );
      const equipment = await tenantContext.run(tenantAId, async () =>
        prisma.equipment.create({
          data: { tenantId: tenantAId, assetId: asset.id, type: 'CRANE' },
        }),
      );
      await tenantContext.run(tenantAId, async () =>
        prisma.reservation.create({
          data: {
            tenantId: tenantAId,
            customerId: customer.id,
            equipmentId: equipment.id,
            startAt: new Date(iso(500)),
            endAt: new Date(iso(504)),
          },
        }),
      );

      const del = await call('delete', `/customers/${customer.id}`, adminA);
      expect(del.status).toBe(409);
      expect((del.body as ErrorBody).message).toBe(
        'Customer has reservations and cannot be deleted',
      );
    });

    it('cross-tenant deletion attempt reveals nothing (uniform 404)', async () => {
      const cust = await call('post', '/customers', adminA, {
        name: `U8 XTenant Customer ${run}`,
        code: `U8XT-${run}`,
      });
      expect(cust.status).toBe(201);
      const customer = cust.body as unknown as { id: string };

      // Tenant B admin asks to delete tenant A's customer: uniform 404.
      const del = await call('delete', `/customers/${customer.id}`, adminB);
      expect(del.status).toBe(404);
      expect((del.body as ErrorBody).message).toBe('Customer not found');

      // Tenant A's customer is untouched.
      const row = await tenantContext.run(tenantAId, async () =>
        prisma.customer.findUnique({ where: { id: customer.id } }),
      );
      expect(row?.id).toBe(customer.id);
    });
  });

  // ------------------------------------------------------------------
  // B. END-TO-END COMMERCE FLOW (real HTTP + persisted-state checks)
  // ------------------------------------------------------------------
  describe('end-to-end happy path: catalog -> cart -> order -> payment -> capture -> PAID', () => {
    it('walks the full flow and verifies persisted state at every boundary', async () => {
      const seq = seqRef.seq;
      const UNIT_PRICE = 1250n;
      const INITIAL_STOCK = 30;

      // --- 1..5. Category, Product, Variant, Price, Inventory (via API)
      const { categoryId, productId, variantId } = await provisionCatalogViaApi(
        adminA,
        seq,
        UNIT_PRICE,
        'USD',
        INITIAL_STOCK,
      );

      // Catalog persisted state
      const categoryRow = await tenantContext.run(tenantAId, async () =>
        prisma.category.findUnique({ where: { id: categoryId } }),
      );
      expect(categoryRow?.tenantId).toBe(tenantAId);
      const productRow = await tenantContext.run(tenantAId, async () =>
        prisma.product.findUnique({ where: { id: productId } }),
      );
      expect(productRow?.categoryId).toBe(categoryId);
      expect(productRow?.tenantId).toBe(tenantAId);
      const variantRow = await tenantContext.run(tenantAId, async () =>
        prisma.productVariant.findUnique({ where: { id: variantId } }),
      );
      expect(variantRow?.productId).toBe(productId);
      expect(variantRow?.tenantId).toBe(tenantAId);
      const priceRow = await tenantContext.run(tenantAId, async () =>
        prisma.price.findUnique({
          where: { variantId_currency: { variantId, currency: 'USD' } },
        }),
      );
      expect(priceRow?.amountMinor).toBe(UNIT_PRICE);
      const invRow = await getInventoryRow(variantId);
      expect(invRow?.quantityOnHand).toBe(INITIAL_STOCK);

      // --- 6. Cart + items (mixed quantities, one variant)
      const add1 = await call('post', '/cart/items', adminA, {
        variantId,
        quantity: 2,
      });
      expect(add1.status).toBe(201);
      const add2 = await call('post', '/cart/items', adminA, {
        variantId,
        quantity: 3,
      });
      expect(add2.status).toBe(201);
      const merged = add2.body as unknown as CartBody;
      expect(merged.items).toHaveLength(1); // merged by (cartId,variantId)
      expect(merged.items[0].quantity).toBe(5);
      expect(merged.totals).toEqual([{ currency: 'USD', totalMinor: '6250' }]);

      // --- 7. Order from cart checkout (empty body)
      const order = await call('post', '/orders', adminA, {});
      expect(order.status).toBe(201);
      const orderBody = order.body as unknown as OrderBody;
      expect(orderBody.status).toBe('PENDING');
      expect(orderBody.subtotalMinor).toBe('6250'); // 5 * 1250, exact BigInt math
      expect(orderBody.items).toHaveLength(1);
      expect(orderBody.items[0].quantity).toBe(5);

      // Cart converted inside the order transaction
      const cartRow = await tenantContext.run(tenantAId, async () =>
        prisma.cart.findUnique({ where: { id: merged.id } }),
      );
      expect(cartRow?.status).toBe('CONVERTED');

      // Inventory decremented by the order quantity
      const invAfterOrder = await getInventoryRow(variantId);
      expect(invAfterOrder?.quantityOnHand).toBe(INITIAL_STOCK - 5);

      // Order item snapshot: immutable price/name/sku at order time
      const itemRow = await tenantContext.run(tenantAId, async () =>
        prisma.orderItem.findFirst({ where: { orderId: orderBody.id } }),
      );
      expect(itemRow?.unitAmountMinor).toBe(UNIT_PRICE);
      expect(itemRow?.lineTotalMinor).toBe(UNIT_PRICE * 5n);
      expect(itemRow?.sku).toBe(variantRow?.sku);

      // --- 8. Payment creation (amount/currency derived from Order)
      const payment = await call('post', '/payments', adminA, {
        orderId: orderBody.id,
        method: 'CARD',
      });
      expect(payment.status).toBe(201);
      const paymentBody = payment.body as unknown as PaymentBody;
      expect(paymentBody.status).toBe('PROCESSING');
      expect(paymentBody.amountMinor).toBe('6250');
      expect(paymentBody.currency).toBe('USD');
      expect(typeof paymentBody.amountMinor).toBe('string');

      const paymentRow = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findUnique({ where: { id: paymentBody.id } }),
      );
      expect(paymentRow?.amountMinor).toBe(6250n);
      expect(paymentRow?.tenantId).toBe(tenantAId);

      // --- 9. Capture
      const capture = await call(
        'post',
        `/payments/${paymentBody.id}/capture`,
        adminA,
      );
      expect(capture.status).toBe(200);
      expect((capture.body as unknown as PaymentBody).status).toBe('CAPTURED');

      // --- 10. Final state: Payment CAPTURED, Order PAID, DB consistent
      const paymentFinal = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findUnique({ where: { id: paymentBody.id } }),
      );
      expect(paymentFinal?.status).toBe('CAPTURED');

      const orderFinal = await tenantContext.run(tenantAId, async () =>
        prisma.order.findUnique({ where: { id: orderBody.id } }),
      );
      expect(orderFinal?.status).toBe('PAID');

      const orderByApi = await call('get', `/orders/${orderBody.id}`, adminA);
      expect((orderByApi.body as OrderBody).status).toBe('PAID');

      // Post-capture invariants: canceling a PAID order is forbidden...
      const cancelPaid = await call(
        'post',
        `/orders/${orderBody.id}/cancel`,
        adminA,
      );
      expect(cancelPaid.status).toBe(409);
      // ...and a second payment for the now-PAID order is refused.
      const secondPayment = await call('post', '/payments', adminA, {
        orderId: orderBody.id,
        method: 'CASH',
      });
      expect(secondPayment.status).toBe(409);

      // Payment on the PAID order cannot be failed either (terminal).
      const failCaptured = await call(
        'post',
        `/payments/${paymentBody.id}/fail`,
        adminA,
      );
      expect(failCaptured.status).toBe(409);
      expect(
        failCaptured.body && (failCaptured.body as ErrorBody).message,
      ).toBe('Captured payment cannot be failed');
    });
  });

  // ------------------------------------------------------------------
  // C. CANCELLATION + RESTOCK PATH
  // ------------------------------------------------------------------
  describe('cancellation/restock path: order -> CANCELLED -> inventory restored once', () => {
    it('cancels a PENDING order and restores stock exactly once', async () => {
      const seq = seqRef.seq;
      const { variantId } = await provisionCatalogViaApi(
        adminA,
        seq,
        800n,
        'USD',
        10,
      );
      const before = await getInventoryRow(variantId);
      expect(before?.quantityOnHand).toBe(10);

      const order = await call('post', '/orders', adminA, {
        items: [{ variantId, quantity: 4 }],
      });
      expect(order.status).toBe(201);
      const orderBody = order.body as unknown as OrderBody;
      expect(orderBody.subtotalMinor).toBe('3200');

      const afterOrder = await getInventoryRow(variantId);
      expect(afterOrder?.quantityOnHand).toBe(6); // 10 - 4

      // Payment PROCESSING exists; cancellation of the PENDING order is
      // the documented T3 flow (guarded PENDING->CANCELLED + restock).
      const payment = await call('post', '/payments', adminA, {
        orderId: orderBody.id,
        method: 'CARD',
      });
      expect(payment.status).toBe(201);
      const paymentBody = payment.body as unknown as PaymentBody;

      const cancel = await call(
        'post',
        `/orders/${orderBody.id}/cancel`,
        adminA,
      );
      expect(cancel.status).toBe(200);
      expect((cancel.body as OrderBody).status).toBe('CANCELLED');

      // Inventory restored exactly once (6 -> 10, not 14).
      const afterCancel = await getInventoryRow(variantId);
      expect(afterCancel?.quantityOnHand).toBe(10);

      // The PROCESSING payment survives cancellation (documented rule:
      // cancel does not touch payments); it can no longer be captured
      // because the Order is not PENDING (guarded update -> 409).
      const captureAfterCancel = await call(
        'post',
        `/payments/${paymentBody.id}/capture`,
        adminA,
      );
      expect(captureAfterCancel.status).toBe(409);

      const paymentRow = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findUnique({ where: { id: paymentBody.id } }),
      );
      expect(paymentRow?.status).toBe('PROCESSING');

      // Repeated cancellation does NOT double-restock (guarded update:
      // second cancel hits the CANCELLED order -> 409, no stock write).
      const cancelAgain = await call(
        'post',
        `/orders/${orderBody.id}/cancel`,
        adminA,
      );
      expect(cancelAgain.status).toBe(409);
      expect((cancelAgain.body as ErrorBody).message).toBe(
        'Only pending orders can be cancelled',
      );

      const afterSecondCancel = await getInventoryRow(variantId);
      expect(afterSecondCancel?.quantityOnHand).toBe(10); // unchanged

      const orderRow = await tenantContext.run(tenantAId, async () =>
        prisma.order.findUnique({ where: { id: orderBody.id } }),
      );
      expect(orderRow?.status).toBe('CANCELLED');
      expect(orderRow?.cancelledAt).not.toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // D. CROSS-DOMAIN SECURITY BOUNDARIES
  // ------------------------------------------------------------------
  describe('cross-domain tenant isolation', () => {
    it('every cross-tenant reference into tenant A fails with the uniform 404', async () => {
      const seq = seqRef.seq;
      const { variantId } = await provisionCatalogViaApi(
        adminA,
        seq,
        900n,
        'USD',
        5,
      );
      const cust = await call('post', '/customers', adminA, {
        name: `U8 Iso Customer ${run}`,
        code: `U8ISO-${run}`,
      });
      const customer = cust.body as unknown as { id: string };

      await call('post', '/cart/items', adminA, { variantId, quantity: 1 });
      const order = await call('post', '/orders', adminA, {});
      const orderBody = order.body as unknown as OrderBody;
      const payment = await call('post', '/payments', adminA, {
        orderId: orderBody.id,
        method: 'CARD',
      });
      const paymentBody = payment.body as unknown as PaymentBody;

      // Tenant B cannot see or mutate ANY tenant A entity: uniform 404,
      // no existence oracle, no state change.
      const probes: Array<Promise<Res>> = [
        call('get', `/inventory/${variantId}`, adminB),
        call('post', '/cart/items', adminB, { variantId, quantity: 1 }),
        call('post', '/orders', adminB, {
          items: [{ variantId, quantity: 1 }],
        }),
        call('post', '/orders', adminB, {
          items: [{ variantId, quantity: 1 }],
          customerId: customer.id,
        }),
        call('get', `/orders/${orderBody.id}`, adminB),
        call('post', `/orders/${orderBody.id}/cancel`, adminB),
        call('get', `/payments/${paymentBody.id}`, adminB),
        call('post', `/payments/${paymentBody.id}/capture`, adminB),
        call('post', `/payments/${paymentBody.id}/fail`, adminB),
        call('post', '/payments', adminB, {
          orderId: orderBody.id,
          method: 'CARD',
        }),
      ];
      const results = await Promise.all(probes);
      for (const res of results) {
        expect([404, 400]).toContain(res.status);
        // 400 only for payloads rejected pre-routing by validation
        // (unknown/invalid shapes); any executed business path must 404.
      }

      // Explicit per-probe assertions for the executed business paths:
      expect(
        (await call('get', `/inventory/${variantId}`, adminB)).status,
      ).toBe(404);
      expect(
        (await call('post', '/cart/items', adminB, { variantId, quantity: 1 }))
          .status,
      ).toBe(404); // variant not found in tenant B
      expect(
        (
          await call('post', '/orders', adminB, {
            items: [{ variantId, quantity: 1 }],
          })
        ).status,
      ).toBe(404);
      expect(
        (await call('get', `/orders/${orderBody.id}`, adminB)).status,
      ).toBe(404);
      expect(
        (await call('post', `/orders/${orderBody.id}/cancel`, adminB)).status,
      ).toBe(404);
      expect(
        (await call('get', `/payments/${paymentBody.id}`, adminB)).status,
      ).toBe(404);
      expect(
        (await call('post', `/payments/${paymentBody.id}/capture`, adminB))
          .status,
      ).toBe(404);
      expect(
        (await call('post', `/payments/${paymentBody.id}/fail`, adminB)).status,
      ).toBe(404);
      expect(
        (
          await call('post', '/payments', adminB, {
            orderId: orderBody.id,
            method: 'CARD',
          })
        ).status,
      ).toBe(404);

      // Tenant A's state is fully intact after all foreign probes.
      const invRow = await getInventoryRow(variantId);
      expect(invRow?.quantityOnHand).toBe(4); // 5 - 1 (own order)
      const orderRow = await tenantContext.run(tenantAId, async () =>
        prisma.order.findUnique({ where: { id: orderBody.id } }),
      );
      expect(orderRow?.status).toBe('PENDING');
      const paymentRow = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findUnique({ where: { id: paymentBody.id } }),
      );
      expect(paymentRow?.status).toBe('PROCESSING');
    });

    it('server-derived tenantId cannot be overridden via payload injection', async () => {
      const seq = seqRef.seq;
      const { variantId } = await provisionCatalogViaApi(
        adminA,
        seq,
        700n,
        'USD',
        5,
      );

      const attempts: Array<{
        path: string;
        payload: Record<string, unknown>;
      }> = [
        {
          path: '/categories',
          payload: { name: `X ${run}`, tenantId: tenantBId },
        },
        {
          path: '/cart/items',
          payload: { variantId, quantity: 1, tenantId: tenantBId },
        },
        {
          path: '/orders',
          payload: {
            items: [{ variantId, quantity: 1 }],
            tenantId: tenantBId,
          },
        },
      ];
      for (const attempt of attempts) {
        const res = await call('post', attempt.path, adminA, attempt.payload);
        expect(res.status).toBe(400); // whitelist rejects tenantId
      }

      // Payment create with injected tenantId also rejected.
      const order = await call('post', '/orders', adminA, {
        items: [{ variantId, quantity: 1 }],
      });
      const orderBody = order.body as unknown as OrderBody;
      const res = await call('post', '/payments', adminA, {
        orderId: orderBody.id,
        method: 'CARD',
        tenantId: tenantBId,
      });
      expect(res.status).toBe(400);

      // And nothing leaked into tenant B regardless.
      const tenantBPayments = await tenantContext.run(tenantBId, async () =>
        prisma.payment.findMany({ where: { tenantId: tenantBId } }),
      );
      expect(tenantBPayments).toHaveLength(0);
    });

    it('owner semantic-all walks the full cross-domain flow without explicit grants', async () => {
      const seq = seqRef.seq;
      const { variantId } = await provisionCatalogViaApi(
        ownerA,
        seq,
        1000n,
        'USD',
        8,
      );
      await call('post', '/cart/items', ownerA, { variantId, quantity: 2 });
      const order = await call('post', '/orders', ownerA, {});
      expect(order.status).toBe(201);
      const orderBody = order.body as unknown as OrderBody;

      const payment = await call('post', '/payments', ownerA, {
        orderId: orderBody.id,
        method: 'CASH',
      });
      expect(payment.status).toBe(201);
      const paymentBody = payment.body as unknown as PaymentBody;

      const capture = await call(
        'post',
        `/payments/${paymentBody.id}/capture`,
        ownerA,
      );
      expect(capture.status).toBe(200);

      const orderRow = await tenantContext.run(tenantAId, async () =>
        prisma.order.findUnique({ where: { id: orderBody.id } }),
      );
      expect(orderRow?.status).toBe('PAID');
      const invRow = await getInventoryRow(variantId);
      expect(invRow?.quantityOnHand).toBe(6); // 8 - 2
    });
  });
});
