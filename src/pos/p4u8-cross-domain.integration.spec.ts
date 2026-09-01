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
 * Phase 4 P4-U8 â€” Cross-device / Cross-domain Verification suite.
 *
 * A CONSOLIDATED verification of the ownership chains across the offline
 * POS architecture, over the REAL stack (full AppModule + supertest + real
 * PostgreSQL). It exercises the discovery-matrix patterns end to end:
 *
 *   Tenant -> Store -> Device -> Session -> Operation -> (Order -> Payment)
 *   Tenant -> Store -> Inventory
 *   Tenant -> PosFeedEvent
 *
 * Focus areas (per the P4-U8 charter):
 *   - TWO devices offline simultaneously, each with its own session,
 *     store pool, and intents; last-unit cross-device race at sync ->
 *     exactly one ACCEPTED, one deterministic OUT_OF_STOCK, each pool
 *     consistent, no cross-pool leakage;
 *   - credential matrix: device A's credential cannot touch device B's
 *     operation (401), B's report/feed are tenant-scoped 404 across
 *     tenants and correct within one tenant;
 *   - replay of the full tenant-A reconciliation snapshot against tenant
 *     B (every identifier) -> uniform 404 / empty-isolated feed, zero
 *     leakage (the "cursor replay" pattern);
 *   - cross-session semantics: an op retains its original session after
 *     close; a new session never rebinds it; a different session's
 *     device list never contains it;
 *   - accepted op -> Order/Payment fully tenant+provenance-isolated;
 *     rejected op -> zero cross-domain mutation (orders/payments/stock
 *     counts across BOTH tenants);
 *   - duplicate + concurrent sync within the correct scope.
 */
describe('P4-U8 Cross-device / Cross-domain (integration)', () => {
  interface SyncResultBody {
    operationId: string;
    status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
    resultCode: string | null;
    orderId: string | null;
    paymentId: string | null;
  }
  interface ReportBody {
    totals: { pending: number; accepted: number; rejected: number };
    rejected: Array<{ operationId: string; resultCode: string | null }>;
    accepted: Array<{ operationId: string; orderId: string | null }>;
    pending: Array<{ operationId: string }>;
  }
  interface FeedPageBody {
    entries: Array<{ feedSeq: number; kind: string; entityId: string }>;
    nextCursor: number;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `u8pos-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
      const tenants = tenantIdsToDelete;
      await prisma.posFeedEvent
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await prisma.posOperationItem
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await prisma.posOperation
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await prisma.posSale
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await prisma.payment
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await prisma.orderItem
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await prisma.order
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await prisma.posSession
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await prisma.posDevice
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await prisma.inventory
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await prisma.price
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await prisma.productVariant
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await prisma.product
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await prisma.category
        .deleteMany({ where: { tenantId: { in: tenants } } })
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
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await prisma.tenant
        .deleteMany({ where: { id: { in: tenants } } })
        .catch(() => undefined);
    }
    if (app) await app.close();
  });

  // ---- Shared fixtures ------------------------------------------------
  let tenantAId: string;
  let tenantBId: string;
  let storeA1Id: string;
  let storeA2Id: string;
  let cashierA: Record<string, string>;
  let managerA: Record<string, string>;
  let adminB: Record<string, string>;

  let seqCounter = 0;

  beforeEach(async () => {
    seqCounter += 1;
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
    storeA1Id = (await mkStore(`S1-${run}`)).id;
    storeA2Id = (await mkStore(`S2-${run}`)).id;

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

    const tenantB = await createTenant('b');
    tenantBId = tenantB.id;
    // Tenant B's own store exists for the isolation fixture; no probe
    // needs its id directly (cross-tenant access goes through adminB's
    // headers, and tenant-scoping makes every tenant-A id invisible).
    await tenantContext.run(tenantBId, async () =>
      prisma.store.create({
        data: {
          tenantId: tenantBId,
          name: `SB-${run}-${seqCounter}`,
          code: `SB-${run}-${seqCounter}`,
          type: 'POS',
          status: 'ACTIVE',
        },
      }),
    );
    const adminRoleB = await grantRole(tenantBId, `admin-b-${run}`, [
      PERMISSIONS.POS_READ,
      PERMISSIONS.POS_CREATE,
      PERMISSIONS.POS_MANAGE,
      // Cross-domain read keys so the tenant-isolation probes reach the
      // tenant-scoping layer (uniform 404) rather than stopping at RBAC.
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.PAYMENT_READ,
      PERMISSIONS.INVENTORY_READ,
    ]);
    const adminBUser = await createUser(
      `admin-${run}-${seqCounter}@b.test`,
      tenantBId,
      adminRoleB.id,
    );

    cashierA = await loginAs(cashierUser.id, tenantAId);
    managerA = await loginAs(managerUser.id, tenantAId);
    adminB = await loginAs(adminBUser.id, tenantBId);
  });

  /** Registers a device on a store; returns id + one-time credential. */
  const registerDevice = async (storeId: string, name: string) => {
    const res = await call('post', '/pos/devices', managerA, { storeId, name });
    expect(res.status).toBe(201);
    return res.body as { id: string; credential: string };
  };

  const openSession = async (deviceId: string) => {
    const res = await call('post', '/pos/sessions', cashierA, { deviceId });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };

  const uuid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  /** Prices variant in USD on the tenant + seeds a store pool. */
  const provisionVariant = async (label: string, unitPrice: bigint) => {
    const cat = await tenantContext.run(tenantAId, async () =>
      prisma.category.create({
        data: { tenantId: tenantAId, name: `CAT-${label}` },
      }),
    );
    const prod = await tenantContext.run(tenantAId, async () =>
      prisma.product.create({
        data: {
          tenantId: tenantAId,
          categoryId: cat.id,
          name: `PROD-${label}`,
          code: `CODE-${label}`,
          status: 'ACTIVE',
        },
      }),
    );
    const variant = await tenantContext.run(tenantAId, async () =>
      prisma.productVariant.create({
        data: { tenantId: tenantAId, productId: prod.id, sku: `SKU-${label}` },
      }),
    );
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
    return variant.id;
  };

  const seedStorePool = async (
    variantId: string,
    storeId: string,
    qty: number,
  ) =>
    tenantContext.run(tenantAId, async () =>
      prisma.inventory.create({
        data: { tenantId: tenantAId, variantId, storeId, quantityOnHand: qty },
      }),
    );

  const poolRow = (variantId: string, storeId: string) =>
    tenantContext.run(tenantAId, async () =>
      prisma.inventory.findFirst({ where: { variantId, storeId } }),
    );

  const recordIntent = async (
    sessionId: string,
    variantId: string,
    clientUuid: string,
    seq: number,
    quantity = 2,
    observedPrice = 1250,
  ) => {
    const res = await call('post', '/pos/offline/operations', cashierA, {
      sessionId,
      clientUuid,
      seq,
      items: [
        {
          variantId,
          quantity,
          currency: 'USD',
          observedUnitAmountMinor: observedPrice,
        },
      ],
    });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };

  const sync = (operationId: string, credential: string, headers = cashierA) =>
    call('post', `/pos/offline/operations/${operationId}/sync`, {
      ...headers,
      'X-POS-Device-Credential': credential,
    });

  // ------------------------------------------------------------------

  describe('two devices offline simultaneously: full isolation + last-unit race', () => {
    it('each device consumes only its own store pool; the cross-device last-unit race is deterministic', async () => {
      // One shared variant priced once; TWO store pools, TWO devices.
      const variantId = await provisionVariant(`RACE-${run}`, 1000n);
      await seedStorePool(variantId, storeA1Id, 2); // device 1 pool: 2 units
      await seedStorePool(variantId, storeA2Id, 2); // device 2 pool: 2 units

      const dev1 = await registerDevice(storeA1Id, `D1-${run}`);
      const dev2 = await registerDevice(storeA2Id, `D2-${run}`);
      const ses1 = await openSession(dev1.id);
      const ses2 = await openSession(dev2.id);

      // Both devices record intents OFFLINE (server-unreachable sim).
      const op1 = await recordIntent(ses1, variantId, uuid(1), 1, 2, 1000);
      const op2 = await recordIntent(ses2, variantId, uuid(2), 1, 2, 1000);

      // Both sync â€” each within its own scope. Both pools have exactly
      // enough, so both ACCEPT; each pool drains independently to 0.
      const r1 = await sync(op1, dev1.credential);
      const r2 = await sync(op2, dev2.credential);
      expect((r1.body as SyncResultBody).status).toBe('ACCEPTED');
      expect((r2.body as SyncResultBody).status).toBe('ACCEPTED');
      expect((await poolRow(variantId, storeA1Id))?.quantityOnHand).toBe(0);
      expect((await poolRow(variantId, storeA2Id))?.quantityOnHand).toBe(0);

      // Now a THIRD intent from device 1 (pool 1 empty) -> deterministic
      // OUT_OF_STOCK; pool 2 (device 2's) is NOT consulted and NOT touched.
      const op3 = await recordIntent(ses1, variantId, uuid(3), 2, 1, 1000);
      const r3 = await sync(op3, dev1.credential);
      expect((r3.body as SyncResultBody).status).toBe('REJECTED');
      expect((r3.body as SyncResultBody).resultCode).toBe('OUT_OF_STOCK');
      expect((await poolRow(variantId, storeA2Id))?.quantityOnHand).toBe(0);
    });

    it('TRUE cross-device race on the SAME store pool: exactly one wins', async () => {
      const variantId = await provisionVariant(`LAST-${run}`, 500n);
      await seedStorePool(variantId, storeA1Id, 2); // exactly one sale's worth

      const dev1 = await registerDevice(storeA1Id, `L1-${run}`);
      const dev2 = await registerDevice(storeA1Id, `L2-${run}`); // same store
      const ses1 = await openSession(dev1.id);
      const ses2 = await openSession(dev2.id);
      const op1 = await recordIntent(ses1, variantId, uuid(11), 1, 2, 500);
      const op2 = await recordIntent(ses2, variantId, uuid(12), 1, 2, 500);

      // Sync BOTH concurrently: the guarded T1 decrement arbitrates.
      const [a, b] = await Promise.all([
        sync(op1, dev1.credential),
        sync(op2, dev2.credential),
      ]);
      const aBody = a.body as SyncResultBody;
      const bBody = b.body as SyncResultBody;
      const outcomes = [aBody.status, bBody.status].sort();
      expect(outcomes).toEqual(['ACCEPTED', 'REJECTED']);
      const winner = aBody.status === 'ACCEPTED' ? aBody : bBody;
      const loser = aBody.status === 'ACCEPTED' ? bBody : aBody;
      expect(loser.resultCode).toBe('OUT_OF_STOCK');
      expect((await poolRow(variantId, storeA1Id))?.quantityOnHand).toBe(0);

      // Exactly ONE order + ONE payment across the WHOLE tenant.
      const orders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(orders).toHaveLength(1);
      const payments = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(payments).toHaveLength(1);
      expect(winner.orderId).toBe(orders[0].id);

      // Loser retry stays deterministically rejected.
      const loserRetry = await sync(
        loser.operationId,
        aBody.status === 'ACCEPTED' ? dev2.credential : dev1.credential,
      );
      expect((loserRetry.body as SyncResultBody).resultCode).toBe(
        'OUT_OF_STOCK',
      );
    });
  });

  describe('device-credential cross-device integrity', () => {
    it('device A credential CANNOT sync device B operation (401) and vice versa', async () => {
      const variantId = await provisionVariant(`CRED-${run}`, 300n);
      await seedStorePool(variantId, storeA1Id, 5);
      const dev1 = await registerDevice(storeA1Id, `C1-${run}`);
      const dev2 = await registerDevice(storeA2Id, `C2-${run}`);
      const ses1 = await openSession(dev1.id);
      const op1 = await recordIntent(ses1, variantId, uuid(21), 1, 1, 300);

      // dev2's credential on dev1's operation -> credential mismatch 401.
      const wrong = await sync(op1, dev2.credential);
      expect(wrong.status).toBe(401);
      // Nothing executed.
      const orders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(orders).toHaveLength(0);

      // The right credential still succeeds afterwards.
      const ok = await sync(op1, dev1.credential);
      expect((ok.body as SyncResultBody).status).toBe('ACCEPTED');
      expect((await poolRow(variantId, storeA1Id))?.quantityOnHand).toBe(4);
    });

    it('suspended device at sync stays 409 (revocation, cross-device intact)', async () => {
      const variantId = await provisionVariant(`SUS-${run}`, 300n);
      await seedStorePool(variantId, storeA1Id, 5);
      const dev1 = await registerDevice(storeA1Id, `S1-${run}`);
      const ses1 = await openSession(dev1.id);
      const op1 = await recordIntent(ses1, variantId, uuid(22), 1, 1, 300);
      await call('post', `/pos/devices/${dev1.id}/suspend`, managerA);
      const res = await sync(op1, dev1.credential);
      expect(res.status).toBe(409);
    });
  });

  describe('cross-tenant full-surface replay (no existence oracle, zero leakage)', () => {
    it('replaying EVERY tenant-A identifier against tenant B is 404/empty with zero mutation', async () => {
      // Build a complete tenant-A offline world.
      const variantId = await provisionVariant(`XT-${run}`, 400n);
      await seedStorePool(variantId, storeA1Id, 5);
      const dev1 = await registerDevice(storeA1Id, `X1-${run}`);
      const ses1 = await openSession(dev1.id);
      const opAcc = await recordIntent(ses1, variantId, uuid(31), 1, 1, 400);
      const opRej = await recordIntent(ses1, variantId, uuid(32), 2, 99, 400); // OOS
      const acc = await sync(opAcc, dev1.credential);
      expect((acc.body as SyncResultBody).status).toBe('ACCEPTED');
      const rej = await sync(opRej, dev1.credential);
      expect((rej.body as SyncResultBody).resultCode).toBe('OUT_OF_STOCK');
      const accOrderId = (acc.body as SyncResultBody).orderId!;
      const accPaymentId = (acc.body as SyncResultBody).paymentId!;

      // Seed tenant-A feed rows.
      for (const seq of [1, 2]) {
        await tenantContext.run(tenantAId, async () =>
          prisma.posFeedEvent.create({
            data: {
              tenantId: tenantAId,
              feedSeq: seq,
              kind: 'PRODUCT',
              entityId: `a-ent-${seq}`,
            },
          }),
        );
      }
      // Seed one tenant-B feed row (its own watermark space).
      await tenantContext.run(tenantBId, async () =>
        prisma.posFeedEvent.create({
          data: {
            tenantId: tenantBId,
            feedSeq: 1,
            kind: 'PRODUCT',
            entityId: 'b-only',
          },
        }),
      );

      // Replay EVERY identifier as tenant B (adminB has full pos perms).
      const probes: Array<Promise<Res>> = [
        call('get', `/pos/offline/operations/${opAcc}`, adminB),
        call('post', `/pos/offline/operations/${opAcc}/sync`, {
          ...adminB,
          'X-POS-Device-Credential': dev1.credential,
        }),
        call('get', `/pos/offline/devices/${dev1.id}/operations`, adminB),
        call('get', `/pos/offline/devices/${dev1.id}/reconciliation`, adminB),
        call('get', `/pos/offline/sessions/${ses1}/reconciliation`, adminB),
        call('get', `/orders/${accOrderId}`, adminB),
        call('get', `/payments/${accPaymentId}`, adminB),
        call(
          'get',
          `/inventory/stores/${storeA1Id}/variants/${variantId}`,
          adminB,
        ),
        call('get', `/pos/devices/${dev1.id}`, adminB),
        call('get', `/pos/sessions/${ses1}`, adminB),
      ];
      const results = await Promise.all(probes);
      for (const res of results) {
        expect(res.status).toBe(404); // uniform, no existence oracle
      }

      // Replay tenant-A's feed cursor against tenant B: B sees ONLY its
      // own rows (the feed is tenant-scoped, watermark spaces separate).
      const feedB = await call('get', '/pos/feed?since=0', adminB);
      const feedBBody = feedB.body as FeedPageBody;
      expect(feedB.status).toBe(200);
      expect(feedBBody.entries.every((e) => e.entityId === 'b-only')).toBe(
        true,
      );
      expect(
        feedBBody.entries.some((e) => e.entityId.startsWith('a-ent-')),
      ).toBe(false);

      // Tenant A's own feed still has its rows and not B's.
      const feedA = await call('get', '/pos/feed?since=0', cashierA);
      const feedABody = feedA.body as FeedPageBody;
      expect(feedABody.entries.some((e) => e.entityId === 'b-only')).toBe(
        false,
      );

      // ZERO mutation anywhere: tenant A intact, tenant B untouched.
      const ordersA = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(ordersA).toHaveLength(1);
      const ordersB = await tenantContext.run(tenantBId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantBId } }),
      );
      expect(ordersB).toHaveLength(0);
      expect((await poolRow(variantId, storeA1Id))?.quantityOnHand).toBe(4);
      const opAccRow = await tenantContext.run(tenantAId, async () =>
        prisma.posOperation.findUniqueOrThrow({ where: { id: opAcc } }),
      );
      expect(opAccRow.status).toBe('ACCEPTED'); // unchanged by the replay
    });
  });

  describe('cross-session semantics (retain, no rebind, no cross-list)', () => {
    it('an op keeps its original session after close; a NEW session never rebinds it', async () => {
      const variantId = await provisionVariant(`SES-${run}`, 200n);
      await seedStorePool(variantId, storeA1Id, 5);
      const dev1 = await registerDevice(storeA1Id, `SE1-${run}`);
      const ses1 = await openSession(dev1.id);
      const op1 = await recordIntent(ses1, variantId, uuid(41), 1, 1, 200);

      // Close the shift; open a NEW session on the same device.
      await call('post', `/pos/sessions/${ses1}/close`, managerA);
      const ses2 = await openSession(dev1.id);

      // The op still references ses1.
      const opRow = await tenantContext.run(tenantAId, async () =>
        prisma.posOperation.findUniqueOrThrow({ where: { id: op1 } }),
      );
      expect(opRow.sessionId).toBe(ses1); // retained, never rebound

      // Sync works (historical session per D7 revalidation) and the
      // PosSale provenance records the ORIGINAL session.
      const res = await sync(op1, dev1.credential);
      expect((res.body as SyncResultBody).status).toBe('ACCEPTED');
      const saleRow = await tenantContext.run(tenantAId, async () =>
        prisma.posSale.findFirstOrThrow({
          where: { orderId: (res.body as SyncResultBody).orderId! },
        }),
      );
      expect(saleRow.sessionId).toBe(ses1);

      // The new session's reconciliation is empty (no rebind).
      const newReport = await call(
        'get',
        `/pos/offline/sessions/${ses2}/reconciliation`,
        cashierA,
      );
      const newBody = newReport.body as ReportBody;
      expect(newBody.totals).toEqual({ pending: 0, accepted: 0, rejected: 0 });
      // The old session's report holds the op.
      const oldReport = await call(
        'get',
        `/pos/offline/sessions/${ses1}/reconciliation`,
        cashierA,
      );
      expect((oldReport.body as ReportBody).totals.accepted).toBe(1);
    });

    it('a device list never contains another device operations (device isolation)', async () => {
      const variantId = await provisionVariant(`ISO-${run}`, 100n);
      await seedStorePool(variantId, storeA1Id, 5);
      const dev1 = await registerDevice(storeA1Id, `I1-${run}`);
      const dev2 = await registerDevice(storeA2Id, `I2-${run}`);
      const ses1 = await openSession(dev1.id);
      const ses2 = await openSession(dev2.id);
      const op1 = await recordIntent(ses1, variantId, uuid(42), 1, 1, 100);
      const op2 = await recordIntent(ses2, variantId, uuid(43), 1, 1, 100);
      await seedStorePool(variantId, storeA2Id, 5);

      const list1 = await call(
        'get',
        `/pos/offline/devices/${dev1.id}/operations`,
        cashierA,
      );
      const ops1 = (list1.body as unknown as Array<{ id: string }>).map(
        (o) => o.id,
      );
      expect(ops1).toContain(op1);
      expect(ops1).not.toContain(op2);

      const list2 = await call(
        'get',
        `/pos/offline/devices/${dev2.id}/operations`,
        cashierA,
      );
      const ops2 = (list2.body as unknown as Array<{ id: string }>).map(
        (o) => o.id,
      );
      expect(ops2).toContain(op2);
      expect(ops2).not.toContain(op1);
      void op1;
      void op2;
    });
  });

  describe('accepted/rejected operation cross-domain integrity', () => {
    it('accepted op -> Order/Payment correctly scoped; rejected op -> zero cross-domain mutation', async () => {
      const variantId = await provisionVariant(`DOM-${run}`, 600n);
      await seedStorePool(variantId, storeA1Id, 3);
      const dev1 = await registerDevice(storeA1Id, `DM1-${run}`);
      const ses1 = await openSession(dev1.id);
      const opOk = await recordIntent(ses1, variantId, uuid(51), 1, 1, 600);
      const opBad = await recordIntent(ses1, variantId, uuid(52), 2, 9, 600);

      const ok = await sync(opOk, dev1.credential);
      const bad = await sync(opBad, dev1.credential);
      expect((ok.body as SyncResultBody).status).toBe('ACCEPTED');
      expect((bad.body as SyncResultBody).resultCode).toBe('OUT_OF_STOCK');

      // Accepted: exactly one Order (PAID), one Payment (CASH, CAPTURED),
      // one PosSale, one operation->order/payment link, stock 3->2.
      const okBody = ok.body as SyncResultBody;
      const orderRow = await tenantContext.run(tenantAId, async () =>
        prisma.order.findUniqueOrThrow({ where: { id: okBody.orderId! } }),
      );
      expect(orderRow.status).toBe('PAID');
      const paymentRow = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findUniqueOrThrow({ where: { id: okBody.paymentId! } }),
      );
      expect(paymentRow.method).toBe('CASH');
      expect(paymentRow.status).toBe('CAPTURED');
      expect(paymentRow.orderId).toBe(orderRow.id);
      const opRow = await tenantContext.run(tenantAId, async () =>
        prisma.posOperation.findUniqueOrThrow({ where: { id: opOk } }),
      );
      expect(opRow.resultOrderId).toBe(orderRow.id);
      expect(opRow.resultPaymentId).toBe(paymentRow.id);
      expect((await poolRow(variantId, storeA1Id))?.quantityOnHand).toBe(2);

      // Rejected: NO order/payment/sale anywhere for it; stock untouched.
      const allOrders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(allOrders).toHaveLength(1); // only the accepted one
      const badOpRow = await tenantContext.run(tenantAId, async () =>
        prisma.posOperation.findUniqueOrThrow({ where: { id: opBad } }),
      );
      expect(badOpRow.resultOrderId).toBeNull();
      expect(badOpRow.resultPaymentId).toBeNull();
      expect((await poolRow(variantId, storeA1Id))?.quantityOnHand).toBe(2);

      // Tenant B has nothing at all (cross-tenant zero leakage).
      const ordersB = await tenantContext.run(tenantBId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantBId } }),
      );
      expect(ordersB).toHaveLength(0);
    });

    it('duplicate + concurrent sync within the correct scope (regression)', async () => {
      const variantId = await provisionVariant(`IDEM-${run}`, 250n);
      await seedStorePool(variantId, storeA1Id, 10);
      const dev1 = await registerDevice(storeA1Id, `ID1-${run}`);
      const ses1 = await openSession(dev1.id);
      const op1 = await recordIntent(ses1, variantId, uuid(61), 1, 2, 250);

      const first = await sync(op1, dev1.credential);
      const firstBody = first.body as SyncResultBody;
      expect(firstBody.status).toBe('ACCEPTED');

      // Sequential duplicate: same durable result.
      const second = await sync(op1, dev1.credential);
      const secondBody = second.body as SyncResultBody;
      expect(secondBody.orderId).toBe(firstBody.orderId);
      expect(secondBody.paymentId).toBe(firstBody.paymentId);

      // A second op on the same device + a concurrent double-sync of it.
      const op2 = await recordIntent(ses1, variantId, uuid(62), 2, 2, 250);
      const [c1, c2] = await Promise.all([
        sync(op2, dev1.credential),
        sync(op2, dev1.credential),
      ]);
      const c1Body = c1.body as SyncResultBody;
      const c2Body = c2.body as SyncResultBody;
      expect(c1Body.orderId).toBe(c2Body.orderId);
      const orders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(orders).toHaveLength(2);
      expect((await poolRow(variantId, storeA1Id))?.quantityOnHand).toBe(6);
    });
  });
});
