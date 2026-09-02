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
 * Phase 5 P5-U1 — Service catalog integration suite.
 *
 * Real AppModule + supertest + real PostgreSQL. Covers: 401/403 gates,
 * the B21 RBAC matrix (service:read / service:create / service:manage;
 * manage-only-writes, create-only-writes, employee read-only, owner
 * semantic-all), CRUD happy path (DRAFT default -> PATCH name/description/
 * status -> ARCHIVED soft-retirement), keyset pagination envelope + cursor
 * chaining + status filter, duplicate-name 409 within a tenant + same name
 * across tenants (composite uniqueness), IDOR cross-tenant uniform 404,
 * ownership-field + deferred-domain-field injection 400, and concurrent
 * duplicate creation (DB UNIQUE arbitrates).
 */
describe('Service Catalog (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }
  interface ServiceBody {
    id: string;
    tenantId: string;
    name: string;
    description: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `svc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
      await prisma.membership
        .deleteMany({ where: { id: { in: membershipIdsToDelete } } })
        .catch(() => undefined);
      await prisma.rolePermission
        .deleteMany({ where: { roleId: { in: roleIdsToDelete } } })
        .catch(() => undefined);
      await prisma.role
        .deleteMany({ where: { id: { in: roleIdsToDelete } } })
        .catch(() => undefined);
      await prisma.service
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
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
  let adminA: Record<string, string>;
  let employeeA: Record<string, string>;
  let manageOnlyA: Record<string, string>;
  let createOnlyA: Record<string, string>;
  let ownerA: Record<string, string>;
  let adminB: Record<string, string>;

  let seq = 0;

  beforeEach(async () => {
    seq += 1;
    const tenantA = await createTenant('a');
    tenantAId = tenantA.id;
    const adminRole = await grantRole(tenantAId, `admin-a-${run}`, [
      PERMISSIONS.SERVICE_READ,
      PERMISSIONS.SERVICE_CREATE,
      PERMISSIONS.SERVICE_MANAGE,
    ]);
    const employeeRole = await grantRole(tenantAId, `employee-a-${run}`, [
      PERMISSIONS.SERVICE_READ,
    ]);
    const manageOnlyRole = await grantRole(tenantAId, `manageonly-a-${run}`, [
      PERMISSIONS.SERVICE_MANAGE,
    ]);
    const createOnlyRole = await grantRole(tenantAId, `createonly-a-${run}`, [
      PERMISSIONS.SERVICE_CREATE,
    ]);
    const ownerRole = await grantRole(tenantAId, SYSTEM_ROLE_KEYS.OWNER, []);

    const adminUser = await createUser(
      `admin-${run}-${seq}@a.test`,
      tenantAId,
      adminRole.id,
    );
    const employeeUser = await createUser(
      `employee-${run}-${seq}@a.test`,
      tenantAId,
      employeeRole.id,
    );
    const manageOnlyUser = await createUser(
      `manageonly-${run}-${seq}@a.test`,
      tenantAId,
      manageOnlyRole.id,
    );
    const createOnlyUser = await createUser(
      `createonly-${run}-${seq}@a.test`,
      tenantAId,
      createOnlyRole.id,
    );
    const ownerUser = await createUser(
      `owner-${run}-${seq}@a.test`,
      tenantAId,
      ownerRole.id,
    );

    const tenantB = await createTenant('b');
    tenantBId = tenantB.id;
    const adminRoleB = await grantRole(tenantBId, `admin-b-${run}`, [
      PERMISSIONS.SERVICE_READ,
      PERMISSIONS.SERVICE_CREATE,
      PERMISSIONS.SERVICE_MANAGE,
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

    adminA = await loginAs(adminUser.id, tenantAId);
    employeeA = await loginAs(employeeUser.id, tenantAId);
    manageOnlyA = await loginAs(manageOnlyUser.id, tenantAId);
    createOnlyA = await loginAs(createOnlyUser.id, tenantAId);
    ownerA = await loginAs(ownerUser.id, tenantAId);
    adminB = await loginAs(adminBUser.id, tenantBId);
  });

  const createService = async (
    headers: Record<string, string>,
    name: string,
    extra: Record<string, unknown> = {},
  ) => call('post', '/services', headers, { name, ...extra });

  describe('authentication and authorization gates', () => {
    it('rejects unauthenticated with 401 on every route', async () => {
      expect((await call('get', '/services', {})).status).toBe(401);
      expect((await call('get', '/services/x', {})).status).toBe(401);
      expect((await call('post', '/services', {}, { name: 'x' })).status).toBe(
        401,
      );
      expect(
        (await call('patch', '/services/x', {}, { name: 'y' })).status,
      ).toBe(401);
    });

    it('rejects an outsider without membership with 403', async () => {
      const outsiderUser = await prisma.user.findUniqueOrThrow({
        where: { email: `outsider-${run}-${seq}@x.test` },
      });
      const headers = await loginAs(outsiderUser.id, tenantAId);
      expect((await call('get', '/services', headers)).status).toBe(403);
      expect(
        (await call('post', '/services', headers, { name: 'x' })).status,
      ).toBe(403);
    });

    it('rejects a member without service:read with 403 on GET', async () => {
      const noReadRole = await grantRole(tenantAId, `noread-${run}`, [
        PERMISSIONS.SERVICE_CREATE,
      ]);
      const noReadUser = await createUser(
        `noread-${run}-${seq}@a.test`,
        tenantAId,
        noReadRole.id,
      );
      const headers = await loginAs(noReadUser.id, tenantAId);
      expect((await call('get', '/services', headers)).status).toBe(403);
      expect((await call('get', '/services/x', headers)).status).toBe(403);
    });

    it('rejects a member without service:create with 403 on POST', async () => {
      const employeeUser = await prisma.user.findUniqueOrThrow({
        where: { email: `employee-${run}-${seq}@a.test` },
      });
      const headers = await loginAs(employeeUser.id, tenantAId);
      expect(
        (await call('post', '/services', headers, { name: 'x' })).status,
      ).toBe(403);
    });

    it('rejects a member without service:manage with 403 on PATCH', async () => {
      const created = await createService(adminA, 'GateSvc');
      const svcId = (created.body as ServiceBody).id;
      // employee (read-only) and create-only both lack manage
      expect(
        (await call('patch', `/services/${svcId}`, employeeA, { name: 'y' }))
          .status,
      ).toBe(403);
      expect(
        (await call('patch', `/services/${svcId}`, createOnlyA, { name: 'y' }))
          .status,
      ).toBe(403);
    });

    it('manage-only can create and patch but cannot read', async () => {
      // manage key authorizes create/update via RequireAnyPermission.
      const created = await createService(manageOnlyA, 'ManageOnlySvc');
      expect(created.status).toBe(201);
      const svcId = (created.body as ServiceBody).id;
      const patched = await call('patch', `/services/${svcId}`, manageOnlyA, {
        description: 'by manage',
      });
      expect(patched.status).toBe(200);
      expect((await call('get', '/services', manageOnlyA)).status).toBe(403);
      expect(
        (await call('get', `/services/${svcId}`, manageOnlyA)).status,
      ).toBe(403);
    });

    it('create-only can create but cannot read or patch', async () => {
      const created = await createService(createOnlyA, 'CreateOnlySvc');
      expect(created.status).toBe(201);
      const svcId = (created.body as ServiceBody).id;
      expect((await call('get', '/services', createOnlyA)).status).toBe(403);
      expect(
        (await call('patch', `/services/${svcId}`, createOnlyA, { name: 'y' }))
          .status,
      ).toBe(403);
    });

    it('owner semantic-all works without explicit grants', async () => {
      const created = await createService(ownerA, 'OwnerSvc');
      expect(created.status).toBe(201);
      expect((await call('get', '/services', ownerA)).status).toBe(200);
      const svcId = (created.body as ServiceBody).id;
      const patched = await call('patch', `/services/${svcId}`, ownerA, {
        name: 'OwnerSvc2',
      });
      expect(patched.status).toBe(200);
    });
  });

  describe('CRUD happy path and catalog semantics', () => {
    it('creates with DRAFT default, patches fields, archives (soft retirement)', async () => {
      const created = await createService(adminA, 'Haircut', {
        description: 'A standard haircut',
      });
      expect(created.status).toBe(201);
      let body = created.body as ServiceBody;
      expect(body.status).toBe('DRAFT');
      expect(body.tenantId).toBe(tenantAId);
      expect(body.name).toBe('Haircut');
      expect(body.description).toBe('A standard haircut');

      const patched = await call('patch', `/services/${body.id}`, adminA, {
        name: 'Haircut Premium',
        description: 'Updated',
        status: 'ACTIVE',
      });
      expect(patched.status).toBe(200);
      body = patched.body as ServiceBody;
      expect(body.name).toBe('Haircut Premium');
      expect(body.status).toBe('ACTIVE');

      // Archive = soft retirement (the established catalog convention).
      const archived = await call('patch', `/services/${body.id}`, adminA, {
        status: 'ARCHIVED',
      });
      expect((archived.body as ServiceBody).status).toBe('ARCHIVED');

      const fetched = await call('get', `/services/${body.id}`, adminA);
      expect((fetched.body as ServiceBody).status).toBe('ARCHIVED');
    });

    it('create with an explicit ACTIVE status is honored', async () => {
      const created = await createService(adminA, 'ImmediateSvc', {
        status: 'ACTIVE',
      });
      expect((created.body as ServiceBody).status).toBe('ACTIVE');
    });

    it('returns the canonical 404 for an unknown service', async () => {
      const res = await call('get', '/services/no-such-svc', adminA);
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Service not found');
    });
  });

  describe('uniqueness (composite, per tenant)', () => {
    it('rejects a duplicate name within the same tenant with 409', async () => {
      const name = `Dup-${run}-${seq}`;
      await createService(adminA, name);
      const dup = await createService(adminA, name);
      expect(dup.status).toBe(409);
      expect((dup.body as ErrorBody).message).toBe(
        'A service with this name already exists in the tenant',
      );
      // Exactly one row exists.
      const count = await tenantContext.run(tenantAId, async () =>
        prisma.service.count({ where: { tenantId: tenantAId, name } }),
      );
      expect(count).toBe(1);
    });

    it('allows the same name in a different tenant (composite uniqueness)', async () => {
      const name = `Cross-${run}-${seq}`;
      const a = await createService(adminA, name);
      const b = await createService(adminB, name);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect((a.body as ServiceBody).tenantId).toBe(tenantAId);
      expect((b.body as ServiceBody).tenantId).toBe(tenantBId);
    });

    it('rejects a rename collision with 409 (P2002)', async () => {
      await createService(adminA, `CollA-${run}-${seq}`);
      const target = await createService(adminA, `CollB-${run}-${seq}`);
      const res = await call(
        'patch',
        `/services/${(target.body as ServiceBody).id}`,
        adminA,
        { name: `CollA-${run}-${seq}` },
      );
      expect(res.status).toBe(409);
    });

    it('concurrent duplicate creation: the DB UNIQUE arbitrates (exactly one row)', async () => {
      const name = `Race-${run}-${seq}`;
      const [a, b] = await Promise.all([
        createService(adminA, name),
        createService(adminA, name),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      const count = await tenantContext.run(tenantAId, async () =>
        prisma.service.count({ where: { tenantId: tenantAId, name } }),
      );
      expect(count).toBe(1); // never two rows
    });
  });

  describe('tenant isolation / IDOR', () => {
    it('hides a foreign service with the uniform 404 (GET and PATCH)', async () => {
      const createdB = await createService(adminB, `IsolatedB-${run}-${seq}`);
      const bId = (createdB.body as ServiceBody).id;

      expect((await call('get', `/services/${bId}`, adminA)).status).toBe(404);
      expect(
        (await call('patch', `/services/${bId}`, adminA, { name: 'hijack' }))
          .status,
      ).toBe(404);
      // The foreign row is untouched.
      const row = await tenantContext.run(tenantBId, async () =>
        prisma.service.findUniqueOrThrow({ where: { id: bId } }),
      );
      expect(row.name).toBe(`IsolatedB-${run}-${seq}`);

      // Reverse direction: B cannot see A's service either.
      const createdA = await createService(adminA, `IsolatedA-${run}-${seq}`);
      expect(
        (
          await call(
            'get',
            `/services/${(createdA.body as ServiceBody).id}`,
            adminB,
          )
        ).status,
      ).toBe(404);
    });

    it('lists are isolated per X-Tenant-ID', async () => {
      await createService(adminA, `ListA-${run}-${seq}`);
      await createService(adminB, `ListB-${run}-${seq}`);
      const listA = await call('get', '/services', adminA);
      const listB = await call('get', '/services', adminB);
      const idsA = ((listA.body as { data: ServiceBody[] }).data || []).map(
        (s) => s.id,
      );
      const idsB = ((listB.body as { data: ServiceBody[] }).data || []).map(
        (s) => s.id,
      );
      expect(idsA.length).toBeGreaterThan(0);
      expect(idsB.length).toBeGreaterThan(0);
      expect(idsA.some((id) => idsB.includes(id))).toBe(false);
    });

    it('direct prisma reads are scoped by the ambient tenant context', async () => {
      const created = await createService(adminA, `Ambient-${run}-${seq}`);
      const svcId = (created.body as ServiceBody).id;
      const inA = await tenantContext.run(tenantAId, async () =>
        prisma.service.findUnique({ where: { id: svcId } }),
      );
      expect(inA?.id).toBe(svcId);
      const inB = await tenantContext.run(tenantBId, async () =>
        prisma.service.findUnique({ where: { id: svcId } }),
      );
      expect(inB).toBeNull();
    });
  });

  describe('validation contract', () => {
    it('rejects missing/empty name and invalid status with 400', async () => {
      const cases: Array<Record<string, unknown>> = [
        {},
        { name: '' },
        { name: 'x'.repeat(201) },
        { name: 'x', status: 'OPEN' },
      ];
      for (const payload of cases) {
        expect(
          (await createService(adminA, payload.name ?? '', payload)).status,
        ).toBe(400);
      }
    });

    it('rejects ownership-field injections on create with 400', async () => {
      const injections = [
        { name: 'x', tenantId: tenantBId },
        { name: 'x', id: 'svc-1' },
        { name: 'x', createdAt: new Date().toISOString() },
        { name: 'x', updatedAt: new Date().toISOString() },
        { name: 'x', bogus: true },
      ];
      for (const payload of injections) {
        const res = await call('post', '/services', adminA, payload);
        expect(res.status).toBe(400);
      }
      const rows = await tenantContext.run(tenantAId, async () =>
        prisma.service.count({ where: { tenantId: tenantAId } }),
      );
      expect(rows).toBe(0); // nothing was created by any injection
    });

    it('rejects deferred-domain field injections (pricing/duration/booking) with 400', async () => {
      const injections = [
        { name: 'x', price: 100 },
        { name: 'x', amountMinor: 1000 },
        { name: 'x', currency: 'USD' },
        { name: 'x', durationMinutes: 30 },
        { name: 'x', staffId: 's' },
        { name: 'x', resourceId: 'r' },
        { name: 'x', bookingId: 'b' },
        { name: 'x', scheduleId: 'sc' },
      ];
      for (const payload of injections) {
        const res = await call('post', '/services', adminA, payload);
        expect(res.status).toBe(400);
      }
    });

    it('rejects ownership-field injections on update with 400', async () => {
      const created = await createService(adminA, 'PatchGateSvc');
      const svcId = (created.body as ServiceBody).id;
      const injections = [
        { tenantId: tenantBId },
        { id: 'svc-9' },
        { createdAt: new Date().toISOString() },
        { bogus: 1 },
      ];
      for (const payload of injections) {
        const res = await call('patch', `/services/${svcId}`, adminA, payload);
        expect(res.status).toBe(400);
      }
      // The row is unchanged after the rejected patches.
      const row = await tenantContext.run(tenantAId, async () =>
        prisma.service.findUniqueOrThrow({ where: { id: svcId } }),
      );
      expect(row.name).toBe('PatchGateSvc');
      expect(row.status).toBe('DRAFT');
    });
  });

  describe('pagination (keyset envelope parity)', () => {
    it('returns the envelope, chains cursors, and filters by status', async () => {
      // Create 4 services: 3 ACTIVE + 1 ARCHIVED.
      for (let i = 0; i < 3; i++) {
        await createService(adminA, `Page-${run}-${seq}-${i}`, {
          status: 'ACTIVE',
        });
      }
      const archived = await createService(adminA, `PageArc-${run}-${seq}`, {
        status: 'ARCHIVED',
      });
      expect(archived.status).toBe(201);

      const page1 = await call('get', '/services?limit=2', adminA);
      expect(page1.status).toBe(200);
      const body1 = page1.body as {
        data: ServiceBody[];
        meta: { nextCursor: string | null };
      };
      expect(body1.data.length).toBe(2);
      expect(body1.meta.nextCursor).not.toBeNull();

      const page2 = await call(
        'get',
        `/services?limit=2&cursor=${encodeURIComponent(body1.meta.nextCursor!)}`,
        adminA,
      );
      const body2 = page2.body as {
        data: ServiceBody[];
        meta: { nextCursor: string | null };
      };
      const ids1 = body1.data.map((s) => s.id);
      const ids2 = body2.data.map((s) => s.id);
      expect(ids1.some((id) => ids2.includes(id))).toBe(false); // disjoint

      // Status filter.
      const activeOnly = await call('get', '/services?status=ACTIVE', adminA);
      const activeBody = activeOnly.body as { data: ServiceBody[] };
      expect(activeBody.data.every((s) => s.status === 'ACTIVE')).toBe(true);
      expect(activeBody.data.length).toBeGreaterThanOrEqual(3);

      const badStatus = await call('get', '/services?status=OPEN', adminA);
      expect(badStatus.status).toBe(400);

      const badCursor = await call('get', '/services?cursor=garbage', adminA);
      expect(badCursor.status).toBe(400);
    });
  });
});
