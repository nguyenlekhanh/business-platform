import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { AppModule } from '../app.module';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  PERMISSION_DEFINITIONS,
  PERMISSIONS,
} from '../rbac/permission-catalog';

describe('Store administration (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  interface ErrorBody {
    message?: string | string[];
    statusCode?: number;
  }

  interface StoreBody {
    id: string;
    tenantId: string;
    name: string;
    code: string;
    type?: string;
    status?: string;
    settings?: unknown;
    createdAt?: string;
  }

  interface PaginatedBody {
    data: StoreBody[];
    meta: { nextCursor: string | null };
  }

  const run = `store-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const userIdsToDelete: string[] = [];
  const tenantIdsToDelete: string[] = [];
  const roleIdsToDelete: string[] = [];
  const membershipIdsToDelete: string[] = [];

  let tenantAId: string;
  let tenantBId: string;
  let adminA: string;
  let ownerA: string;
  let employeeA: string;
  let managerA: string;
  let adminB: string;
  let outsider: string;

  const createUser = async (email: string) => {
    const user = await prisma.user.create({ data: { email } });
    userIdsToDelete.push(user.id);
    return user.id;
  };

  const createTenant = async (name: string) => {
    const tenant = await prisma.tenant.create({
      data: { name, slug: `${run}-${name}-${randomUUID().slice(0, 6)}` },
    });
    tenantIdsToDelete.push(tenant.id);
    return tenant.id;
  };

  const createRole = (
    tenantId: string,
    key: string,
    name: string,
    isSystem = false,
  ) =>
    tenantContext.run(tenantId, async () =>
      prisma.role.create({ data: { tenantId, key, name, isSystem } }),
    );

  const grant = (roleId: string, key: string) =>
    prisma.permission.findUnique({ where: { key } }).then((permission) =>
      prisma.rolePermission.create({
        data: { roleId, permissionId: permission!.id },
      }),
    );

  const createMembership = (userId: string, tenantId: string, roleId: string) =>
    tenantContext.run(tenantId, async () =>
      prisma.membership.create({ data: { userId, tenantId, roleId } }),
    );

  const createStoreDirect = (
    tenantId: string,
    name: string,
    code: string,
    type: string,
    status?: string,
  ) =>
    tenantContext.run(tenantId, async () =>
      prisma.store.create({
        data: status
          ? { tenantId, name, code, type, status }
          : { tenantId, name, code, type },
      }),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwtService = moduleRef.get(JwtService);
    tenantContext = moduleRef.get(TenantContextService);
  });

  beforeAll(async () => {
    // Seed the global permission catalog (idempotent across runs, race-safe
    // against other integration suites seeding the same catalog concurrently).
    // Permission rows are platform catalog data and are intentionally NOT
    // deleted in afterAll: they are shared across suites and runs.
    for (const definition of PERMISSION_DEFINITIONS) {
      let permission = await prisma.permission.findUnique({
        where: { key: definition.key },
      });
      if (!permission) {
        permission = await prisma.permission
          .create({
            data: {
              key: definition.key,
              name: definition.name,
              category: definition.category,
              description: definition.description,
            },
          })
          .catch((error: unknown) => {
            if (
              error instanceof Prisma.PrismaClientKnownRequestError &&
              error.code === 'P2002'
            ) {
              return prisma.permission.findUnique({
                where: { key: definition.key },
              });
            }
            throw error;
          });
      }
    }

    adminA = await createUser(`admin-a-${run}@example.com`);
    ownerA = await createUser(`owner-a-${run}@example.com`);
    employeeA = await createUser(`employee-a-${run}@example.com`);
    managerA = await createUser(`manager-a-${run}@example.com`);
    adminB = await createUser(`admin-b-${run}@example.com`);
    outsider = await createUser(`outsider-${run}@example.com`);
    tenantAId = await createTenant('Store Tenant A');
    tenantBId = await createTenant('Store Tenant B');

    const adminRoleA = await createRole(tenantAId, 'admin', 'Admin', true);
    const ownerRoleA = await createRole(tenantAId, 'owner', 'Owner', true);
    const employeeRoleA = await createRole(
      tenantAId,
      'employee',
      'Employee',
      true,
    );
    const managerRoleA = await createRole(tenantAId, 'manager', 'Manager');
    const adminRoleB = await createRole(tenantBId, 'admin', 'Admin', true);

    await grant(adminRoleA.id, PERMISSIONS.STORE_READ);
    await grant(adminRoleA.id, PERMISSIONS.STORE_CREATE);
    await grant(adminRoleA.id, PERMISSIONS.STORE_UPDATE);
    await grant(adminRoleA.id, PERMISSIONS.STORE_DELETE);
    await grant(employeeRoleA.id, PERMISSIONS.STORE_READ);
    await grant(managerRoleA.id, PERMISSIONS.STORE_MANAGE);
    await grant(adminRoleB.id, PERMISSIONS.STORE_READ);
    await grant(adminRoleB.id, PERMISSIONS.STORE_CREATE);
    await grant(adminRoleB.id, PERMISSIONS.STORE_UPDATE);
    await grant(adminRoleB.id, PERMISSIONS.STORE_DELETE);

    await createMembership(adminA, tenantAId, adminRoleA.id);
    await createMembership(ownerA, tenantAId, ownerRoleA.id);
    await createMembership(employeeA, tenantAId, employeeRoleA.id);
    await createMembership(managerA, tenantAId, managerRoleA.id);
    await createMembership(adminB, tenantBId, adminRoleB.id);
  });

  afterAll(async () => {
    if (prisma) {
      // Tenant-scoped cleanups run outside a TenantContext and therefore fail
      // closed (swallowed); actual deletion happens via tenant cascade below.
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

  const httpServer = () => app.getHttpServer() as unknown as Server;
  const tokenFor = (userId: string) => jwtService.signAsync({ sub: userId });
  const get = (path: string, token: string, tenantId: string) => {
    const req = request(httpServer()).get(path);
    if (token) {
      req.set('Authorization', `Bearer ${token}`);
    }
    if (tenantId) {
      req.set('X-Tenant-ID', tenantId);
    }
    return req;
  };
  const send = (
    method: 'post' | 'put' | 'delete',
    path: string,
    token: string,
    tenantId: string,
    body?: Record<string, unknown>,
  ) => {
    const req = request(httpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-ID', tenantId);
    if (body) {
      req.send(body);
    }
    return req;
  };

  const createStoreApi = (
    token: string,
    tenantId: string,
    body: Record<string, unknown>,
    path = '/stores',
  ) => send('post', path, token, tenantId, body);

  describe('listing stores', () => {
    it('lets an admin list stores (200)', async () => {
      await createStoreDirect(tenantAId, 'Listed Store', `${run}-list`, 'SHOP');

      const response = await get('/stores', await tokenFor(adminA), tenantAId);

      expect(response.status).toBe(200);
      const body = (response.body as PaginatedBody).data;
      expect(body.some((s) => s.code === `${run}-list`)).toBe(true);
      expect(body.every((s) => s.tenantId === tenantAId)).toBe(true);
    });

    it('returns only the current tenant stores', async () => {
      await createStoreDirect(
        tenantBId,
        'Tenant B Store',
        `${run}-only-b`,
        'SHOP',
      );

      const bodyA = (
        (await get('/stores', await tokenFor(adminA), tenantAId))
          .body as PaginatedBody
      ).data;
      const bodyB = (
        (await get('/stores', await tokenFor(adminB), tenantBId))
          .body as PaginatedBody
      ).data;

      expect(bodyA.every((s) => s.tenantId === tenantAId)).toBe(true);
      expect(bodyA.some((s) => s.code === `${run}-only-b`)).toBe(false);
      expect(bodyB.some((s) => s.code === `${run}-only-b`)).toBe(true);
    });

    it('denies a member without store:read (403)', async () => {
      const response = await get(
        '/stores',
        await tokenFor(managerA),
        tenantAId,
      );

      expect(response.status).toBe(403);
      expect((response.body as ErrorBody).message).toBe(
        'Insufficient permissions',
      );
    });

    it('requires an X-Tenant-ID header (400)', async () => {
      const response = await get('/stores', await tokenFor(adminA), '');

      expect(response.status).toBe(400);
    });

    it('denies a user with no membership in the tenant (403)', async () => {
      const response = await get(
        '/stores',
        await tokenFor(outsider),
        tenantAId,
      );

      expect(response.status).toBe(403);
    });

    it('requires authentication (401)', async () => {
      const response = await get('/stores', '', tenantAId);

      expect(response.status).toBe(401);
    });

    it('rejects a tenantId query parameter with 400 (Phase 2J whitelist; header wins)', async () => {
      // Phase 2J behavior change (approved): unknown query fields are now
      // rejected by forbidNonWhitelisted. A client cannot inject tenantId via
      // query at all; isolation continues to be enforced server-side.
      const response = await get(
        `/stores?tenantId=${tenantBId}`,
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(400);
    });
  });

  describe('pagination & filters (Phase 2J)', () => {
    const listQuery = async (
      query: Record<string, string>,
      tenantId = tenantAId,
      userId = adminA,
    ) => {
      const qs = new URLSearchParams(query).toString();
      const res = await get(
        qs ? `/stores?${qs}` : '/stores',
        await tokenFor(userId),
        tenantId,
      );
      return { res, body: res.body as PaginatedBody };
    };

    it('walks pages deterministically with limit 2', async () => {
      const created: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const id = (
          await createStoreDirect(
            tenantAId,
            `Paged Store ${i}`,
            `${run}-paged-${i}`,
            'CAFE',
          )
        ).id;
        created.push(id);
      }

      const collected: string[] = [];
      let cursor: string | null | undefined;
      do {
        const q: Record<string, string> = { type: 'CAFE', limit: '2' };
        if (cursor) {
          q.cursor = cursor;
        }
        const { body } = await listQuery(q);
        for (const row of body.data) {
          expect(row.type).toBe('CAFE');
        }
        collected.push(...body.data.map((s) => s.id));
        cursor = body.meta.nextCursor;
      } while (cursor);
      for (const id of created) {
        expect(collected.filter((x) => x === id)).toHaveLength(1);
      }
    });

    it('filters by status and combines status+type', async () => {
      await createStoreDirect(
        tenantAId,
        'Inactive Paged Store',
        `${run}-paged-inactive`,
        'SHOP',
        'INACTIVE',
      );
      const { body } = await listQuery({
        status: 'INACTIVE',
        type: 'SHOP',
      });
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const row of body.data) {
        expect(row.status).toBe('INACTIVE');
        expect(row.type).toBe('SHOP');
      }
    });

    it('rejects invalid cursors and bad limits with 400', async () => {
      expect((await listQuery({ cursor: '!!!' })).res.status).toBe(400);
      expect((await listQuery({ limit: '101' })).res.status).toBe(400);
      expect((await listQuery({ bogus: '1' })).res.status).toBe(400);
    });

    it('keeps tenant isolation across pages', async () => {
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const q: Record<string, string> = { limit: '1' };
        if (cursor) {
          q.cursor = cursor;
        }
        const { body } = await listQuery(q, tenantBId, adminB);
        for (const row of body.data) {
          expect(row.tenantId).toBe(tenantBId);
        }
        cursor = body.meta.nextCursor;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(20);
      } while (cursor);
    });
  });

  describe('owner semantic-all access', () => {
    // The owner role carries semantic "all permissions"; an owner must be able
    // to perform every store operation without explicit per-action grants.
    let ownerStoreId: string;

    it('lets the owner list stores (200)', async () => {
      const response = await get('/stores', await tokenFor(ownerA), tenantAId);

      expect(response.status).toBe(200);
      expect(Array.isArray((response.body as PaginatedBody).data)).toBe(true);
    });

    it('lets the owner create a store (201)', async () => {
      const response = await createStoreApi(await tokenFor(ownerA), tenantAId, {
        name: 'Owner Store',
        code: `${run}-owner`,
        type: 'SHOP',
      });

      expect(response.status).toBe(201);
      ownerStoreId = (response.body as StoreBody).id;
      expect((response.body as StoreBody).tenantId).toBe(tenantAId);
    });

    it('lets the owner update the store (200)', async () => {
      const response = await send(
        'put',
        `/stores/${ownerStoreId}`,
        await tokenFor(ownerA),
        tenantAId,
        { name: 'Owner Updated' },
      );

      expect(response.status).toBe(200);
      expect((response.body as StoreBody).name).toBe('Owner Updated');
    });

    it('lets the owner delete the store (204)', async () => {
      const response = await send(
        'delete',
        `/stores/${ownerStoreId}`,
        await tokenFor(ownerA),
        tenantAId,
      );

      expect(response.status).toBe(204);
    });
  });

  describe('getting a store', () => {
    let storeAId: string;

    beforeAll(async () => {
      const created = await createStoreApi(await tokenFor(adminA), tenantAId, {
        name: 'Get Store A',
        code: `${run}-get-a`,
        type: 'SHOP',
      });
      storeAId = (created.body as StoreBody).id;
    });

    it('returns an own-tenant store (200)', async () => {
      const response = await get(
        `/stores/${storeAId}`,
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(200);
      const body = response.body as StoreBody;
      expect(body.id).toBe(storeAId);
      expect(body.tenantId).toBe(tenantAId);
      expect(body.name).toBe('Get Store A');
      expect(body.code).toBe(`${run}-get-a`);
      expect(body.type).toBe('SHOP');
      expect(body.status).toBe('ACTIVE');
      expect(body.createdAt).toBeTruthy();
      expect(body.updatedAt).toBeTruthy();
    });

    it('returns 404 for a cross-tenant store id', async () => {
      const storeB = await createStoreDirect(
        tenantBId,
        'Cross Tenant B',
        `${run}-cross-b`,
        'SHOP',
      );

      const response = await get(
        `/stores/${storeB.id}`,
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(404);
    });

    it('returns 404 for an unknown store id', async () => {
      const response = await get(
        `/stores/unknown-store-id`,
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(404);
    });

    it('denies a member without store:read (403)', async () => {
      const response = await get(
        `/stores/${storeAId}`,
        await tokenFor(managerA),
        tenantAId,
      );

      expect(response.status).toBe(403);
    });
  });

  describe('creating stores', () => {
    it('creates a store (201)', async () => {
      const response = await createStoreApi(await tokenFor(adminA), tenantAId, {
        name: 'Created Store',
        code: `${run}-created`,
        type: 'SHOP',
      });

      expect(response.status).toBe(201);
      const body = response.body as StoreBody;
      expect(body.tenantId).toBe(tenantAId);
      expect(body.name).toBe('Created Store');
      expect(body.code).toBe(`${run}-created`);
      expect(body.type).toBe('SHOP');
      expect(body.status).toBe('ACTIVE');
    });

    it('creates a store with optional status and settings (201)', async () => {
      const response = await createStoreApi(await tokenFor(adminA), tenantAId, {
        name: 'Configured Store',
        code: `${run}-configured`,
        type: 'CAFE',
        status: 'INACTIVE',
        settings: { theme: 'dark' },
      });

      expect(response.status).toBe(201);
      const body = response.body as StoreBody;
      expect(body.status).toBe('INACTIVE');
      expect(body.settings).toEqual({ theme: 'dark' });
    });

    it('rejects a duplicate code in the same tenant (409)', async () => {
      const code = `${run}-dup`;
      await createStoreApi(await tokenFor(adminA), tenantAId, {
        name: 'First',
        code,
        type: 'SHOP',
      });

      const response = await createStoreApi(await tokenFor(adminA), tenantAId, {
        name: 'Second',
        code,
        type: 'SHOP',
      });

      expect(response.status).toBe(409);
      expect((response.body as ErrorBody).message).toBe(
        'A store with this code already exists in the tenant',
      );
    });

    it('allows the same code in different tenants', async () => {
      const code = `${run}-shared`;
      const responseA = await createStoreApi(
        await tokenFor(adminA),
        tenantAId,
        { name: 'Shared A', code, type: 'SHOP' },
      );
      const responseB = await createStoreApi(
        await tokenFor(adminB),
        tenantBId,
        { name: 'Shared B', code, type: 'SHOP' },
      );

      expect(responseA.status).toBe(201);
      expect(responseB.status).toBe(201);
      expect((responseA.body as StoreBody).tenantId).toBe(tenantAId);
      expect((responseB.body as StoreBody).tenantId).toBe(tenantBId);
    });

    it('denies a member without store:create/store:manage (403)', async () => {
      const response = await createStoreApi(
        await tokenFor(employeeA),
        tenantAId,
        { name: 'Nope', code: `${run}-nope`, type: 'SHOP' },
      );

      expect(response.status).toBe(403);
    });

    it('rejects a body tenantId (400)', async () => {
      const response = await createStoreApi(await tokenFor(adminA), tenantAId, {
        name: 'Hacked',
        code: `${run}-hacked`,
        type: 'SHOP',
        tenantId: tenantBId,
      });

      expect(response.status).toBe(400);
    });

    it('rejects unknown DTO fields (400)', async () => {
      const response = await createStoreApi(await tokenFor(adminA), tenantAId, {
        name: 'X',
        code: `${run}-unknown`,
        type: 'SHOP',
        rentalRates: 1,
      });

      expect(response.status).toBe(400);
    });

    it('rejects an invalid type (400)', async () => {
      const response = await createStoreApi(await tokenFor(adminA), tenantAId, {
        name: 'X',
        code: `${run}-badtype`,
        type: 'WAREHOUSE',
      });

      expect(response.status).toBe(400);
    });

    it('creates the store in the header tenant, ignoring a query tenantId', async () => {
      const response = await createStoreApi(
        await tokenFor(adminA),
        tenantAId,
        { name: 'Header Wins', code: `${run}-header`, type: 'SHOP' },
        `/stores?tenantId=${tenantBId}`,
      );

      expect(response.status).toBe(201);
      expect((response.body as StoreBody).tenantId).toBe(tenantAId);
    });
  });

  describe('updating stores', () => {
    let storeAId: string;

    beforeAll(async () => {
      const created = await createStoreApi(await tokenFor(adminA), tenantAId, {
        name: 'Update Store A',
        code: `${run}-update-a`,
        type: 'SHOP',
      });
      storeAId = (created.body as StoreBody).id;
    });

    it('updates a store (200)', async () => {
      const response = await send(
        'put',
        `/stores/${storeAId}`,
        await tokenFor(adminA),
        tenantAId,
        { name: 'Updated Name', type: 'CAFE', status: 'INACTIVE' },
      );

      expect(response.status).toBe(200);
      const body = response.body as StoreBody;
      expect(body.name).toBe('Updated Name');
      expect(body.type).toBe('CAFE');
      expect(body.status).toBe('INACTIVE');
    });

    it('returns 404 for a cross-tenant store id', async () => {
      const storeB = await createStoreDirect(
        tenantBId,
        'Update Cross B',
        `${run}-update-cross-b`,
        'SHOP',
      );

      const response = await send(
        'put',
        `/stores/${storeB.id}`,
        await tokenFor(adminA),
        tenantAId,
        { name: 'Hacked' },
      );

      expect(response.status).toBe(404);
    });

    it('returns 404 for an unknown store id', async () => {
      const response = await send(
        'put',
        `/stores/unknown-store-id`,
        await tokenFor(adminA),
        tenantAId,
        { name: 'X' },
      );

      expect(response.status).toBe(404);
    });

    it('denies a member without store:update/store:manage (403)', async () => {
      const response = await send(
        'put',
        `/stores/${storeAId}`,
        await tokenFor(employeeA),
        tenantAId,
        { name: 'Nope' },
      );

      expect(response.status).toBe(403);
    });

    it('rejects a body tenantId (400)', async () => {
      const response = await send(
        'put',
        `/stores/${storeAId}`,
        await tokenFor(adminA),
        tenantAId,
        { tenantId: tenantBId, name: 'Hacked' },
      );

      expect(response.status).toBe(400);
    });

    it('rejects a duplicate code on update (409)', async () => {
      const other = await createStoreApi(await tokenFor(adminA), tenantAId, {
        name: 'Other',
        code: `${run}-other-code`,
        type: 'SHOP',
      });
      const otherId = (other.body as StoreBody).id;

      const response = await send(
        'put',
        `/stores/${otherId}`,
        await tokenFor(adminA),
        tenantAId,
        { code: `${run}-update-a` },
      );

      expect(response.status).toBe(409);
    });
  });

  describe('deleting stores', () => {
    it('deletes a store (204)', async () => {
      const created = await createStoreApi(await tokenFor(adminA), tenantAId, {
        name: 'Delete Me',
        code: `${run}-delete`,
        type: 'SHOP',
      });
      const storeId = (created.body as StoreBody).id;

      const response = await send(
        'delete',
        `/stores/${storeId}`,
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(204);

      const after = await get(
        `/stores/${storeId}`,
        await tokenFor(adminA),
        tenantAId,
      );
      expect(after.status).toBe(404);
    });

    it('returns 404 for a cross-tenant store id', async () => {
      const storeB = await createStoreDirect(
        tenantBId,
        'Delete Cross B',
        `${run}-delete-cross-b`,
        'SHOP',
      );

      const response = await send(
        'delete',
        `/stores/${storeB.id}`,
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(404);
    });

    it('returns 404 for an unknown store id', async () => {
      const response = await send(
        'delete',
        `/stores/unknown-store-id`,
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(404);
    });

    it('denies a member without store:delete/store:manage (403)', async () => {
      const created = await createStoreApi(await tokenFor(adminA), tenantAId, {
        name: 'Keep Me',
        code: `${run}-keep`,
        type: 'SHOP',
      });
      const storeId = (created.body as StoreBody).id;

      const response = await send(
        'delete',
        `/stores/${storeId}`,
        await tokenFor(employeeA),
        tenantAId,
      );

      expect(response.status).toBe(403);
    });
  });

  describe('store:manage grants CRUD (create/update/delete)', () => {
    it('lets a store:manage holder create, update and delete', async () => {
      const created = await createStoreApi(
        await tokenFor(managerA),
        tenantAId,
        { name: 'Manager Store', code: `${run}-manager`, type: 'SHOP' },
      );
      expect(created.status).toBe(201);
      const storeId = (created.body as StoreBody).id;

      const updated = await send(
        'put',
        `/stores/${storeId}`,
        await tokenFor(managerA),
        tenantAId,
        { name: 'Manager Updated' },
      );
      expect(updated.status).toBe(200);

      const deleted = await send(
        'delete',
        `/stores/${storeId}`,
        await tokenFor(managerA),
        tenantAId,
      );
      expect(deleted.status).toBe(204);
    });
  });

  describe('security regression / isolation', () => {
    let tenantBStoreId: string;

    beforeAll(async () => {
      const created = await createStoreApi(await tokenFor(adminB), tenantBId, {
        name: 'Tenant B Store',
        code: `${run}-b-sec`,
        type: 'SHOP',
      });
      tenantBStoreId = (created.body as StoreBody).id;
    });

    it('user A + tenant A cannot access tenant B store by id', async () => {
      const response = await get(
        `/stores/${tenantBStoreId}`,
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(404);
    });

    it('user A + tenant A cannot update tenant B store', async () => {
      const response = await send(
        'put',
        `/stores/${tenantBStoreId}`,
        await tokenFor(adminA),
        tenantAId,
        { name: 'Hacked B' },
      );

      expect(response.status).toBe(404);
    });

    it('user A + tenant A cannot delete tenant B store', async () => {
      const response = await send(
        'delete',
        `/stores/${tenantBStoreId}`,
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(404);
    });

    it('user A + tenant A cannot create a store for tenant B (body tenantId rejected)', async () => {
      const response = await createStoreApi(await tokenFor(adminA), tenantAId, {
        name: 'Hacked',
        code: `${run}-for-b`,
        type: 'SHOP',
        tenantId: tenantBId,
      });

      expect(response.status).toBe(400);

      const bodyB = (
        (await get('/stores', await tokenFor(adminB), tenantBId))
          .body as PaginatedBody
      ).data;
      expect(bodyB.some((s) => s.code === `${run}-for-b`)).toBe(false);
    });

    it('denies a suspended membership (403)', async () => {
      const tenantSId = await createTenant('Suspended Membership Tenant');
      const suspUser = await createUser(`susp-${run}@example.com`);
      const ownerRoleS = await createRole(tenantSId, 'owner', 'Owner', true);
      const membership = await createMembership(
        suspUser,
        tenantSId,
        ownerRoleS.id,
      );
      await tenantContext.run(tenantSId, async () =>
        prisma.membership.update({
          where: { id: membership.id },
          data: { status: 'SUSPENDED' },
        }),
      );

      const response = await get(
        '/stores',
        await tokenFor(suspUser),
        tenantSId,
      );

      expect(response.status).toBe(403);
    });

    it('denies a suspended tenant (403)', async () => {
      const tenantTId = await createTenant('Suspended Tenant');
      await prisma.tenant.update({
        where: { id: tenantTId },
        data: { status: 'SUSPENDED' },
      });
      const suspOwner = await createUser(`susp-owner-${run}@example.com`);
      const ownerRoleT = await createRole(tenantTId, 'owner', 'Owner', true);
      await createMembership(suspOwner, tenantTId, ownerRoleT.id);

      const response = await get(
        '/stores',
        await tokenFor(suspOwner),
        tenantTId,
      );

      expect(response.status).toBe(403);
    });

    it('list/get/update/delete cannot reach tenant B data from tenant A', async () => {
      const listResponse = await get(
        '/stores',
        await tokenFor(adminA),
        tenantAId,
      );
      expect(listResponse.status).toBe(200);
      const listBody = (listResponse.body as PaginatedBody).data;
      expect(listBody.some((s) => s.id === tenantBStoreId)).toBe(false);
    });
  });
});
