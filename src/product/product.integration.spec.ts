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
 * Phase 3 U2 — Product integration suite.
 *
 * Mirrors the U1 category matrix and adds the product-specific behaviors:
 * default DRAFT status + PATCH archive flow, (tenantId, code) uniqueness,
 * same-tenant categoryId resolution, status/categoryId list filters, and the
 * RESTRICT FK protection blocking category deletion while products reference
 * it. Every persona is a real database row with real role->permission grants
 * so the guard chain (JWT -> TenantResolutionGuard -> PermissionsGuard) is
 * exercised end-to-end.
 */
describe('ProductModule (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }

  interface ProductBody {
    id: string;
    tenantId: string;
    categoryId: string | null;
    name: string;
    code: string;
    description: string | null;
    status: string;
  }

  interface ListBody {
    data: ProductBody[];
    meta: { nextCursor: string | null };
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `prod-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
      prisma.role.create({
        data: { tenantId, key, name: `${key} ${run}` },
      }),
    );
    roleIdsToDelete.push(role.id);
    if (permissionKeys.length > 0) {
      await tenantContext.run(tenantId, async () => {
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

  // Direct-DB category fixture: independent of HTTP permissions.
  const createCategoryFixture = async (tenantId: string, name: string) => {
    const category = await tenantContext.run(tenantId, async () =>
      prisma.category.create({ data: { tenantId, name } }),
    );
    return category;
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
      // Products first: their RESTRICT FK blocks tenant-less category deletes
      // otherwise (the tenant cascade below handles the rest).
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
    // Tenant A personas exercise the whole RBAC matrix. The admin persona
    // also carries category keys so it can exercise the FK-protection flow.
    const tenantA = await createTenant('a');
    tenantAId = tenantA.id;
    const adminRole = await grantRole(tenantAId, `admin-a-${run}`, [
      PERMISSIONS.PRODUCT_READ,
      PERMISSIONS.PRODUCT_CREATE,
      PERMISSIONS.PRODUCT_UPDATE,
      PERMISSIONS.PRODUCT_DELETE,
      PERMISSIONS.PRODUCT_MANAGE,
      PERMISSIONS.CATEGORY_READ,
      PERMISSIONS.CATEGORY_CREATE,
      PERMISSIONS.CATEGORY_DELETE,
      PERMISSIONS.CATEGORY_MANAGE,
    ]);
    const employeeRole = await grantRole(tenantAId, `employee-a-${run}`, [
      PERMISSIONS.PRODUCT_READ,
    ]);
    // Deliberately NO product permissions.
    const managerRole = await grantRole(tenantAId, `manager-a-${run}`, []);
    // Manage-only: may write but must NOT be able to read.
    const manageOnlyRole = await grantRole(tenantAId, `manageonly-a-${run}`, [
      PERMISSIONS.PRODUCT_MANAGE,
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
      PERMISSIONS.PRODUCT_READ,
      PERMISSIONS.PRODUCT_CREATE,
      PERMISSIONS.PRODUCT_UPDATE,
      PERMISSIONS.PRODUCT_DELETE,
      PERMISSIONS.PRODUCT_MANAGE,
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
      const listed = await call('get', '/products', {});
      expect(listed.status).toBe(401);
      const created = await call(
        'post',
        '/products',
        {},
        { name: 'Nope', code: 'NOPE' },
      );
      expect(created.status).toBe(401);
    });

    it('rejects an authenticated user without any tenant membership with 403 on every route', async () => {
      const outsiderUser = await prisma.user.findUniqueOrThrow({
        where: { email: `outsider-${run}-${seq}@x.test` },
      });
      const headers = await loginAs(outsiderUser.id, tenantAId);
      expect((await call('get', '/products', headers)).status).toBe(403);
      expect(
        (
          await call('post', '/products', headers, {
            name: 'Nope',
            code: 'NOPE',
          })
        ).status,
      ).toBe(403);
      expect(
        (await call('patch', '/products/some-id', headers, { name: 'Nope' }))
          .status,
      ).toBe(403);
      expect((await call('delete', '/products/some-id', headers)).status).toBe(
        403,
      );
    });

    it('rejects a member without product permissions (manager) with 403', async () => {
      expect((await call('get', '/products', managerA)).status).toBe(403);
      expect(
        (
          await call('post', '/products', managerA, {
            name: 'Nope',
            code: 'NOPE',
          })
        ).status,
      ).toBe(403);
    });
  });

  describe('admin CRUD lifecycle', () => {
    it('creates (default DRAFT), reads, patches incl. archive, deletes', async () => {
      const createdRes = await call('post', '/products', adminA, {
        name: `Beans ${run}`,
        code: `BEAN-${run}`,
        description: 'Dark roast',
      });
      expect(createdRes.status).toBe(201);
      const created = createdRes.body as unknown as ProductBody;
      expect(created.tenantId).toBe(tenantAId);
      expect(created.name).toBe(`Beans ${run}`);
      expect(created.code).toBe(`BEAN-${run}`);
      expect(created.status).toBe('DRAFT');
      expect(created.categoryId).toBeNull();

      const listedRes = await call('get', '/products', adminA);
      expect(listedRes.status).toBe(200);
      const listed = listedRes.body as ListBody;
      expect(Object.keys(listedRes.body)).toEqual(['data', 'meta']);
      expect(Object.keys(listed.meta)).toEqual(['nextCursor']);
      expect(listed.data.some((row) => row.id === created.id)).toBe(true);

      const fetchedRes = await call('get', `/products/${created.id}`, adminA);
      expect(fetchedRes.status).toBe(200);
      const fetched = fetchedRes.body as ProductBody;
      expect(fetched.code).toBe(`BEAN-${run}`);

      const activatedRes = await call(
        'patch',
        `/products/${created.id}`,
        adminA,
        { name: `Beans XL ${run}`, status: 'ACTIVE' },
      );
      expect(activatedRes.status).toBe(200);
      const activated = activatedRes.body as ProductBody;
      expect(activated.name).toBe(`Beans XL ${run}`);
      expect(activated.status).toBe('ACTIVE');

      const archivedRes = await call(
        'patch',
        `/products/${created.id}`,
        adminA,
        { status: 'ARCHIVED' },
      );
      expect(archivedRes.status).toBe(200);
      const archived = archivedRes.body as ProductBody;
      expect(archived.status).toBe('ARCHIVED');

      const deleted = await call('delete', `/products/${created.id}`, adminA);
      expect(deleted.status).toBe(204);

      const missingRes = await call('get', `/products/${created.id}`, adminA);
      expect(missingRes.status).toBe(404);
    });

    it('maps a duplicate code in the same tenant to 409', async () => {
      const code = `DUP-${run}`;
      const first = await call('post', '/products', adminA, {
        name: 'First',
        code,
      });
      expect(first.status).toBe(201);
      const second = await call('post', '/products', adminA, {
        name: 'Second',
        code,
      });
      expect(second.status).toBe(409);
      const error = second.body as ErrorBody;
      expect(error.message).toBe(
        'A product with this code already exists in the tenant',
      );
    });

    it('allows the same code in different tenants (composite uniqueness)', async () => {
      const code = `SHARED-${run}`;
      const inA = await call('post', '/products', adminA, {
        name: 'A side',
        code,
      });
      expect(inA.status).toBe(201);
      const inB = await call('post', '/products', adminB, {
        name: 'B side',
        code,
      });
      expect(inB.status).toBe(201);
    });

    it('resolves an optional categoryId within the active tenant only', async () => {
      const catA = await createCategoryFixture(tenantAId, `CatA ${run}`);
      const catB = await createCategoryFixture(tenantBId, `CatB ${run}`);

      const linkedRes = await call('post', '/products', adminA, {
        name: `Linked ${run}`,
        code: `LINK-${run}`,
        categoryId: catA.id,
      });
      expect(linkedRes.status).toBe(201);
      const linked = linkedRes.body as ProductBody;
      expect(linked.categoryId).toBe(catA.id);

      const foreignRes = await call('post', '/products', adminA, {
        name: `Foreign ${run}`,
        code: `FOR-${run}`,
        categoryId: catB.id,
      });
      expect(foreignRes.status).toBe(404);
      const foreignError = foreignRes.body as ErrorBody;
      expect(foreignError.message).toBe('Category not found');

      const bogusRes = await call('post', '/products', adminA, {
        name: `Ghost ${run}`,
        code: `GHOST-${run}`,
        categoryId: `no-such-cat-${run}`,
      });
      expect(bogusRes.status).toBe(404);
    });

    it('blocks deleting a category still referenced by products with 409', async () => {
      const catA = await createCategoryFixture(tenantAId, `Blocked ${run}`);
      const createdRes = await call('post', '/products', adminA, {
        name: `Anchored ${run}`,
        code: `ANCHOR-${run}`,
        categoryId: catA.id,
      });
      expect(createdRes.status).toBe(201);

      const blocked = await call('delete', `/categories/${catA.id}`, adminA);
      expect(blocked.status).toBe(409);
      const error = blocked.body as ErrorBody;
      expect(error.message).toContain('referenced by existing products');

      // Unlinking the product makes deletion possible again.
      const unlinkedRes = await call(
        'patch',
        `/categories/${catA.id}`,
        adminA,
        { description: 'still alive' },
      );
      expect(unlinkedRes.status).toBe(200);
    });

    it('returns the canonical NotFound error for unknown ids', async () => {
      const missing = await call(
        'get',
        `/products/does-not-exist-${run}`,
        adminA,
      );
      expect(missing.status).toBe(404);
      const error = missing.body as ErrorBody;
      expect(error.message).toBe('Product not found');
    });
  });

  describe('list filters', () => {
    it('filters by status and by categoryId', async () => {
      // Dedicated tenant for exact page math.
      const filterTenant = await createTenant(`filters-${seq}`);
      const filterRole = await grantRole(
        filterTenant.id,
        `filter-admin-${run}`,
        [
          PERMISSIONS.PRODUCT_READ,
          PERMISSIONS.PRODUCT_CREATE,
          PERMISSIONS.PRODUCT_MANAGE,
        ],
      );
      const filterUser = await createUser(
        `filter-${run}-${seq}@a.test`,
        filterTenant.id,
        filterRole.id,
      );
      const headers = await loginAs(filterUser.id, filterTenant.id);
      const catX = await createCategoryFixture(
        filterTenant.id,
        `X ${run} ${seq}`,
      );

      const rows: Array<{
        code: string;
        status?: string;
        categoryId?: string;
      }> = [
        { code: `F1-${run}` },
        { code: `F2-${run}`, status: 'ACTIVE' },
        { code: `F3-${run}`, categoryId: catX.id },
        { code: `F4-${run}`, status: 'ACTIVE', categoryId: catX.id },
      ];
      for (const row of rows) {
        const res = await call('post', '/products', headers, {
          name: row.code,
          code: row.code,
          ...(row.status !== undefined ? { status: row.status } : {}),
          ...(row.categoryId !== undefined
            ? { categoryId: row.categoryId }
            : {}),
        });
        expect(res.status).toBe(201);
      }

      const allRes = await call('get', '/products', headers);
      expect(allRes.status).toBe(200);
      expect((allRes.body as ListBody).data).toHaveLength(4);

      const activeRes = await call('get', '/products?status=ACTIVE', headers);
      expect(activeRes.status).toBe(200);
      const activeList = activeRes.body as ListBody;
      expect(activeList.data).toHaveLength(2);
      expect(activeList.data.every((row) => row.status === 'ACTIVE')).toBe(
        true,
      );

      const catRes = await call(
        'get',
        `/products?categoryId=${catX.id}`,
        headers,
      );
      expect(catRes.status).toBe(200);
      const catList = catRes.body as ListBody;
      expect(catList.data).toHaveLength(2);
      expect(catList.data.every((row) => row.categoryId === catX.id)).toBe(
        true,
      );

      const bothRes = await call(
        'get',
        `/products?status=ACTIVE&categoryId=${catX.id}`,
        headers,
      );
      expect(bothRes.status).toBe(200);
      const bothList = bothRes.body as ListBody;
      expect(bothList.data).toHaveLength(1);
      expect(bothList.data[0].code).toBe(`F4-${run}`);

      // A foreign categoryId simply matches nothing (tenant-scoped query).
      const emptyRes = await call(
        'get',
        `/products?categoryId=no-such-category`,
        headers,
      );
      expect(emptyRes.status).toBe(200);
      expect((emptyRes.body as ListBody).data).toHaveLength(0);
    });
  });

  describe('tenant isolation and IDOR', () => {
    it('hides tenant B products from tenant A members on all operations', async () => {
      const createdRes = await call('post', '/products', adminB, {
        name: `Secret B ${run}`,
        code: `SECRET-${run}`,
      });
      expect(createdRes.status).toBe(201);
      const foreign = createdRes.body as ProductBody;
      const foreignId = foreign.id;

      const listedRes = await call('get', '/products', adminA);
      expect(listedRes.status).toBe(200);
      const listed = listedRes.body as ListBody;
      expect(listed.data.some((row) => row.id === foreignId)).toBe(false);

      expect((await call('get', `/products/${foreignId}`, adminA)).status).toBe(
        404,
      );
      expect(
        (
          await call('patch', `/products/${foreignId}`, adminA, {
            name: 'Hijack',
          })
        ).status,
      ).toBe(404);
      expect(
        (await call('delete', `/products/${foreignId}`, adminA)).status,
      ).toBe(404);
      expect(
        (await call('get', `/products/${foreignId}`, employeeA)).status,
      ).toBe(404);
    });

    it('scopes the list to the X-Tenant-ID tenant', async () => {
      const inA = await call('post', '/products', adminA, {
        name: `Only A ${run}`,
        code: `ONLY-A-${run}`,
      });
      expect(inA.status).toBe(201);
      const inB = await call('post', '/products', adminB, {
        name: `Only B ${run}`,
        code: `ONLY-B-${run}`,
      });
      expect(inB.status).toBe(201);

      const listedRes = await call('get', '/products', adminB);
      expect(listedRes.status).toBe(200);
      const listed = listedRes.body as ListBody;
      const codes = listed.data.map((row) => row.code);
      expect(codes).toContain(`ONLY-B-${run}`);
      expect(codes).not.toContain(`ONLY-A-${run}`);
      expect(listed.data.every((row) => row.tenantId === tenantBId)).toBe(true);
    });
  });

  describe('RBAC matrix', () => {
    it('grants manage-only roles writes but never reads', async () => {
      expect((await call('get', '/products', manageOnlyA)).status).toBe(403);
      const createdRes = await call('post', '/products', manageOnlyA, {
        name: `Manage Only ${run}`,
        code: `MO-${run}`,
      });
      expect(createdRes.status).toBe(201);
      const created = createdRes.body as ProductBody;
      expect(created.tenantId).toBe(tenantAId);
      expect(
        (await call('delete', `/products/${created.id}`, manageOnlyA)).status,
      ).toBe(204);
    });

    it('makes employee strictly read-only', async () => {
      const seededRes = await call('post', '/products', adminA, {
        name: `Readable ${run}`,
        code: `READ-${run}`,
      });
      expect(seededRes.status).toBe(201);
      const seeded = seededRes.body as ProductBody;

      expect((await call('get', '/products', employeeA)).status).toBe(200);
      expect(
        (await call('get', `/products/${seeded.id}`, employeeA)).status,
      ).toBe(200);

      expect(
        (
          await call('post', '/products', employeeA, {
            name: 'Nope',
            code: 'NOPE',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call('patch', `/products/${seeded.id}`, employeeA, {
            name: 'Nope',
          })
        ).status,
      ).toBe(403);
      expect(
        (await call('delete', `/products/${seeded.id}`, employeeA)).status,
      ).toBe(403);
    });

    it('gives the owner semantic-all access without explicit grants', async () => {
      const createdRes = await call('post', '/products', ownerA, {
        name: `Owner Prod ${run}`,
        code: `OWN-${run}`,
      });
      expect(createdRes.status).toBe(201);
      const created = createdRes.body as ProductBody;

      expect(
        (await call('get', `/products/${created.id}`, ownerA)).status,
      ).toBe(200);

      const patchedRes = await call(
        'patch',
        `/products/${created.id}`,
        ownerA,
        { description: 'owner touched' },
      );
      expect(patchedRes.status).toBe(200);
      const patched = patchedRes.body as ProductBody;
      expect(patched.description).toBe('owner touched');

      expect(
        (await call('delete', `/products/${created.id}`, ownerA)).status,
      ).toBe(204);
    });
  });

  describe('validation contract', () => {
    it('rejects invalid create payloads with 400', async () => {
      const invalidPayloads: Array<Record<string, unknown>> = [
        {},
        { name: 'No code' },
        { code: 'NO-NAME' },
        { name: '', code: 'EMPTY-NAME' },
        { name: 42, code: 'NUM-NAME' },
        { name: 'Bad status', code: 'BAD-ST', status: 'PUBLISHED' },
        { name: 'Ok', code: 'OK-1', bogus: true },
      ];
      for (const payload of invalidPayloads) {
        const res = await call('post', '/products', adminA, payload);
        expect(res.status).toBe(400);
      }
    });

    it('rejects client-supplied tenantId on create (injection attempt)', async () => {
      const res = await call('post', '/products', adminA, {
        name: `Injected ${run}`,
        code: `INJ-${run}`,
        tenantId: tenantBId,
      });
      expect(res.status).toBe(400);
    });

    it('rejects client-supplied tenantId/id on patch', async () => {
      const seededRes = await call('post', '/products', adminA, {
        name: `Patch Guard ${run}`,
        code: `PG-${run}`,
      });
      expect(seededRes.status).toBe(201);
      const seeded = seededRes.body as ProductBody;
      expect(
        (
          await call('patch', `/products/${seeded.id}`, adminA, {
            tenantId: tenantBId,
          })
        ).status,
      ).toBe(400);
      expect(
        (await call('patch', `/products/${seeded.id}`, adminA, { id: 'new' }))
          .status,
      ).toBe(400);
    });

    it('rejects unknown query fields on list', async () => {
      const res = await call('get', '/products?code=ESP-1', adminA);
      expect(res.status).toBe(400);
    });

    it('rejects malformed cursors with 400', async () => {
      const res = await call(
        'get',
        '/products?cursor=!!!not-base64!!!',
        adminA,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('pagination envelope', () => {
    it('returns the shared { data, meta: { nextCursor } } keyset contract', async () => {
      // Dedicated tenant so the page math below is exact.
      const pagTenant = await createTenant(`pag-${seq}`);
      const pagRole = await grantRole(pagTenant.id, `pag-admin-${run}`, [
        PERMISSIONS.PRODUCT_READ,
        PERMISSIONS.PRODUCT_CREATE,
        PERMISSIONS.PRODUCT_MANAGE,
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
      for (const [index, name] of names.entries()) {
        const res = await call('post', '/products', pagHeaders, {
          name,
          code: `P${index + 1}-${run}`,
        });
        expect(res.status).toBe(201);
      }

      const page1Res = await call(
        'get',
        '/products?limit=2&order=asc',
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
        `/products?limit=2&order=asc&cursor=${encodeURIComponent(cursor1)}`,
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
        `/products?limit=2&order=asc&cursor=${encodeURIComponent(cursor2)}`,
        pagHeaders,
      );
      expect(page3Res.status).toBe(200);
      const page3 = page3Res.body as ListBody;
      expect(page3.data.map((row) => row.name)).toEqual([`P5 ${run}`]);
      expect(page3.meta.nextCursor).toBeNull();

      const descRes = await call(
        'get',
        '/products?limit=2&order=desc',
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
