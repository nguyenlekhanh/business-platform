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
 * Phase 3 U1 — Category integration suite.
 *
 * Covers the approved matrix: CRUD, tenant isolation, IDOR, the RBAC matrix
 * (admin CRUD / employee read-only / owner semantic-all / manage-only cannot
 * read), invalid bodies, tenantId injection attempts, the shared keyset
 * pagination envelope, and invalid cursors. Every persona is a real database
 * row with real role->permission grants so the guard chain
 * (JWT -> TenantResolutionGuard -> PermissionsGuard) is exercised end-to-end.
 */
describe('CategoryModule (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }

  interface CategoryBody {
    id: string;
    tenantId: string;
    name: string;
    description: string | null;
  }

  interface ListBody {
    data: CategoryBody[];
    meta: { nextCursor: string | null };
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `cat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

  // Creates a role inside an existing tenant and grants catalog permissions.
  // Role/Membership are tenant-scoped models: fixture writes must run inside
  // an explicit TenantContext AND await inside the callback, or they fail
  // closed.
  const grantRole = async (
    tenantId: string,
    key: string,
    permissionKeys: readonly string[],
  ) => {
    const role = await tenantContext.run(tenantId, async () =>
      prisma.role.create({
        data: { tenantId, key, name: `${key} ${run}` },
      }),
    );
    roleIdsToDelete.push(role.id);
    if (permissionKeys.length > 0) {
      await tenantContext.run(tenantId, async () => {
        // Grants reference the Permission catalog row id (join table).
        const permissions = await prisma.permission.findMany({
          where: { key: { in: [...permissionKeys] } },
        });
        await prisma.rolePermission.createMany({
          data: permissions.map((permission) => ({
            roleId: role.id,
            permissionId: permission.id,
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
      prisma.membership.create({
        data: { userId: user.id, tenantId, roleId },
      }),
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
    if (payload !== undefined) {
      req = req.send(payload);
    }
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

    // Seed the global permission catalog rows used by the grants below.
    // Idempotent + race-safe against other suites seeding concurrently;
    // catalog rows are shared platform data and are NOT deleted afterAll.
    await prisma.permission.createMany({
      data: PERMISSION_DEFINITIONS.map((definition) => ({
        key: definition.key,
        name: definition.name,
        category: definition.category,
        description: definition.description ?? null,
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
      await prisma.membership
        .deleteMany({ where: { userId: { in: userIdsToDelete } } })
        .catch(() => undefined);
      await prisma.user
        .deleteMany({ where: { id: { in: userIdsToDelete } } })
        .catch(() => undefined);
      // Category rows (and everything else tenant-owned) go with the tenant.
      await prisma.tenant
        .deleteMany({ where: { id: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
    }
    if (app) {
      await app.close();
    }
  });

  let tenantAId: string;
  let adminAId: string;
  let employeeAId: string;
  let managerAId: string;
  let manageOnlyAId: string;
  let ownerAId: string;
  let tenantBId: string;
  let adminBId: string;

  let adminA: Record<string, string>;
  let employeeA: Record<string, string>;
  let managerA: Record<string, string>;
  let manageOnlyA: Record<string, string>;
  let ownerA: Record<string, string>;
  let adminB: Record<string, string>;

  // Per-test uniqueness for globally unique columns (User.email).
  let seq = 0;

  beforeEach(async () => {
    seq += 1;
    // Tenant A personas exercise the whole RBAC matrix (all roles live in
    // tenant A; the composite Membership FK requires same-tenant roles).
    const tenantA = await createTenant('a');
    tenantAId = tenantA.id;
    // Full CRUD persona (mirrors the effective tenant-admin key set).
    const adminRole = await grantRole(tenantAId, `admin-a-${run}`, [
      PERMISSIONS.CATEGORY_READ,
      PERMISSIONS.CATEGORY_CREATE,
      PERMISSIONS.CATEGORY_UPDATE,
      PERMISSIONS.CATEGORY_DELETE,
      PERMISSIONS.CATEGORY_MANAGE,
    ]);
    const employeeRole = await grantRole(tenantAId, `employee-a-${run}`, [
      PERMISSIONS.CATEGORY_READ,
    ]);
    // Deliberately NO category permissions.
    const managerRole = await grantRole(tenantAId, `manager-a-${run}`, []);
    // Manage-only: may write but must NOT be able to read.
    const manageOnlyRole = await grantRole(tenantAId, `manageonly-a-${run}`, [
      PERMISSIONS.CATEGORY_MANAGE,
    ]);
    // Owner semantic-all is keyed on the membership's role key (no grants).
    const ownerRole = await grantRole(tenantAId, SYSTEM_ROLE_KEYS.OWNER, []);

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
    managerAId = (
      await createUser(
        `manager-${run}-${seq}@a.test`,
        tenantAId,
        managerRole.id,
      )
    ).id;
    manageOnlyAId = (
      await createUser(
        `manageonly-${run}-${seq}@a.test`,
        tenantAId,
        manageOnlyRole.id,
      )
    ).id;
    ownerAId = (
      await createUser(`owner-${run}-${seq}@a.test`, tenantAId, ownerRole.id)
    ).id;

    // Tenant B proves cross-tenant isolation/IDOR semantics.
    const tenantB = await createTenant('b');
    tenantBId = tenantB.id;
    const adminRoleB = await grantRole(tenantBId, `admin-b-${run}`, [
      PERMISSIONS.CATEGORY_READ,
      PERMISSIONS.CATEGORY_CREATE,
      PERMISSIONS.CATEGORY_UPDATE,
      PERMISSIONS.CATEGORY_DELETE,
      PERMISSIONS.CATEGORY_MANAGE,
    ]);
    adminBId = (
      await createUser(`admin-${run}-${seq}@b.test`, tenantBId, adminRoleB.id)
    ).id;

    const outsider = await prisma.user.create({
      data: {
        email: `outsider-${run}-${seq}@x.test`,
        passwordHash: 'hash-x',
      },
    });
    userIdsToDelete.push(outsider.id);

    adminA = await loginAs(adminAId, tenantAId);
    employeeA = await loginAs(employeeAId, tenantAId);
    managerA = await loginAs(managerAId, tenantAId);
    manageOnlyA = await loginAs(manageOnlyAId, tenantAId);
    ownerA = await loginAs(ownerAId, tenantAId);
    adminB = await loginAs(adminBId, tenantBId);
  });

  describe('authentication and authorization gates', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const listed = await call('get', '/categories', {});
      expect(listed.status).toBe(401);
      const created = await call('post', '/categories', {}, { name: 'Nope' });
      expect(created.status).toBe(401);
    });

    it('rejects an authenticated user without any tenant membership with 403 on every route', async () => {
      const outsiderUser = await prisma.user.findUniqueOrThrow({
        where: { email: `outsider-${run}-${seq}@x.test` },
      });
      const headers = await loginAs(outsiderUser.id, tenantAId);
      const listed = await call('get', '/categories', headers);
      expect(listed.status).toBe(403);
      const created = await call('post', '/categories', headers, {
        name: 'Nope',
      });
      expect(created.status).toBe(403);
      const patched = await call('patch', '/categories/some-id', headers, {
        name: 'Nope',
      });
      expect(patched.status).toBe(403);
      const deleted = await call('delete', '/categories/some-id', headers);
      expect(deleted.status).toBe(403);
    });

    it('rejects a member without category permissions (manager) with 403', async () => {
      const listed = await call('get', '/categories', managerA);
      expect(listed.status).toBe(403);
      const created = await call('post', '/categories', managerA, {
        name: 'Nope',
      });
      expect(created.status).toBe(403);
    });
  });

  describe('admin CRUD lifecycle', () => {
    it('creates, reads, patches and deletes a category', async () => {
      const createdRes = await call('post', '/categories', adminA, {
        name: `Beverages ${run}`,
        description: 'Drinks',
      });
      expect(createdRes.status).toBe(201);
      const created = createdRes.body as unknown as CategoryBody;
      expect(created.tenantId).toBe(tenantAId);
      expect(created.name).toBe(`Beverages ${run}`);
      expect(created.description).toBe('Drinks');

      const listedRes = await call('get', '/categories', adminA);
      expect(listedRes.status).toBe(200);
      const listed = listedRes.body as ListBody;
      expect(Object.keys(listedRes.body)).toEqual(['data', 'meta']);
      expect(Object.keys(listed.meta)).toEqual(['nextCursor']);
      expect(listed.data.some((row) => row.id === created.id)).toBe(true);

      const fetchedRes = await call('get', `/categories/${created.id}`, adminA);
      expect(fetchedRes.status).toBe(200);
      const fetched = fetchedRes.body as CategoryBody;
      expect(fetched.name).toBe(`Beverages ${run}`);

      const patchedRes = await call(
        'patch',
        `/categories/${created.id}`,
        adminA,
        { name: `Soft Drinks ${run}` },
      );
      expect(patchedRes.status).toBe(200);
      const patched = patchedRes.body as CategoryBody;
      expect(patched.name).toBe(`Soft Drinks ${run}`);

      const deleted = await call('delete', `/categories/${created.id}`, adminA);
      expect(deleted.status).toBe(204);

      const missingRes = await call('get', `/categories/${created.id}`, adminA);
      expect(missingRes.status).toBe(404);
    });

    it('maps a duplicate name in the same tenant to 409', async () => {
      const name = `Dup ${run}`;
      const first = await call('post', '/categories', adminA, { name });
      expect(first.status).toBe(201);
      const second = await call('post', '/categories', adminA, { name });
      expect(second.status).toBe(409);
      const error = second.body as ErrorBody;
      expect(error.message).toBe(
        'A category with this name already exists in the tenant',
      );
    });

    it('allows the same name in different tenants (composite uniqueness)', async () => {
      const name = `Shared ${run}`;
      const inA = await call('post', '/categories', adminA, { name });
      expect(inA.status).toBe(201);
      const inB = await call('post', '/categories', adminB, { name });
      expect(inB.status).toBe(201);
    });

    it('returns the canonical NotFound error for unknown ids', async () => {
      const missing = await call(
        'get',
        `/categories/does-not-exist-${run}`,
        adminA,
      );
      expect(missing.status).toBe(404);
      const error = missing.body as ErrorBody;
      expect(error.message).toBe('Category not found');
    });
  });

  describe('tenant isolation and IDOR', () => {
    it('hides tenant B categories from tenant A members on all operations', async () => {
      const createdRes = await call('post', '/categories', adminB, {
        name: `Secret B ${run}`,
      });
      expect(createdRes.status).toBe(201);
      const foreign = createdRes.body as CategoryBody;
      const foreignId = foreign.id;

      const listedRes = await call('get', '/categories', adminA);
      expect(listedRes.status).toBe(200);
      const listed = listedRes.body as ListBody;
      expect(listed.data.some((row) => row.id === foreignId)).toBe(false);

      const got = await call('get', `/categories/${foreignId}`, adminA);
      expect(got.status).toBe(404);
      const patched = await call('patch', `/categories/${foreignId}`, adminA, {
        name: 'Hijack',
      });
      expect(patched.status).toBe(404);
      const deleted = await call('delete', `/categories/${foreignId}`, adminA);
      expect(deleted.status).toBe(404);
      const employeeGot = await call(
        'get',
        `/categories/${foreignId}`,
        employeeA,
      );
      expect(employeeGot.status).toBe(404);
    });

    it('scopes the list to the X-Tenant-ID tenant', async () => {
      const nameA = `Only A ${run}`;
      const nameB = `Only B ${run}`;
      const inA = await call('post', '/categories', adminA, { name: nameA });
      expect(inA.status).toBe(201);
      const inB = await call('post', '/categories', adminB, { name: nameB });
      expect(inB.status).toBe(201);

      const listedRes = await call('get', '/categories', adminB);
      expect(listedRes.status).toBe(200);
      const listed = listedRes.body as ListBody;
      const namesB = listed.data.map((row) => row.name);
      expect(namesB).toContain(nameB);
      expect(namesB).not.toContain(nameA);
      expect(listed.data.every((row) => row.tenantId === tenantBId)).toBe(true);
    });
  });

  describe('RBAC matrix', () => {
    it('grants manage-only roles writes but never reads', async () => {
      const listed = await call('get', '/categories', manageOnlyA);
      expect(listed.status).toBe(403);
      const createdRes = await call('post', '/categories', manageOnlyA, {
        name: `Manage Only ${run}`,
      });
      expect(createdRes.status).toBe(201);
      const created = createdRes.body as CategoryBody;
      expect(created.tenantId).toBe(tenantAId);
      const deleted = await call(
        'delete',
        `/categories/${created.id}`,
        manageOnlyA,
      );
      expect(deleted.status).toBe(204);
    });

    it('makes employee strictly read-only', async () => {
      const seededRes = await call('post', '/categories', adminA, {
        name: `Readable ${run}`,
      });
      expect(seededRes.status).toBe(201);
      const seeded = seededRes.body as CategoryBody;

      const listed = await call('get', '/categories', employeeA);
      expect(listed.status).toBe(200);
      const got = await call('get', `/categories/${seeded.id}`, employeeA);
      expect(got.status).toBe(200);

      const created = await call('post', '/categories', employeeA, {
        name: 'Nope',
      });
      expect(created.status).toBe(403);
      const patched = await call(
        'patch',
        `/categories/${seeded.id}`,
        employeeA,
        { name: 'Nope' },
      );
      expect(patched.status).toBe(403);
      const deleted = await call(
        'delete',
        `/categories/${seeded.id}`,
        employeeA,
      );
      expect(deleted.status).toBe(403);
    });

    it('gives the owner semantic-all access without explicit grants', async () => {
      const createdRes = await call('post', '/categories', ownerA, {
        name: `Owner Cat ${run}`,
      });
      expect(createdRes.status).toBe(201);
      const created = createdRes.body as CategoryBody;

      const got = await call('get', `/categories/${created.id}`, ownerA);
      expect(got.status).toBe(200);

      const patchedRes = await call(
        'patch',
        `/categories/${created.id}`,
        ownerA,
        { description: 'owner touched' },
      );
      expect(patchedRes.status).toBe(200);
      const patched = patchedRes.body as CategoryBody;
      expect(patched.description).toBe('owner touched');

      const deleted = await call('delete', `/categories/${created.id}`, ownerA);
      expect(deleted.status).toBe(204);
    });
  });

  describe('validation contract', () => {
    it('rejects invalid create payloads with 400', async () => {
      const invalidPayloads: Array<Record<string, unknown>> = [
        {},
        { description: 'd' },
        { name: '' },
        { name: 42 },
        { name: 'Ok', bogus: true },
      ];
      for (const payload of invalidPayloads) {
        const res = await call('post', '/categories', adminA, payload);
        expect(res.status).toBe(400);
      }
    });

    it('rejects client-supplied tenantId on create (injection attempt)', async () => {
      const res = await call('post', '/categories', adminA, {
        name: `Injected ${run}`,
        tenantId: tenantBId,
      });
      expect(res.status).toBe(400);
    });

    it('rejects client-supplied tenantId/id on patch', async () => {
      const seededRes = await call('post', '/categories', adminA, {
        name: `Patch Guard ${run}`,
      });
      expect(seededRes.status).toBe(201);
      const seeded = seededRes.body as CategoryBody;
      const injected = await call('patch', `/categories/${seeded.id}`, adminA, {
        tenantId: tenantBId,
      });
      expect(injected.status).toBe(400);
      const idInjected = await call(
        'patch',
        `/categories/${seeded.id}`,
        adminA,
        { id: 'new-id' },
      );
      expect(idInjected.status).toBe(400);
    });

    it('rejects unknown query fields on list', async () => {
      const res = await call('get', '/categories?status=ACTIVE', adminA);
      expect(res.status).toBe(400);
    });

    it('rejects malformed cursors with 400', async () => {
      const res = await call(
        'get',
        '/categories?cursor=!!!not-base64!!!',
        adminA,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('pagination envelope', () => {
    it('returns the shared { data, meta: { nextCursor } } keyset contract', async () => {
      // Dedicated tenant so the page math below is exact.
      const pagTenant = await createTenant('pag');
      const pagRole = await grantRole(pagTenant.id, `pag-admin-${run}`, [
        PERMISSIONS.CATEGORY_READ,
        PERMISSIONS.CATEGORY_CREATE,
        PERMISSIONS.CATEGORY_MANAGE,
      ]);
      const pagUser = await createUser(
        `pag-${run}-${seq}@a.test`,
        pagTenant.id,
        pagRole.id,
      );
      const pagHeaders = await loginAs(pagUser.id, pagTenant.id);

      const names = [
        `P1 ${run}`,
        `P2 ${run}`,
        `P3 ${run}`,
        `P4 ${run}`,
        `P5 ${run}`,
      ];
      for (const name of names) {
        const res = await call('post', '/categories', pagHeaders, { name });
        expect(res.status).toBe(201);
      }

      const page1Res = await call(
        'get',
        '/categories?limit=2&order=asc',
        pagHeaders,
      );
      expect(page1Res.status).toBe(200);
      expect(Object.keys(page1Res.body)).toEqual(['data', 'meta']);
      const page1 = page1Res.body as ListBody;
      expect(page1.data.map((row) => row.name)).toEqual([
        `P1 ${run}`,
        `P2 ${run}`,
      ]);
      const cursor1 = page1.meta.nextCursor;
      if (!cursor1) {
        throw new Error('expected page 1 to carry a nextCursor');
      }

      const page2Res = await call(
        'get',
        `/categories?limit=2&order=asc&cursor=${encodeURIComponent(cursor1)}`,
        pagHeaders,
      );
      expect(page2Res.status).toBe(200);
      const page2 = page2Res.body as ListBody;
      expect(page2.data.map((row) => row.name)).toEqual([
        `P3 ${run}`,
        `P4 ${run}`,
      ]);
      const cursor2 = page2.meta.nextCursor;
      if (!cursor2) {
        throw new Error('expected page 2 to carry a nextCursor');
      }

      const page3Res = await call(
        'get',
        `/categories?limit=2&order=asc&cursor=${encodeURIComponent(cursor2)}`,
        pagHeaders,
      );
      expect(page3Res.status).toBe(200);
      const page3 = page3Res.body as ListBody;
      expect(page3.data.map((row) => row.name)).toEqual([`P5 ${run}`]);
      expect(page3.meta.nextCursor).toBeNull();

      const descRes = await call(
        'get',
        '/categories?limit=2&order=desc',
        pagHeaders,
      );
      expect(descRes.status).toBe(200);
      const descPage = descRes.body as ListBody;
      expect(descPage.data.map((row) => row.name)).toEqual([
        `P5 ${run}`,
        `P4 ${run}`,
      ]);
    });
  });
});
