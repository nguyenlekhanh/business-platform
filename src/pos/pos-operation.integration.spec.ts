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
 * Phase 4 P4-U4 — Offline Operation Model integration suite.
 *
 * Verifies the durable sync-inbox representation ONLY (no execution — U5):
 * recording derives immutable provenance from the session (tenant from
 * context; device/store/cashier never client-writable), freezes typed
 * intent lines (exact BIGINT observed prices, string in JSON), keeps
 * session identity after close, deduplicates (deviceId, clientUuid)
 * idempotently, arbitrates sequence uniqueness deterministically, isolates
 * tenants/devices, and enforces the full security matrix. Concurrency runs
 * are real parallel HTTP pushes — the database uniques are the sole
 * authority; no sleeps.
 */
describe('POS Offline Operations (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }
  interface OperationBody {
    id: string;
    tenantId: string;
    deviceId: string;
    sessionId: string;
    storeId: string;
    userId: string;
    clientUuid: string;
    seq: number;
    type: string;
    status: string;
    resultCode: string | null;
    customerId: string | null;
    items: Array<{
      id: string;
      variantId: string;
      quantity: number;
      currency: string;
      observedUnitAmountMinor: string;
    }>;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `pso-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
      await prisma.posOperationItem
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.posOperation
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.posSale
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.posSession
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.posDevice
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
  let employeeA: Record<string, string>;
  let ownerA: Record<string, string>;
  let adminB: Record<string, string>;

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
      PERMISSIONS.POS_READ,
    ]);
    const ownerRole = await grantRole(tenantAId, SYSTEM_ROLE_KEYS.OWNER, []);

    const cashierUser = await createUser(
      `cashier-${run}-${seqCounter}@a.test`,
      tenantAId,
      cashierRole.id,
    );
    cashierAId = cashierUser.id;
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
    const ownerUser = await createUser(
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

    cashierA = await loginAs(cashierUser.id, tenantAId);
    managerA = await loginAs(managerUser.id, tenantAId);
    employeeA = await loginAs(employeeUser.id, tenantAId);
    ownerA = await loginAs(ownerUser.id, tenantAId);
    adminB = await loginAs(adminBUser.id, tenantBId);
  });

  // A registered device + open session owned by the cashier.
  const mkSession = async () => {
    const dev = await call('post', '/pos/devices', managerA, {
      storeId: storeAId,
      name: `DEV-${run}-${seqCounter}-${Math.floor(Math.random() * 1e6)}`,
    });
    expect(dev.status).toBe(201);
    const ses = await call('post', '/pos/sessions', cashierA, {
      deviceId: (dev.body as { id: string }).id,
    });
    expect(ses.status).toBe(201);
    return ses.body as { id: string; deviceId: string };
  };

  const uuid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  const intentPayload = (
    sessionId: string,
    clientUuid: string,
    seq: number,
    overrides: Record<string, unknown> = {},
  ) => ({
    sessionId,
    clientUuid,
    seq,
    items: [
      {
        variantId: 'variant-xyz',
        quantity: 2,
        currency: 'USD',
        observedUnitAmountMinor: 1250,
      },
    ],
    ...overrides,
  });

  const recordIntent = async (
    headers: Record<string, string>,
    sessionId: string,
    clientUuid: string,
    seq: number,
    overrides: Record<string, unknown> = {},
  ) =>
    call('post', '/pos/offline/operations', headers, {
      ...intentPayload(sessionId, clientUuid, seq, overrides),
      ...(overrides.items ? { items: overrides.items } : {}),
    });

  describe('recording — immutable, server-derived provenance', () => {
    it('records a PENDING intent with session-derived context and frozen typed lines', async () => {
      const ses = await mkSession();
      const res = await recordIntent(cashierA, ses.id, uuid(1), 1);
      expect(res.status).toBe(201);
      const body = res.body as unknown as OperationBody;

      // Provenance derived from the SESSION, never the client payload.
      expect(body.tenantId).toBe(tenantAId);
      expect(body.sessionId).toBe(ses.id);
      expect(body.deviceId).toBe(ses.deviceId);
      expect(body.storeId).toBe(storeAId);
      expect(body.userId).toBe(cashierAId);
      // Outbox identity exactly as pushed.
      expect(body.clientUuid).toBe(uuid(1));
      expect(body.seq).toBe(1);
      // Sync-inbox state only.
      expect(body.type).toBe('SALE_INTENT');
      expect(body.status).toBe('PENDING');
      expect(body.resultCode).toBeNull();
      // Frozen lines: exact money as JSON strings.
      expect(body.items).toHaveLength(1);
      expect(body.items[0].observedUnitAmountMinor).toBe('1250');
      expect(typeof body.items[0].observedUnitAmountMinor).toBe('string');

      // DB rows: parent + typed BIGINT line (not a JSON blob).
      const row = await tenantContext.run(tenantAId, async () =>
        prisma.posOperation.findUniqueOrThrow({
          where: { id: body.id },
          include: { items: true },
        }),
      );
      expect(row.status).toBe('PENDING');
      expect(row.items[0].observedUnitAmountMinor).toBe(1250n);
      expect(row.items[0].quantity).toBe(2);

      // NOTHING was executed: no Order/Payment/Inventory mutation.
      const orders = await tenantContext.run(tenantAId, async () =>
        prisma.order.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(orders).toHaveLength(0);
      const payments = await tenantContext.run(tenantAId, async () =>
        prisma.payment.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(payments).toHaveLength(0);
    });

    it('retains the session identity after the session is CLOSED', async () => {
      const ses = await mkSession();
      await call('post', `/pos/sessions/${ses.id}/close`, managerA);
      const res = await recordIntent(cashierA, ses.id, uuid(2), 1);
      expect(res.status).toBe(201);
      const body = res.body as unknown as OperationBody;
      expect(body.sessionId).toBe(ses.id); // retained, never rebound
      expect(body.status).toBe('PENDING');
    });

    it('optional customerId is persisted; walk-in default is null', async () => {
      const ses = await mkSession();
      const withCustomer = await recordIntent(cashierA, ses.id, uuid(3), 1, {
        customerId: 'cust-1',
      });
      expect(withCustomer.status).toBe(201);
      expect((withCustomer.body as OperationBody).customerId).toBe('cust-1');

      const ses2 = await mkSession();
      const walkIn = await recordIntent(cashierA, ses2.id, uuid(4), 1);
      expect((walkIn.body as OperationBody).customerId).toBeNull();
    });
  });

  describe('idempotency (deviceId, clientUuid) — DB authority', () => {
    it('two concurrent duplicate pushes -> exactly one durable row, same id', async () => {
      const ses = await mkSession();
      const [a, b] = await Promise.all([
        recordIntent(cashierA, ses.id, uuid(5), 1),
        recordIntent(cashierA, ses.id, uuid(5), 1),
      ]);

      // Exactly one created; the duplicate resolves to the SAME row.
      const ids = new Set([a, b].map((r) => (r.body as OperationBody).id));
      expect(ids.size).toBe(1);
      for (const r of [a, b]) {
        expect([200, 201]).toContain(r.status);
      }

      const rows = await tenantContext.run(tenantAId, async () =>
        prisma.posOperation.findMany({
          where: { deviceId: ses.deviceId, clientUuid: uuid(5) },
          include: { items: true },
        }),
      );
      expect(rows).toHaveLength(1); // never a duplicate row
      expect(rows[0].items).toHaveLength(1); // lines never duplicated
    });

    it('sequential re-push returns the original row idempotently', async () => {
      const ses = await mkSession();
      const first = await recordIntent(cashierA, ses.id, uuid(6), 1);
      expect(first.status).toBe(201);
      const second = await recordIntent(cashierA, ses.id, uuid(6), 1);
      expect([200, 201]).toContain(second.status);
      expect((second.body as OperationBody).id).toBe(
        (first.body as OperationBody).id,
      );
      const count = await tenantContext.run(tenantAId, async () =>
        prisma.posOperation.count({
          where: { deviceId: ses.deviceId, clientUuid: uuid(6) },
        }),
      );
      expect(count).toBe(1);
    });
  });

  describe('sequence uniqueness (deviceId, seq) — DB authority', () => {
    it('two concurrent creations with DIFFERENT clientUuids but the SAME seq -> one 201 + one 409', async () => {
      const ses = await mkSession();
      const [a, b] = await Promise.all([
        recordIntent(cashierA, ses.id, uuid(7), 101),
        recordIntent(cashierA, ses.id, uuid(8), 101),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      if (a.status === 409) {
        expect((a.body as ErrorBody).message).toBe(
          'Device sequence number already used by another operation',
        );
      } else {
        expect((b.body as ErrorBody).message).toBe(
          'Device sequence number already used by another operation',
        );
      }

      // Exactly one durable row for seq 101.
      const rows = await tenantContext.run(tenantAId, async () =>
        prisma.posOperation.findMany({
          where: { deviceId: ses.deviceId, seq: 101 },
        }),
      );
      expect(rows).toHaveLength(1);
    });

    it('concurrent creations with increasing seqs all succeed (unique allocation)', async () => {
      const ses = await mkSession();
      const results = await Promise.all([
        recordIntent(cashierA, ses.id, uuid(20), 101),
        recordIntent(cashierA, ses.id, uuid(21), 102),
        recordIntent(cashierA, ses.id, uuid(22), 103),
      ]);
      for (const r of results) {
        expect(r.status).toBe(201);
      }
      const seqs = results
        .map((r) => (r.body as OperationBody).seq)
        .sort((x, y) => x - y);
      expect(seqs).toEqual([101, 102, 103]);
    });

    it('two DIFFERENT devices may use the same seq independently', async () => {
      const ses1 = await mkSession();
      const ses2 = await mkSession();
      // Both sessions' devices belong to the same cashier via their own
      // open sessions.
      const a = await recordIntent(cashierA, ses1.id, uuid(30), 42);
      const b = await recordIntent(cashierA, ses2.id, uuid(31), 42);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201); // same NUMBER, different device scope
    });
  });

  describe('security matrix', () => {
    it('401 unauthenticated / 403 outsider / 403 employee (read-only)', async () => {
      const ses = await mkSession();
      expect(
        (
          await call(
            'post',
            '/pos/offline/operations',
            {},
            {
              ...intentPayload(ses.id, uuid(40), 1),
            },
          )
        ).status,
      ).toBe(401);
      expect((await call('get', '/pos/offline/operations/x', {})).status).toBe(
        401,
      );

      const outsiderUser = await prisma.user.findUniqueOrThrow({
        where: { email: `outsider-${run}-${seqCounter}@x.test` },
      });
      const outsiderHeaders = await loginAs(outsiderUser.id, tenantAId);
      expect(
        (
          await call('post', '/pos/offline/operations', outsiderHeaders, {
            ...intentPayload(ses.id, uuid(41), 1),
          })
        ).status,
      ).toBe(403);

      // Employee has pos:read but NOT pos:create.
      expect(
        (
          await call('post', '/pos/offline/operations', employeeA, {
            ...intentPayload(ses.id, uuid(42), 1),
          })
        ).status,
      ).toBe(403);
      expect(
        (await call('get', `/pos/offline/devices/x/operations`, employeeA))
          .status,
      ).toBe(404); // read allowed, unknown device -> uniform 404
    });

    it('cross-tenant session/operation/device-list access is uniformly 404 and mutates nothing', async () => {
      const ses = await mkSession();
      const recorded = await recordIntent(cashierA, ses.id, uuid(50), 1);
      expect(recorded.status).toBe(201);
      const op = recorded.body as OperationBody;

      // Tenant B cannot record on A's session, read A's operation, or list
      // A's device outbox.
      expect(
        (
          await call('post', '/pos/offline/operations', adminB, {
            ...intentPayload(ses.id, uuid(51), 1),
          })
        ).status,
      ).toBe(404);
      expect(
        (await call('get', `/pos/offline/operations/${op.id}`, adminB)).status,
      ).toBe(404);
      expect(
        (
          await call(
            'get',
            `/pos/offline/devices/${ses.deviceId}/operations`,
            adminB,
          )
        ).status,
      ).toBe(404);

      // Tenant A's rows intact; nothing in tenant B.
      const rowsA = await tenantContext.run(tenantAId, async () =>
        prisma.posOperation.findMany({ where: { tenantId: tenantAId } }),
      );
      expect(rowsA).toHaveLength(1);
      const rowsB = await tenantContext.run(tenantBId, async () =>
        prisma.posOperation.findMany({ where: { tenantId: tenantBId } }),
      );
      expect(rowsB).toHaveLength(0);
    });

    it('cross-DEVICE operation access within the tenant is not exposed via list scoping', async () => {
      // Device 1's operations are listed ONLY through device 1's list.
      const ses1 = await mkSession();
      const ses2 = await mkSession();
      await recordIntent(cashierA, ses1.id, uuid(60), 1);
      await recordIntent(cashierA, ses2.id, uuid(61), 1);

      const list1 = await call(
        'get',
        `/pos/offline/devices/${ses1.deviceId}/operations`,
        cashierA,
      );
      const ops1 = list1.body as unknown as OperationBody[];
      expect(ops1).toHaveLength(1);
      expect(ops1[0].deviceId).toBe(ses1.deviceId);
      const list2 = await call(
        'get',
        `/pos/offline/devices/${ses2.deviceId}/operations`,
        cashierA,
      );
      expect(list2.body as unknown as OperationBody[]).toHaveLength(1);
    });

    it('rejects authority-field injections with 400', async () => {
      const ses = await mkSession();
      const base = intentPayload(ses.id, uuid(70), 1);
      const injections = [
        { ...base, tenantId: tenantBId },
        { ...base, deviceId: 'other-device' },
        { ...base, storeId: 'other-store' },
        { ...base, sessionId: ses.id, cashierId: 'someone' },
        { ...base, userId: 'someone' },
        { ...base, status: 'ACCEPTED' },
        { ...base, resultCode: 'PRICE_CHANGED' },
        { ...base, resultOrderId: 'o' },
        { ...base, resultPaymentId: 'p' },
        { ...base, id: 'op-x' },
        { ...base, bogus: true },
      ];
      for (const payload of injections) {
        expect(
          (await call('post', '/pos/offline/operations', cashierA, payload))
            .status,
        ).toBe(400);
      }
      const noRows = await tenantContext.run(tenantAId, async () =>
        prisma.posOperation.count({ where: { tenantId: tenantAId } }),
      );
      expect(noRows).toBe(0);
    });

    it('a non-opener member cannot record on someone else’s session (uniform 404)', async () => {
      const ses = await mkSession(); // opened by cashierA
      const res = await recordIntent(managerA, ses.id, uuid(80), 1);
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('POS session not found');
    });

    it('owner semantic-all records and reads without grants', async () => {
      // Owner opens their own session (semantic-all) and records.
      const dev = await call('post', '/pos/devices', ownerA, {
        storeId: storeAId,
        name: `ODEV-${run}-${seqCounter}`,
      });
      const ses = await call('post', '/pos/sessions', ownerA, {
        deviceId: (dev.body as { id: string }).id,
      });
      const res = await recordIntent(
        ownerA,
        (ses.body as { id: string }).id,
        uuid(81),
        1,
      );
      expect(res.status).toBe(201);
      const got = await call(
        'get',
        `/pos/offline/operations/${(res.body as OperationBody).id}`,
        ownerA,
      );
      expect(got.status).toBe(200);
    });

    it('variants/prices/stock are NOT validated at record time (U5 concern)', async () => {
      // The intent references a variant that does not exist; recording
      // still succeeds — validation happens AT SYNC (D3/D4 at U5).
      const ses = await mkSession();
      const res = await recordIntent(cashierA, ses.id, uuid(82), 1);
      expect(res.status).toBe(201);
      expect((res.body as OperationBody).status).toBe('PENDING');
    });
  });
});
