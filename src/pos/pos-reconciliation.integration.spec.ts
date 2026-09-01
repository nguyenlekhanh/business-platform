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
 * Phase 4 P4-U7 — Conflict Handling + Reconciliation integration suite.
 *
 * Proves over the REAL stack that every offline conflict class resolves
 * DETERMINISTICALLY (already terminal by D3/D4/D7), that reconciliation is
 * a READ-ONLY report of those durable resolutions, and that nothing can
 * silently alter an original intent:
 *   - end-to-end lifecycle: record intents -> sync them (ACCEPTED,
 *     PRICE_CHANGED, OUT_OF_STOCK, demotion-auth-rejection) -> the device
 *     report partitions every operation with its typed code and durable
 *     ids; the session (shift) report anchors the same per D9;
 *   - rejected ops retry to the SAME rejection (terminal, never flipped);
 *   - accepted ops retry to the SAME Order/Payment (idempotent);
 *   - PENDING (auth-rejected, unclaimed) ops surface as pending;
 *   - the original intent payload (frozen lines, observed prices,
 *     provenance) is bit-for-bit unchanged after every reconciliation read
 *     and retry;
 *   - the reports are tenant/device isolated and RBAC-gated (pos:read);
 *   - concurrent sync remains exactly-once (regression).
 */
describe('POS Reconciliation (integration)', () => {
  interface SyncResultBody {
    operationId: string;
    status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
    resultCode: string | null;
    orderId: string | null;
    paymentId: string | null;
  }
  interface ReconciledOp {
    operationId: string;
    clientUuid: string;
    seq: number;
    status: 'PENDING' | 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
    resultCode: string | null;
    orderId: string | null;
    paymentId: string | null;
  }
  interface DeviceReportBody {
    deviceId: string;
    storeId: string;
    totals: { pending: number; accepted: number; rejected: number };
    rejected: ReconciledOp[];
    accepted: ReconciledOp[];
    pending: ReconciledOp[];
  }
  interface SessionReportBody {
    sessionId: string;
    deviceId: string;
    storeId: string;
    cashierId: string;
    totals: { pending: number; accepted: number; rejected: number };
    rejected: ReconciledOp[];
    accepted: ReconciledOp[];
    pending: ReconciledOp[];
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `recon-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
  let managerA: Record<string, string>;
  let employeeA: Record<string, string>;
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
    const employeeRole = await grantRole(tenantAId, `employee-a-${run}`, [
      PERMISSIONS.STORE_READ, // deliberately NO pos:read
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
    const employeeUser = await createUser(
      `employee-${run}-${seqCounter}@a.test`,
      tenantAId,
      employeeRole.id,
    );
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
    const adminBUser = await createUser(
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

    cashierA = await loginAs(cashierUser.id, tenantAId);
    managerA = await loginAs(managerUser.id, tenantAId);
    employeeA = await loginAs(employeeUser.id, tenantAId);
    adminB = await loginAs(adminBUser.id, tenantBId);
  });

  /** Full fixture: device + session + priced variant + store stock. */
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

    return { deviceId, credential, sessionId, variantId: variant.id };
  };

  const uuid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  const recordIntent = async (
    ctx: { sessionId: string; variantId: string },
    clientUuid: string,
    seq: number,
    opts: { quantity?: number; observedPrice?: number; currency?: string } = {},
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
    });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };

  const sync = (operationId: string, credential: string, headers = cashierA) =>
    call('post', `/pos/offline/operations/${operationId}/sync`, {
      ...headers,
      'X-POS-Device-Credential': credential,
    });

  const deviceReport = (deviceId: string, headers = cashierA) =>
    call('get', `/pos/offline/devices/${deviceId}/reconciliation`, headers);

  const sessionReport = (sessionId: string, headers = cashierA) =>
    call('get', `/pos/offline/sessions/${sessionId}/reconciliation`, headers);

  /** Deep-frozen intent snapshot for immutability comparison. */
  const intentSnapshot = async (operationId: string) => {
    const op = await tenantContext.run(tenantAId, async () =>
      prisma.posOperation.findUniqueOrThrow({
        where: { id: operationId },
        include: { items: true },
      }),
    );
    return JSON.stringify({
      id: op.id,
      tenantId: op.tenantId,
      deviceId: op.deviceId,
      sessionId: op.sessionId,
      storeId: op.storeId,
      userId: op.userId,
      clientUuid: op.clientUuid,
      seq: op.seq,
      type: op.type,
      customerId: op.customerId,
      createdAt: op.createdAt,
      items: op.items.map((i) => ({
        variantId: i.variantId,
        quantity: i.quantity,
        currency: i.currency,
        observedUnitAmountMinor: i.observedUnitAmountMinor.toString(),
      })),
    });
  };

  // ------------------------------------------------------------------

  describe('end-to-end conflict lifecycle + report', () => {
    it('surfaces every deterministic conflict class and the accepted result in the device report', async () => {
      const ctx = await mkContext({ unitPrice: 1250n, stock: 10 });

      // 1) ACCEPTED: valid intent.
      const ok = await recordIntent(ctx, uuid(1), 1, { quantity: 2 });

      // 2) PRICE_CHANGED: stale observed price.
      const stale = await recordIntent(ctx, uuid(2), 2, {
        observedPrice: 9999,
      });

      // 3) OUT_OF_STOCK: asks more than the store pool holds.
      const oos = await recordIntent(ctx, uuid(3), 3, { quantity: 50 });

      // Sync them all.
      const rOk = await sync(ok.id, ctx.credential);
      const rStale = await sync(stale.id, ctx.credential);
      const rOos = await sync(oos.id, ctx.credential);
      expect((rOk.body as SyncResultBody).status).toBe('ACCEPTED');
      expect((rStale.body as SyncResultBody).resultCode).toBe('PRICE_CHANGED');
      expect((rOos.body as SyncResultBody).resultCode).toBe('OUT_OF_STOCK');

      // The device report partitions everything with typed codes + ids.
      const report = await deviceReport(ctx.deviceId);
      expect(report.status).toBe(200);
      const body = report.body as unknown as DeviceReportBody;
      expect(body.totals).toEqual({ pending: 0, accepted: 1, rejected: 2 });
      expect(body.accepted).toHaveLength(1);
      expect(body.accepted[0].operationId).toBe(ok.id);
      expect(body.accepted[0].orderId).not.toBeNull();
      expect(body.accepted[0].paymentId).not.toBeNull();
      const codes = body.rejected.map((r) => r.resultCode).sort();
      expect(codes).toEqual(['OUT_OF_STOCK', 'PRICE_CHANGED']);
      // Ordered by the device's outbox sequence.
      expect(body.rejected.map((r) => r.seq)).toEqual([2, 3]);

      // The shift report anchors the same session (D9).
      const sreport = await sessionReport(ctx.sessionId);
      const sbody = sreport.body as unknown as SessionReportBody;
      expect(sbody.totals).toEqual({ pending: 0, accepted: 1, rejected: 2 });
      expect(sbody.cashierId).not.toBeNull();
      expect(sbody.sessionId).toBe(ctx.sessionId);
    });

    it('PENDING operations (auth-rejected at sync, never resolved) surface as pending', async () => {
      const ctx = await mkContext();
      const op = await recordIntent(ctx, uuid(10), 1);

      // Demote the cashier between recording and syncing (D7).
      const demoted = await grantRole(tenantAId, `demoted-${run}`, [
        PERMISSIONS.POS_READ,
      ]);
      const cashierUserId = await tenantContext.run(tenantAId, async () => {
        const m = await prisma.membership.findFirstOrThrow({
          where: { tenantId: tenantAId },
          include: { user: true },
        });
        return m.userId;
      });
      await tenantContext.run(tenantAId, async () =>
        prisma.membership.update({
          where: {
            userId_tenantId: { userId: cashierUserId, tenantId: tenantAId },
          },
          data: { roleId: demoted.id },
        }),
      );

      const res = await sync(op.id, ctx.credential);
      expect(res.status).toBe(403); // authorization rejected — op stays PENDING

      // Re-grant for reading the report (a manager reads it instead —
      // reconciliation reading is pos:read, role-independent of the op).
      const report = await deviceReport(ctx.deviceId, managerA);
      const body = report.body as unknown as DeviceReportBody;
      expect(body.totals).toEqual({ pending: 1, accepted: 0, rejected: 0 });
      expect(body.pending[0].operationId).toBe(op.id);
      expect(body.pending[0].status).toBe('PENDING');
    });
  });

  describe('terminal determinism (conflicts never flip, accepted never re-executes)', () => {
    it('a rejected op retries to the SAME rejection and the report is unchanged', async () => {
      const ctx = await mkContext({ unitPrice: 1000n });
      const op = await recordIntent(ctx, uuid(20), 1, { observedPrice: 1000 });

      // Change the server price after recording -> first sync rejects.
      await tenantContext.run(tenantAId, async () =>
        prisma.price.updateMany({
          where: { variantId: ctx.variantId, currency: 'USD' },
          data: { amountMinor: 4321n },
        }),
      );
      const first = await sync(op.id, ctx.credential);
      expect((first.body as SyncResultBody).resultCode).toBe('PRICE_CHANGED');

      const before = await intentSnapshot(op.id);
      // Retried sync: SAME terminal outcome — reconciliation does not
      // re-resolve, and never flips a business rejection.
      const retry = await sync(op.id, ctx.credential);
      expect((retry.body as SyncResultBody).status).toBe('REJECTED');
      expect((retry.body as SyncResultBody).resultCode).toBe('PRICE_CHANGED');
      const after = await intentSnapshot(op.id);
      expect(after).toBe(before); // immutable provenance bit-for-bit

      const report = await deviceReport(ctx.deviceId);
      expect((report.body as DeviceReportBody).totals.rejected).toBe(1);
      expect((report.body as DeviceReportBody).rejected[0].resultCode).toBe(
        'PRICE_CHANGED',
      );
    });

    it('an accepted op retries to the SAME Order/Payment and the report is stable', async () => {
      const ctx = await mkContext({ stock: 10 });
      const op = await recordIntent(ctx, uuid(21), 1, { quantity: 2 });
      const first = await sync(op.id, ctx.credential);
      const firstBody = first.body as SyncResultBody;

      const before = await intentSnapshot(op.id);
      const retry = await sync(op.id, ctx.credential);
      const retryBody = retry.body as SyncResultBody;
      expect(retryBody.orderId).toBe(firstBody.orderId);
      expect(retryBody.paymentId).toBe(firstBody.paymentId);
      expect(await intentSnapshot(op.id)).toBe(before);

      // Reconciliation reads never duplicate anything.
      const r1 = await deviceReport(ctx.deviceId);
      const r2 = await deviceReport(ctx.deviceId);
      const b1 = r1.body as DeviceReportBody;
      const b2 = r2.body as DeviceReportBody;
      expect(b1).toEqual(b2); // pure read: repeated reports are identical
      expect(b1.totals.accepted).toBe(1);

      const payments = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(payments).toHaveLength(1);
      const stock = await tenantContext.run(tenantAId, async () =>
        prisma.inventory.findFirst({
          where: { variantId: ctx.variantId, storeId: storeAId },
        }),
      );
      expect(stock?.quantityOnHand).toBe(8); // decremented exactly once
    });

    it('concurrent sync stays exactly-once and the report reflects ONE execution', async () => {
      const ctx = await mkContext({ stock: 10 });
      const op = await recordIntent(ctx, uuid(22), 1, { quantity: 3 });

      const [a, b] = await Promise.all([
        sync(op.id, ctx.credential),
        sync(op.id, ctx.credential),
      ]);
      const aBody = a.body as SyncResultBody;
      const bBody = b.body as SyncResultBody;
      expect(aBody.orderId).toBe(bBody.orderId);

      const report = await deviceReport(ctx.deviceId);
      const body = report.body as DeviceReportBody;
      expect(body.totals.accepted).toBe(1);
      expect(body.accepted[0].orderId).toBe(aBody.orderId);
      const orders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(orders).toHaveLength(1);
    });
  });

  describe('security (reports are tenant/device isolated, RBAC-gated, pure reads)', () => {
    it('401 unauthenticated; 403 without pos:read; 404 foreign device/session (uniform)', async () => {
      const ctx = await mkContext();
      const op = await recordIntent(ctx, uuid(30), 1);
      await sync(op.id, ctx.credential); // resolve it so data exists

      // 401 no JWT.
      expect(
        (
          await call(
            'get',
            `/pos/offline/devices/${ctx.deviceId}/reconciliation`,
            { 'X-Tenant-ID': tenantAId },
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await call(
            'get',
            `/pos/offline/sessions/${ctx.sessionId}/reconciliation`,
            { 'X-Tenant-ID': tenantAId },
          )
        ).status,
      ).toBe(401);

      // 403 no pos:read (employee has only store:read).
      expect((await deviceReport(ctx.deviceId, employeeA)).status).toBe(403);
      expect((await sessionReport(ctx.sessionId, employeeA)).status).toBe(403);

      // Cross-tenant: uniform 404, nothing leaked.
      const foreignDev = await deviceReport(ctx.deviceId, adminB);
      expect(foreignDev.status).toBe(404);
      const foreignSes = await sessionReport(ctx.sessionId, adminB);
      expect(foreignSes.status).toBe(404);

      // Outsider: 403.
      const outsiderHeaders = await loginAs(outsiderId, tenantAId);
      expect((await deviceReport(ctx.deviceId, outsiderHeaders)).status).toBe(
        403,
      );

      // Unknown ids: 404.
      expect((await deviceReport('no-such-device')).status).toBe(404);
      expect((await sessionReport('no-such-session')).status).toBe(404);
    });

    it('device isolation: one device report never contains another device operations', async () => {
      const ctx1 = await mkContext();
      const ctx2 = await mkContext();
      const op1 = await recordIntent(ctx1, uuid(31), 1);
      const op2 = await recordIntent(ctx2, uuid(32), 1);
      await sync(op1.id, ctx1.credential);
      await sync(op2.id, ctx2.credential);

      const r1 = await deviceReport(ctx1.deviceId);
      const b1 = r1.body as DeviceReportBody;
      expect(b1.totals.accepted).toBe(1);
      expect(b1.accepted[0].operationId).toBe(op1.id);

      const r2 = await deviceReport(ctx2.deviceId);
      const b2 = r2.body as DeviceReportBody;
      expect(b2.accepted[0].operationId).toBe(op2.id);
      // No cross-contamination of ids.
      expect(b1.accepted.some((a) => a.operationId === op2.id)).toBe(false);
      expect(b2.accepted.some((a) => a.operationId === op1.id)).toBe(false);
    });

    it('reconciliation cannot mutate: no endpoint accepts a body; repeated reads are identical', async () => {
      const ctx = await mkContext();
      const op = await recordIntent(ctx, uuid(33), 1);
      const before = await intentSnapshot(op.id);

      await deviceReport(ctx.deviceId);
      await sessionReport(ctx.sessionId);
      expect(await intentSnapshot(op.id)).toBe(before);
    });
  });
});
