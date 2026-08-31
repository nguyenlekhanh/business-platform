import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  PERMISSION_DEFINITIONS,
  PERMISSIONS,
  SYSTEM_ROLE_KEYS,
} from '../rbac/permission-catalog';
import { AppModule } from '../app.module';

/**
 * Phase 4 P4-U1 — POS Foundation integration suite.
 *
 * Covers: registration (one-time credential security), device lifecycle
 * (A6 state machine incl. RETIRED terminal + rotation guard), sessions
 * (D9: store derived from device; one-open-per-device; guarded close),
 * RBAC matrix (A1: pos:read/create/manage; admin full, employee
 * read-only, owner semantic-all), tenant isolation/IDOR (uniform 404),
 * DTO validation (whitelist + tenantId/status/storeId injection), and
 * deterministic concurrency (dual session open; dual status transition).
 */
describe('POS Foundation (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }
  interface DeviceBody {
    id: string;
    tenantId: string;
    storeId: string;
    name: string;
    status: string;
    lastSeenAt: string | null;
    credential?: string;
    credentialHash?: string;
  }
  interface SessionBody {
    id: string;
    tenantId: string;
    deviceId: string;
    storeId: string;
    userId: string;
    status: string;
    openedAt: string;
    closedAt: string | null;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `pos-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const userIdsToDelete: string[] = [];
  const roleIdsToDelete: string[] = [];
  const membershipIdsToDelete: string[] = [];
  const tenantIdsToDelete: string[] = [];
  // (Stores are cascade-deleted with their tenant; no separate list needed.)

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

  const createStore = async (tenantId: string, code: string) =>
    tenantContext.run(tenantId, async () =>
      prisma.store.create({
        data: { tenantId, name: code, code, type: 'POS', status: 'ACTIVE' },
      }),
    );

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
      // Sessions/devices first (FK chains), then the rest of the
      // established teardown order.
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
  let storeBId: string;
  let adminA: Record<string, string>;
  let employeeA: Record<string, string>;
  let ownerA: Record<string, string>;
  let adminB: Record<string, string>;

  let seq = 0;

  beforeEach(async () => {
    seq += 1;
    const tenantA = await createTenant('a');
    tenantAId = tenantA.id;
    const storeA = await createStore(tenantAId, `SA-${run}-${seq}`);
    storeAId = storeA.id;

    const adminRole = await grantRole(tenantAId, `admin-a-${run}`, [
      PERMISSIONS.POS_READ,
      PERMISSIONS.POS_CREATE,
      PERMISSIONS.POS_MANAGE,
      PERMISSIONS.STORE_READ,
    ]);
    const employeeRole = await grantRole(tenantAId, `employee-a-${run}`, [
      PERMISSIONS.POS_READ, // A1: employees/cashiers are read-only
    ]);
    const ownerRole = await grantRole(tenantAId, SYSTEM_ROLE_KEYS.OWNER, []);

    const admin = await createUser(
      `admin-${run}-${seq}@a.test`,
      tenantAId,
      adminRole.id,
    );
    const employee = await createUser(
      `employee-${run}-${seq}@a.test`,
      tenantAId,
      employeeRole.id,
    );
    const owner = await createUser(
      `owner-${run}-${seq}@a.test`,
      tenantAId,
      ownerRole.id,
    );

    const tenantB = await createTenant('b');
    tenantBId = tenantB.id;
    const storeB = await createStore(tenantBId, `SB-${run}-${seq}`);
    storeBId = storeB.id;
    const adminRoleB = await grantRole(tenantBId, `admin-b-${run}`, [
      PERMISSIONS.POS_READ,
      PERMISSIONS.POS_CREATE,
      PERMISSIONS.POS_MANAGE,
      PERMISSIONS.STORE_READ,
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

    adminA = await loginAs(admin.id, tenantAId);
    employeeA = await loginAs(employee.id, tenantAId);
    ownerA = await loginAs(owner.id, tenantAId);
    adminB = await loginAs(adminBUser.id, tenantBId);
  });

  const registerDeviceViaApi = async (
    headers: Record<string, string>,
    name: string,
    storeId?: string,
  ): Promise<DeviceBody> => {
    const res = await call('post', '/pos/devices', headers, {
      storeId: storeId ?? storeAId,
      name,
    });
    expect(res.status).toBe(201);
    return res.body as unknown as DeviceBody;
  };

  describe('authentication and authorization gates', () => {
    it('rejects unauthenticated with 401 on every route', async () => {
      expect((await call('get', '/pos/devices', {})).status).toBe(401);
      expect(
        (await call('post', '/pos/devices', {}, { storeId: 'x', name: 'x' }))
          .status,
      ).toBe(401);
      expect((await call('get', '/pos/devices/x', {})).status).toBe(401);
      expect((await call('post', '/pos/devices/x/retire', {})).status).toBe(
        401,
      );
      expect((await call('get', '/pos/sessions/x', {})).status).toBe(401);
      expect(
        (await call('post', '/pos/sessions', {}, { deviceId: 'x' })).status,
      ).toBe(401);
      expect((await call('post', '/pos/sessions/x/close', {})).status).toBe(
        401,
      );
    });

    it('rejects outsider without membership with 403', async () => {
      const outsiderUser = await prisma.user.findUniqueOrThrow({
        where: { email: `outsider-${run}-${seq}@x.test` },
      });
      const headers = await loginAs(outsiderUser.id, tenantAId);
      expect((await call('get', '/pos/devices', headers)).status).toBe(403);
      expect(
        (
          await call('post', '/pos/devices', headers, {
            storeId: storeAId,
            name: 'X',
          })
        ).status,
      ).toBe(403);
    });

    it('employee (pos:read only) can read but not register, manage, or open sessions (A1)', async () => {
      expect((await call('get', '/pos/devices', employeeA)).status).toBe(200);

      expect(
        (
          await call('post', '/pos/devices', employeeA, {
            storeId: storeAId,
            name: `EMP-${run}`,
          })
        ).status,
      ).toBe(403);

      const device = await registerDeviceViaApi(adminA, `EMPD-${run}-${seq}`);
      expect(
        (await call('post', `/pos/devices/${device.id}/retire`, employeeA))
          .status,
      ).toBe(403);
      expect(
        (
          await call('post', '/pos/sessions', employeeA, {
            deviceId: device.id,
          })
        ).status,
      ).toBe(403);
      const session = await call('post', '/pos/sessions', adminA, {
        deviceId: device.id,
      });
      expect(
        (
          await call(
            'post',
            `/pos/sessions/${(session.body as SessionBody).id}/close`,
            employeeA,
          )
        ).status,
      ).toBe(403);
    });

    it('pos:create-only member can register and open sessions but not manage', async () => {
      const role = await grantRole(tenantAId, `createonly-${run}`, [
        PERMISSIONS.POS_CREATE,
      ]);
      const user = await createUser(
        `createonly-${run}-${seq}@a.test`,
        tenantAId,
        role.id,
      );
      const headers = await loginAs(user.id, tenantAId);

      const device = await registerDeviceViaApi(headers, `CO-${run}-${seq}`);
      const session = await call('post', '/pos/sessions', headers, {
        deviceId: device.id,
      });
      expect(session.status).toBe(201);
      expect((await call('get', '/pos/devices', headers)).status).toBe(403); // no pos:read
      expect(
        (await call('post', `/pos/devices/${device.id}/suspend`, headers))
          .status,
      ).toBe(403); // no pos:manage
      expect(
        (
          await call(
            'post',
            `/pos/sessions/${(session.body as SessionBody).id}/close`,
            headers,
          )
        ).status,
      ).toBe(403);
    });

    it('owner semantic-all walks the full lifecycle without grants', async () => {
      const device = await registerDeviceViaApi(ownerA, `OWN-${run}-${seq}`);
      const session = await call('post', '/pos/sessions', ownerA, {
        deviceId: device.id,
      });
      expect(session.status).toBe(201);
      const closed = await call(
        'post',
        `/pos/sessions/${(session.body as SessionBody).id}/close`,
        ownerA,
      );
      expect(closed.status).toBe(200);
      const suspended = await call(
        'post',
        `/pos/devices/${device.id}/suspend`,
        ownerA,
      );
      expect(suspended.status).toBe(200);
      const resumed = await call(
        'post',
        `/pos/devices/${device.id}/resume`,
        ownerA,
      );
      expect(resumed.status).toBe(200);
    });
  });

  describe('device registration and credential security (A2/D6)', () => {
    it('registers an ACTIVE device; credential appears exactly once and is never persisted raw', async () => {
      const device = await registerDeviceViaApi(adminA, `REG-${run}-${seq}`);

      expect(device.status).toBe('ACTIVE');
      expect(device.storeId).toBe(storeAId);
      expect(device.tenantId).toBe(tenantAId);
      expect(device.credential).toBeDefined();
      expect(typeof device.credential).toBe('string');

      // The stored row holds ONLY the sha256 hash of the secret.
      const row = await tenantContext.run(tenantAId, async () =>
        prisma.posDevice.findUnique({ where: { id: device.id } }),
      );
      expect(row?.credentialHash).toBe(
        createHash('sha256').update(device.credential!, 'utf8').digest('hex'),
      );
      expect(row?.credentialHash).not.toBe(device.credential);

      // NO read endpoint ever exposes the credential or its hash.
      const fetched = await call('get', `/pos/devices/${device.id}`, adminA);
      expect(fetched.body['credential']).toBeUndefined();
      expect(fetched.body['credentialHash']).toBeUndefined();

      const list = await call('get', '/pos/devices', adminA);
      const rows = (list.body as { data: unknown[] }).data;
      for (const r of rows) {
        const rec = r as Record<string, unknown>;
        expect(rec['credential']).toBeUndefined();
        expect(rec['credentialHash']).toBeUndefined();
      }
    });

    it('rejects unknown/foreign store with 404 (Asset.storeId precedent)', async () => {
      const res = await call('post', '/pos/devices', adminA, {
        storeId: 'no-such-store',
        name: `X-${run}`,
      });
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Store not found');

      // Foreign store (tenant B) is indistinguishable from unknown.
      const foreign = await call('post', '/pos/devices', adminA, {
        storeId: storeBId,
        name: `Y-${run}`,
      });
      expect(foreign.status).toBe(404);
    });

    it('rejects duplicate device name within tenant with 409', async () => {
      const name = `DUP-${run}-${seq}`;
      await registerDeviceViaApi(adminA, name);
      const dup = await call('post', '/pos/devices', adminA, {
        storeId: storeAId,
        name,
      });
      expect(dup.status).toBe(409);
      expect((dup.body as ErrorBody).message).toBe(
        'A POS device with this name already exists in the tenant',
      );
    });

    it('rejects tenantId/status/credential/id/timestamps/unknown injections with 400', async () => {
      const injections = [
        { storeId: storeAId, name: 'x', tenantId: tenantBId },
        { storeId: storeAId, name: 'x', status: 'RETIRED' },
        { storeId: storeAId, name: 'x', credentialHash: 'h' },
        { storeId: storeAId, name: 'x', credential: 'c' },
        { storeId: storeAId, name: 'x', id: 'd' },
        { storeId: storeAId, name: 'x', createdAt: new Date().toISOString() },
        { storeId: storeAId, name: 'x', bogus: true },
      ];
      for (const payload of injections) {
        expect(
          (await call('post', '/pos/devices', adminA, payload)).status,
        ).toBe(400);
      }
    });
  });

  describe('device lifecycle (A6)', () => {
    it('full matrix: suspend -> resume -> retire terminal; invalid edges -> 409', async () => {
      const device = await registerDeviceViaApi(adminA, `LC-${run}-${seq}`);

      // suspend: ACTIVE -> SUSPENDED
      const suspend = await call(
        'post',
        `/pos/devices/${device.id}/suspend`,
        adminA,
      );
      expect(suspend.status).toBe(200);
      expect((suspend.body as DeviceBody).status).toBe('SUSPENDED');

      // suspend again -> 409 (must be ACTIVE)
      const suspend2 = await call(
        'post',
        `/pos/devices/${device.id}/suspend`,
        adminA,
      );
      expect(suspend2.status).toBe(409);
      expect((suspend2.body as ErrorBody).message).toBe('Device is not active');

      // resume: SUSPENDED -> ACTIVE
      const resume = await call(
        'post',
        `/pos/devices/${device.id}/resume`,
        adminA,
      );
      expect(resume.status).toBe(200);
      expect((resume.body as DeviceBody).status).toBe('ACTIVE');

      // resume again -> 409 (must be SUSPENDED)
      const resume2 = await call(
        'post',
        `/pos/devices/${device.id}/resume`,
        adminA,
      );
      expect(resume2.status).toBe(409);
      expect((resume2.body as ErrorBody).message).toBe(
        'Device is not suspended',
      );

      // retire: ACTIVE -> RETIRED (terminal)
      const retire = await call(
        'post',
        `/pos/devices/${device.id}/retire`,
        adminA,
      );
      expect(retire.status).toBe(200);
      expect((retire.body as DeviceBody).status).toBe('RETIRED');

      // Every transition out of RETIRED -> 409.
      for (const action of ['suspend', 'resume', 'retire']) {
        const again = await call(
          'post',
          `/pos/devices/${device.id}/${action}`,
          adminA,
        );
        expect(again.status).toBe(409);
        expect((again.body as ErrorBody).message).toBe(
          'Device is already retired',
        );
      }

      // Credential rotation forbidden for retired devices.
      const rotate = await call(
        'post',
        `/pos/devices/${device.id}/rotate-credential`,
        adminA,
      );
      expect(rotate.status).toBe(409);
      expect((rotate.body as ErrorBody).message).toBe(
        'Device is already retired',
      );

      // Retired devices cannot open sessions.
      const session = await call('post', '/pos/sessions', adminA, {
        deviceId: device.id,
      });
      expect(session.status).toBe(409);
      expect((session.body as ErrorBody).message).toBe('Device is not active');
    });

    it('rename via PATCH works; storeId and status are not patchable (A5)', async () => {
      const device = await registerDeviceViaApi(adminA, `RN-${run}-${seq}`);

      const renamed = await call('patch', `/pos/devices/${device.id}`, adminA, {
        name: `RENAMED-${run}-${seq}`,
      });
      expect(renamed.status).toBe(200);
      expect((renamed.body as DeviceBody).name).toBe(`RENAMED-${run}-${seq}`);

      // A5: store binding permanent — storeId is rejected by the whitelist.
      const move = await call('patch', `/pos/devices/${device.id}`, adminA, {
        storeId: storeBId,
      });
      expect(move.status).toBe(400);

      // Status is server-controlled — rejected by the whitelist.
      const statusPatch = await call(
        'patch',
        `/pos/devices/${device.id}`,
        adminA,
        { status: 'RETIRED' },
      );
      expect(statusPatch.status).toBe(400);

      // The row is unchanged by the rejected patches.
      const row = await tenantContext.run(tenantAId, async () =>
        prisma.posDevice.findUnique({ where: { id: device.id } }),
      );
      expect(row?.storeId).toBe(storeAId);
      expect(row?.status).toBe('ACTIVE');
    });

    it('credential rotation replaces the hash and returns a new one-time secret', async () => {
      const device = await registerDeviceViaApi(adminA, `ROT-${run}-${seq}`);
      const rowBefore = await tenantContext.run(tenantAId, async () =>
        prisma.posDevice.findUnique({ where: { id: device.id } }),
      );
      const oldHash = rowBefore?.credentialHash;

      const rotated = await call(
        'post',
        `/pos/devices/${device.id}/rotate-credential`,
        adminA,
      );
      expect(rotated.status).toBe(200);
      const body = rotated.body as unknown as DeviceBody;
      expect(body.credential).toBeDefined();
      expect(body.credential).not.toBe(device.credential);

      const rowAfter = await tenantContext.run(tenantAId, async () =>
        prisma.posDevice.findUnique({ where: { id: device.id } }),
      );
      expect(rowAfter?.credentialHash).not.toBe(oldHash);
      expect(rowAfter?.credentialHash).toBe(
        createHash('sha256').update(body.credential!, 'utf8').digest('hex'),
      );
    });

    it('store delete is blocked while devices reference it (RESTRICT -> 409)', async () => {
      const device = await registerDeviceViaApi(adminA, `SD-${run}-${seq}`);
      expect(device.storeId).toBe(storeAId);

      // Store.deleteMany would violate RESTRICT at DB level; assert the
      // FK behavior directly: deleting the store row fails.
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

  describe('sessions (D9/A3)', () => {
    it('open derives store+cashier server-side; close is guarded', async () => {
      const device = await registerDeviceViaApi(adminA, `SE-${run}-${seq}`);

      const open = await call('post', '/pos/sessions', adminA, {
        deviceId: device.id,
      });
      expect(open.status).toBe(201);
      const session = open.body as unknown as SessionBody;
      expect(session.status).toBe('OPEN');
      expect(session.storeId).toBe(storeAId); // from the DEVICE
      expect(session.deviceId).toBe(device.id);
      expect(session.closedAt).toBeNull();

      const close = await call(
        'post',
        `/pos/sessions/${session.id}/close`,
        adminA,
      );
      expect(close.status).toBe(200);
      const closed = close.body as unknown as SessionBody;
      expect(closed.status).toBe('CLOSED');
      expect(closed.closedAt).not.toBeNull();

      // Closing again -> 409 (never idempotent-close).
      const close2 = await call(
        'post',
        `/pos/sessions/${session.id}/close`,
        adminA,
      );
      expect(close2.status).toBe(409);
      expect((close2.body as ErrorBody).message).toBe(
        'Only open sessions can be closed',
      );
    });

    it('suspended device cannot open a session; resume restores', async () => {
      const device = await registerDeviceViaApi(adminA, `SD2-${run}-${seq}`);
      await call('post', `/pos/devices/${device.id}/suspend`, adminA);

      const open = await call('post', '/pos/sessions', adminA, {
        deviceId: device.id,
      });
      expect(open.status).toBe(409);
      expect((open.body as ErrorBody).message).toBe('Device is not active');

      await call('post', `/pos/devices/${device.id}/resume`, adminA);
      const open2 = await call('post', '/pos/sessions', adminA, {
        deviceId: device.id,
      });
      expect(open2.status).toBe(201);
    });

    it('rejects storeId/tenantId/userId/status injections on session open with 400', async () => {
      const device = await registerDeviceViaApi(adminA, `SI-${run}-${seq}`);
      const injections = [
        { deviceId: device.id, storeId: storeBId },
        { deviceId: device.id, tenantId: tenantBId },
        { deviceId: device.id, userId: 'someone-else' },
        { deviceId: device.id, status: 'CLOSED' },
        { deviceId: device.id, openedAt: new Date().toISOString() },
        { deviceId: device.id, bogus: 1 },
      ];
      for (const payload of injections) {
        expect(
          (await call('post', '/pos/sessions', adminA, payload)).status,
        ).toBe(400);
      }
    });

    it('two concurrent opens on one device: exactly one 201 + one 409 (DB partial unique index)', async () => {
      const device = await registerDeviceViaApi(adminA, `RACE-${run}-${seq}`);

      const [a, b] = await Promise.all([
        call('post', '/pos/sessions', adminA, { deviceId: device.id }),
        call('post', '/pos/sessions', adminA, { deviceId: device.id }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      if (a.status === 409) {
        expect((a.body as ErrorBody).message).toBe(
          'Device already has an open session',
        );
      } else {
        expect((b.body as ErrorBody).message).toBe(
          'Device already has an open session',
        );
      }

      // Exactly one OPEN row exists.
      const rows = await tenantContext.run(tenantAId, async () =>
        prisma.posSession.findMany({
          where: { deviceId: device.id, status: 'OPEN' },
        }),
      );
      expect(rows).toHaveLength(1);
    });

    it('two concurrent retires on one device: exactly one 200 + one 409', async () => {
      const device = await registerDeviceViaApi(adminA, `RRACE-${run}-${seq}`);

      const [a, b] = await Promise.all([
        call('post', `/pos/devices/${device.id}/retire`, adminA),
        call('post', `/pos/devices/${device.id}/retire`, adminA),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);

      const row = await tenantContext.run(tenantAId, async () =>
        prisma.posDevice.findUnique({ where: { id: device.id } }),
      );
      expect(row?.status).toBe('RETIRED');
    });
  });

  describe('tenant isolation / IDOR (uniform 404)', () => {
    it('cross-tenant device access reveals nothing and mutates nothing', async () => {
      const device = await registerDeviceViaApi(adminA, `XT-${run}-${seq}`);
      const session = await call('post', '/pos/sessions', adminA, {
        deviceId: device.id,
      });
      const sessionId = (session.body as SessionBody).id;

      // Tenant B probes tenant A's device + session: uniform 404.
      expect(
        (await call('get', `/pos/devices/${device.id}`, adminB)).status,
      ).toBe(404);
      expect(
        (await call('post', `/pos/devices/${device.id}/retire`, adminB)).status,
      ).toBe(404);
      expect(
        (
          await call(
            'post',
            `/pos/devices/${device.id}/rotate-credential`,
            adminB,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await call('patch', `/pos/devices/${device.id}`, adminB, {
            name: 'hijack',
          })
        ).status,
      ).toBe(404);
      expect(
        (await call('get', `/pos/sessions/${sessionId}`, adminB)).status,
      ).toBe(404);
      expect(
        (await call('post', `/pos/sessions/${sessionId}/close`, adminB)).status,
      ).toBe(404);
      expect(
        (
          await call('post', '/pos/sessions', adminB, {
            deviceId: device.id,
          })
        ).status,
      ).toBe(404);

      // Tenant A's state is fully intact.
      const row = await tenantContext.run(tenantAId, async () =>
        prisma.posDevice.findUnique({ where: { id: device.id } }),
      );
      expect(row?.status).toBe('ACTIVE');
      expect(row?.name).toBe(`XT-${run}-${seq}`);
      const sessionRow = await tenantContext.run(tenantAId, async () =>
        prisma.posSession.findUnique({ where: { id: sessionId } }),
      );
      expect(sessionRow?.status).toBe('OPEN');
    });

    it('device lists are isolated per X-Tenant-ID', async () => {
      await registerDeviceViaApi(adminA, `ISO-A-${run}-${seq}`);
      await registerDeviceViaApi(adminB, `ISO-B-${run}-${seq}`, storeBId);

      const listA = await call('get', '/pos/devices', adminA);
      const listB = await call('get', '/pos/devices', adminB);
      const idsA = (listA.body as { data: DeviceBody[] }).data.map((d) => d.id);
      const idsB = (listB.body as { data: DeviceBody[] }).data.map((d) => d.id);
      expect(idsA.length).toBeGreaterThan(0);
      expect(idsB.length).toBeGreaterThan(0);
      expect(idsA.some((id) => idsB.includes(id))).toBe(false);
    });

    it('direct prisma reads are scoped by the ambient tenant context', async () => {
      const device = await registerDeviceViaApi(adminA, `ALS-${run}-${seq}`);

      const inA = await tenantContext.run(tenantAId, async () =>
        prisma.posDevice.findUnique({ where: { id: device.id } }),
      );
      expect(inA?.id).toBe(device.id);
      const inB = await tenantContext.run(tenantBId, async () =>
        prisma.posDevice.findUnique({ where: { id: device.id } }),
      );
      expect(inB).toBeNull();
    });
  });

  describe('list pagination (keyset parity)', () => {
    it('status filter + cursor chaining produce disjoint pages', async () => {
      for (let i = 0; i < 3; i++) {
        await registerDeviceViaApi(adminA, `PG-${run}-${seq}-${i}`);
      }
      const page1 = await call('get', '/pos/devices?limit=2', adminA);
      expect(page1.status).toBe(200);
      const body1 = page1.body as {
        data: DeviceBody[];
        meta: { nextCursor: string | null };
      };
      expect(body1.data.length).toBe(2);
      expect(body1.meta.nextCursor).not.toBeNull();

      const page2 = await call(
        'get',
        `/pos/devices?limit=2&cursor=${encodeURIComponent(body1.meta.nextCursor!)}`,
        adminA,
      );
      const ids1 = (page1.body as { data: DeviceBody[] }).data.map((d) => d.id);
      const ids2 = (page2.body as { data: DeviceBody[] }).data.map((d) => d.id);
      expect(ids1.some((id) => ids2.includes(id))).toBe(false);

      const filtered = await call('get', '/pos/devices?status=ACTIVE', adminA);
      const rows = (filtered.body as { data: DeviceBody[] }).data;
      expect(rows.every((d) => d.status === 'ACTIVE')).toBe(true);

      const bad = await call('get', '/pos/devices?status=BAD', adminA);
      expect(bad.status).toBe(400);
      const badCursor = await call(
        'get',
        '/pos/devices?cursor=garbage',
        adminA,
      );
      expect(badCursor.status).toBe(400);
    });
  });
});
