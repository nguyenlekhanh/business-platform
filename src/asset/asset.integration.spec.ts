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

describe('Asset administration (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  interface ErrorBody {
    message?: string | string[];
    statusCode?: number;
  }

  interface AssetBody {
    id: string;
    tenantId: string;
    name: string;
    code: string;
    type: string;
    status: string;
    storeId: string | null;
  }

  interface PaginatedBody {
    data: AssetBody[];
    meta: { nextCursor: string | null };
  }

  const run = `asset-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const assetIdsToDelete: string[] = [];
  const storeIdsToDelete: string[] = [];
  const userIdsToDelete: string[] = [];
  const tenantIdsToDelete: string[] = [];
  const roleIdsToDelete: string[] = [];
  const membershipIdsToDelete: string[] = [];

  let tenantAId: string;
  let tenantBId: string;
  let ownerA: string;
  let adminA: string;
  let employeeA: string;
  let managerA: string;
  let adminB: string;
  let storeAId: string;
  let storeBId: string;
  let adminRoleAId: string;
  let managerRoleId: string;
  let existingAssetId: string;

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

  const createMembership = (
    userId: string,
    tenantId: string,
    roleId: string,
    status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
  ) =>
    tenantContext.run(tenantId, async () =>
      prisma.membership
        .create({ data: { userId, tenantId, roleId, status } })
        .then((membership) => {
          membershipIdsToDelete.push(membership.id);
          return membership;
        }),
    );

  const createStoreDirect = (tenantId: string, name: string, code: string) =>
    tenantContext.run(tenantId, async () =>
      prisma.store
        .create({
          data: { tenantId, name, code, type: 'GENERAL', settings: {} },
        })
        .then((store) => {
          storeIdsToDelete.push(store.id);
          return store;
        }),
    );

  const createAssetDirect = (
    tenantId: string,
    name: string,
    code: string,
    type: string,
    storeId?: string,
  ) =>
    tenantContext.run(tenantId, async () =>
      prisma.asset
        .create({
          data: {
            tenantId,
            name,
            code,
            type,
            ...(storeId ? { storeId } : {}),
          },
        })
        .then((asset) => {
          assetIdsToDelete.push(asset.id);
          return asset;
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

    ownerA = await createUser(`owner-a-${run}@example.com`);
    adminA = await createUser(`admin-a-${run}@example.com`);
    employeeA = await createUser(`employee-a-${run}@example.com`);
    managerA = await createUser(`manager-a-${run}@example.com`);
    adminB = await createUser(`admin-b-${run}@example.com`);

    tenantAId = await createTenant('Asset Tenant A');
    tenantBId = await createTenant('Asset Tenant B');

    // System roles (owner semantics + admin/employee defaults from catalog).
    const ownerRoleA = await createRole(tenantAId, 'owner', 'Owner', true);
    const adminRoleA = await createRole(tenantAId, 'admin', 'Admin', true);
    const employeeRoleA = await createRole(
      tenantAId,
      'employee',
      'Employee',
      true,
    );
    // Custom role exercising the explicit create/update/delete/manage path.
    const customRoleA = await createRole(tenantAId, `viewer-${run}`, 'Viewer');
    managerRoleId = customRoleA.id;

    await grant(adminRoleA.id, PERMISSIONS.ASSET_READ);
    await grant(adminRoleA.id, PERMISSIONS.ASSET_CREATE);
    await grant(adminRoleA.id, PERMISSIONS.ASSET_UPDATE);
    await grant(adminRoleA.id, PERMISSIONS.ASSET_DELETE);
    await grant(employeeRoleA.id, PERMISSIONS.ASSET_READ);
    await grant(managerRoleId, PERMISSIONS.ASSET_MANAGE);

    adminRoleAId = adminRoleA.id;

    await createMembership(ownerA, tenantAId, ownerRoleA.id);
    await createMembership(adminA, tenantAId, adminRoleA.id);
    await createMembership(employeeA, tenantAId, employeeRoleA.id);
    await createMembership(managerA, tenantAId, managerRoleId);

    storeAId = (
      await createStoreDirect(tenantAId, 'Main Store', `${run}-store-a`)
    ).id;
    storeBId = (await createStoreDirect(tenantBId, 'B Store', `${run}-store-b`))
      .id;

    // A pre-existing asset in tenant A owned by adminA's role for IDOR tests.
    existingAssetId = (
      await createAssetDirect(tenantAId, 'Preexisting', `${run}-pre`, 'crane')
    ).id;
    assetIdsToDelete.push(existingAssetId);

    // Tenant B admin (system admin role has no member:* grants by default in B;
    // grant asset perms explicitly for the asset tests, mirroring tenant A).
    const adminRoleB = await createRole(tenantBId, 'admin', 'Admin', true);
    await grant(adminRoleB.id, PERMISSIONS.ASSET_READ);
    await grant(adminRoleB.id, PERMISSIONS.ASSET_CREATE);
    await grant(adminRoleB.id, PERMISSIONS.ASSET_UPDATE);
    await grant(adminRoleB.id, PERMISSIONS.ASSET_DELETE);
    await createMembership(adminB, tenantBId, adminRoleB.id);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.asset
        .deleteMany({ where: { id: { in: assetIdsToDelete } } })
        .catch(() => undefined);
      await prisma.store
        .deleteMany({ where: { id: { in: storeIdsToDelete } } })
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

  const assetCode = (suffix: string) => `${run}-${suffix}`;

  describe('listing assets', () => {
    it('asset list with asset:read -> 200 envelope', async () => {
      const res = await get('/assets', await tokenFor(employeeA), tenantAId);
      expect(res.status).toBe(200);
      expect(Array.isArray((res.body as PaginatedBody).data)).toBe(true);
      expect(typeof (res.body as PaginatedBody).meta.nextCursor).toBe('object');
    });

    it('insufficient permission -> 403', async () => {
      // Create a user with NO asset permissions in tenant A.
      const readOnly = await createUser(`readonly-${run}@example.com`);
      const readOnlyRole = await createRole(
        tenantAId,
        `readonly-${run}`,
        'ReadOnly',
      );
      await createMembership(readOnly, tenantAId, readOnlyRole.id);

      const res = await get('/assets', await tokenFor(readOnly), tenantAId);
      expect(res.status).toBe(403);
    });

    it('lists only the active tenant assets (cross-tenant list isolation)', async () => {
      const listA = await get('/assets', await tokenFor(adminA), tenantAId);
      expect(listA.status).toBe(200);
      expect(
        (listA.body as PaginatedBody).data.some(
          (a) => a.id === existingAssetId,
        ),
      ).toBe(true);

      const listB = await get('/assets', await tokenFor(adminB), tenantBId);
      expect(listB.status).toBe(200);
      expect(
        (listB.body as PaginatedBody).data.some(
          (a) => a.id === existingAssetId,
        ),
      ).toBe(false);
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
        qs ? `/assets?${qs}` : '/assets',
        await tokenFor(userId),
        tenantId,
      );
      return { res, body: res.body as PaginatedBody };
    };

    it('walks pages deterministically with the id tiebreaker', async () => {
      const created: Array<{ id: string; createdAt: string }> = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await send(
          'post',
          '/assets',
          await tokenFor(adminA),
          tenantAId,
          {
            name: `Paged Asset ${i}`,
            code: assetCode(`paged-${i}`),
            type: 'paged-type',
          },
        );
        expect(res.status).toBe(201);
        created.push({
          id: (res.body as AssetBody).id,
          createdAt: (res.body as { createdAt: string }).createdAt,
        });
        assetIdsToDelete.push(created[i].id);
      }
      const expected = [...created]
        .sort(
          (a, b) =>
            Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
            a.id.localeCompare(b.id),
        )
        .map((a) => a.id);

      const collected: string[] = [];
      let cursor: string | null | undefined;
      do {
        const q: Record<string, string> = { type: 'paged-type', limit: '2' };
        if (cursor) {
          q.cursor = cursor;
        }
        const { body } = await listQuery(q);
        collected.push(...body.data.map((a) => a.id));
        cursor = body.meta.nextCursor;
      } while (cursor);
      expect(collected).toEqual(expected);
    });

    it('filters by status and storeId; foreign ids match nothing', async () => {
      const inactive = await listQuery({ status: 'INACTIVE' });
      for (const row of inactive.body.data) {
        expect(row.status).toBe('INACTIVE');
      }

      const foreignStore = await listQuery({ storeId: 'no-such-store' });
      expect(foreignStore.body.data).toEqual([]);
      expect(foreignStore.body.meta.nextCursor).toBeNull();
    });

    it('rejects invalid cursors and bad limits with 400', async () => {
      const badCursor = await listQuery({ cursor: '!!!garbage!!!' });
      expect(badCursor.res.status).toBe(400);

      const tooBig = await listQuery({ limit: '101' });
      expect(tooBig.res.status).toBe(400);

      const unknownField = await listQuery({ bogus: '1' });
      expect(unknownField.res.status).toBe(400);
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

  describe('single asset', () => {
    it('get asset -> 200', async () => {
      const res = await get(
        `/assets/${existingAssetId}`,
        await tokenFor(adminA),
        tenantAId,
      );
      expect(res.status).toBe(200);
      expect((res.body as AssetBody).id).toBe(existingAssetId);
    });

    it('get missing asset -> 404', async () => {
      const res = await get(
        '/assets/non-existent-asset',
        await tokenFor(adminA),
        tenantAId,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('create asset', () => {
    it('create asset -> 201', async () => {
      const res = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        tenantAId,
        { name: 'New Asset', code: assetCode('new'), type: 'crane' },
      );
      expect(res.status).toBe(201);
      const body = res.body as AssetBody;
      expect(body.id).toBeTruthy();
      expect(body.tenantId).toBe(tenantAId);
      expect(body.name).toBe('New Asset');
      expect(body.code).toBe(assetCode('new'));
      expect(body.type).toBe('crane');
      expect(body.storeId).toBeNull();
      assetIdsToDelete.push(body.id);
    });

    it('owner semantic-all -> CRUD succeeds without explicit asset grants', async () => {
      // ownerA holds no explicit asset:* grants (only owner semantics).
      const res = await send(
        'post',
        '/assets',
        await tokenFor(ownerA),
        tenantAId,
        { name: 'Owner Asset', code: assetCode('owner'), type: 'generator' },
      );
      expect(res.status).toBe(201);
      assetIdsToDelete.push((res.body as AssetBody).id);
    });

    it('admin default grants work', async () => {
      const res = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        tenantAId,
        { name: 'Admin Asset', code: assetCode('admin'), type: 'forklift' },
      );
      expect(res.status).toBe(201);
      assetIdsToDelete.push((res.body as AssetBody).id);
    });

    it('employee behavior: employee can get but not create (403)', async () => {
      const res = await send(
        'post',
        '/assets',
        await tokenFor(employeeA),
        tenantAId,
        { name: 'Emp Asset', code: assetCode('emp'), type: 'crane' },
      );
      expect(res.status).toBe(403);
    });

    it('duplicate tenant+code -> 409', async () => {
      const code = assetCode('dup');
      await send('post', '/assets', await tokenFor(adminA), tenantAId, {
        name: 'Dup',
        code,
        type: 'crane',
      });
      const res = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        tenantAId,
        { name: 'Dup 2', code, type: 'roller' },
      );
      expect(res.status).toBe(409);
    });

    it('tenant-level asset can be created without storeId (201)', async () => {
      const res = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        tenantAId,
        { name: 'No Store', code: assetCode('nostore'), type: 'terminal' },
      );
      expect(res.status).toBe(201);
      expect((res.body as AssetBody).storeId).toBeNull();
      assetIdsToDelete.push((res.body as AssetBody).id);
    });

    it('asset referencing a store in the same tenant (201)', async () => {
      const res = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        tenantAId,
        {
          name: 'Store Asset',
          code: assetCode('stored'),
          type: 'machine',
          storeId: storeAId,
        },
      );
      expect(res.status).toBe(201);
      expect((res.body as AssetBody).storeId).toBe(storeAId);
      assetIdsToDelete.push((res.body as AssetBody).id);
    });

    it('storeId from another tenant -> 404 (rejected at creation)', async () => {
      const res = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        tenantAId,
        {
          name: 'Foreign Store',
          code: assetCode('foreign-store'),
          type: 'crane',
          storeId: storeBId,
        },
      );
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Store not found');
    });

    it('rejects a client-supplied tenantId with 400', async () => {
      const res = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        tenantAId,
        {
          name: 'Inject Tenant',
          code: assetCode('inject-tenant'),
          type: 'crane',
          tenantId: 'tenant-9',
        },
      );
      // forbidNonWhitelisted rejects non-DTO properties before the service;
      // the tenant is always derived from TenantContext.
      expect(res.status).toBe(400);
    });

    it('rejects arbitrary unknown fields (roleId/permissions) with 400', async () => {
      const res = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        tenantAId,
        {
          name: 'Privilege Probe',
          code: assetCode('priv-probe'),
          type: 'crane',
          roleId: 'role-9',
          permissions: ['asset:manage'],
        },
      );
      expect(res.status).toBe(400);
    });

    it('same code remains independently valid in another tenant (201)', async () => {
      // existingAssetId already uses this exact code in tenant A.
      const res = await send(
        'post',
        '/assets',
        await tokenFor(adminB),
        tenantBId,
        { name: 'Twin Code', code: assetCode('pre'), type: 'crane' },
      );
      expect(res.status).toBe(201);
      expect((res.body as AssetBody).tenantId).toBe(tenantBId);
      assetIdsToDelete.push((res.body as AssetBody).id);
    });
  });

  describe('update asset', () => {
    it('update asset -> 200', async () => {
      const res = await send(
        'put',
        `/assets/${existingAssetId}`,
        await tokenFor(adminA),
        tenantAId,
        { name: 'Updated Name' },
      );
      expect(res.status).toBe(200);
      expect((res.body as AssetBody).name).toBe('Updated Name');
    });

    it('asset can be moved between stores within the same tenant (200)', async () => {
      const createRes = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        tenantAId,
        { name: 'Movable', code: assetCode('movable'), type: 'crane' },
      );
      const id = (createRes.body as AssetBody).id;
      assetIdsToDelete.push(id);

      const res = await send(
        'put',
        `/assets/${id}`,
        await tokenFor(adminA),
        tenantAId,
        { storeId: storeAId },
      );
      expect(res.status).toBe(200);
      expect((res.body as AssetBody).storeId).toBe(storeAId);
    });

    it('foreign store cannot be injected during update -> 404', async () => {
      const res = await send(
        'put',
        `/assets/${existingAssetId}`,
        await tokenFor(adminA),
        tenantAId,
        { storeId: storeBId },
      );
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Store not found');
    });

    it('update to a code taken by another asset in the tenant -> 409', async () => {
      const createRes = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        tenantAId,
        {
          name: 'Rename Target',
          code: assetCode('rename-target'),
          type: 'crane',
        },
      );
      const id = (createRes.body as AssetBody).id;
      assetIdsToDelete.push(id);

      // existingAssetId already owns code `${run}-pre` in this tenant.
      const res = await send(
        'put',
        `/assets/${id}`,
        await tokenFor(adminA),
        tenantAId,
        { code: assetCode('pre') },
      );
      expect(res.status).toBe(409);
    });

    it('update does not write tenantId/id into data', async () => {
      const createRes = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        tenantAId,
        { name: 'Inject', code: assetCode('inject'), type: 'crane' },
      );
      const id = (createRes.body as AssetBody).id;
      assetIdsToDelete.push(id);

      const res = await send(
        'put',
        `/assets/${id}`,
        await tokenFor(adminA),
        tenantAId,
        { name: 'Keep Me', tenantId: 'tenant-9', id: 'asset-9' },
      );
      // forbidNonWhitelisted rejects tenantId/id at 400 before service.
      expect(res.status).toBe(400);
    });
  });

  describe('delete asset', () => {
    it('delete asset -> 204', async () => {
      const createRes = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        tenantAId,
        { name: 'To Delete', code: assetCode('del'), type: 'crane' },
      );
      const id = (createRes.body as AssetBody).id;

      const res = await send(
        'delete',
        `/assets/${id}`,
        await tokenFor(adminA),
        tenantAId,
      );
      expect(res.status).toBe(204);

      // Confirm deletion at the DB level (scoped lookup returns null).
      const gone = await tenantContext.run(tenantAId, async () =>
        prisma.asset.findUnique({ where: { id } }),
      );
      expect(gone).toBeNull();
    });
  });

  describe('asset:manage behavior', () => {
    it('manager (asset:manage) can create/update/delete in tenant A', async () => {
      const createRes = await send(
        'post',
        '/assets',
        await tokenFor(managerA),
        tenantAId,
        { name: 'Manager', code: assetCode('mgr'), type: 'crane' },
      );
      expect(createRes.status).toBe(201);
      const id = (createRes.body as AssetBody).id;
      assetIdsToDelete.push(id);

      const upd = await send(
        'put',
        `/assets/${id}`,
        await tokenFor(managerA),
        tenantAId,
        { name: 'Manager 2' },
      );
      expect(upd.status).toBe(200);
    });

    it('asset:manage alone must NOT grant GET -> 403', async () => {
      // GET requires asset:read; asset:manage covers writes only.
      const listRes = await get('/assets', await tokenFor(managerA), tenantAId);
      expect(listRes.status).toBe(403);

      const getRes = await get(
        `/assets/${existingAssetId}`,
        await tokenFor(managerA),
        tenantAId,
      );
      expect(getRes.status).toBe(403);
    });

    it('manager (asset:manage) can delete -> 204', async () => {
      const createRes = await send(
        'post',
        '/assets',
        await tokenFor(managerA),
        tenantAId,
        { name: 'Manager Del', code: assetCode('mgr-del'), type: 'crane' },
      );
      expect(createRes.status).toBe(201);
      const id = (createRes.body as AssetBody).id;

      const res = await send(
        'delete',
        `/assets/${id}`,
        await tokenFor(managerA),
        tenantAId,
      );
      expect(res.status).toBe(204);
    });
  });

  describe('explicit asset:create/update/delete behavior', () => {
    it('a role with only asset:update cannot create (403) but can update', async () => {
      const updateOnly = await createUser(`updonly-${run}@example.com`);
      const updateRole = await createRole(
        tenantAId,
        `updonly-${run}`,
        'UpdateOnly',
      );
      await grant(updateRole.id, PERMISSIONS.ASSET_UPDATE);
      await createMembership(updateOnly, tenantAId, updateRole.id);

      const createRes = await send(
        'post',
        '/assets',
        await tokenFor(updateOnly),
        tenantAId,
        { name: 'X', code: assetCode('updonly-create'), type: 'crane' },
      );
      expect(createRes.status).toBe(403);

      const updRes = await send(
        'put',
        `/assets/${existingAssetId}`,
        await tokenFor(updateOnly),
        tenantAId,
        { name: 'Updated by updater' },
      );
      expect(updRes.status).toBe(200);
      await send(
        'put',
        `/assets/${existingAssetId}`,
        await tokenFor(adminA),
        tenantAId,
        { name: 'Preexisting' },
      );
    });
  });

  describe('IDOR protection (no tenant data leakage)', () => {
    it('cross-tenant asset GET -> 404', async () => {
      const res = await get(
        `/assets/${existingAssetId}`,
        await tokenFor(adminB),
        tenantBId,
      );
      expect(res.status).toBe(404);
    });

    it('cross-tenant asset PUT -> 404', async () => {
      const res = await send(
        'put',
        `/assets/${existingAssetId}`,
        await tokenFor(adminB),
        tenantBId,
        { name: 'Hacked' },
      );
      expect(res.status).toBe(404);
    });

    it('cross-tenant asset DELETE -> 404', async () => {
      const res = await send(
        'delete',
        `/assets/${existingAssetId}`,
        await tokenFor(adminB),
        tenantBId,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('auth / tenant state gating', () => {
    it('invalid JWT -> 401', async () => {
      const res = await send('post', '/assets', 'not-a-jwt', tenantAId, {
        name: 'X',
        code: assetCode('jwt'),
        type: 'crane',
      });
      expect(res.status).toBe(401);
    });

    it('missing tenant header -> 400', async () => {
      const res = await send('post', '/assets', await tokenFor(adminA), '', {
        name: 'X',
        code: assetCode('notenant'),
        type: 'crane',
      });
      expect(res.status).toBe(400);
    });

    it('inactive membership actor -> 403', async () => {
      const suspended = await createUser(`suspended-${run}@example.com`);
      await createMembership(suspended, tenantAId, adminRoleAId, 'SUSPENDED');
      // The role holds every ASSET_* grant; the 403 arises purely from the
      // SUSPENDED membership status - permission.service rejects any
      // non-ACTIVE membership before consulting role permissions.

      const res = await send(
        'post',
        '/assets',
        await tokenFor(suspended),
        tenantAId,
        { name: 'X', code: assetCode('susp'), type: 'crane' },
      );
      expect(res.status).toBe(403);
    });

    it('inactive tenant -> 403', async () => {
      const inactiveTenant = await createTenant('Inactive Asset Tenant');
      await prisma.tenant.update({
        where: { id: inactiveTenant },
        data: { status: 'SUSPENDED' },
      });

      const res = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        inactiveTenant,
        { name: 'X', code: assetCode('inactive'), type: 'crane' },
      );
      expect(res.status).toBe(403);
    });
  });

  describe('no leakage / no generic role-permission CRUD', () => {
    it('does not expose internal Prisma fields in the response', async () => {
      const res = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        tenantAId,
        { name: 'No Leak', code: assetCode('noleak'), type: 'crane' },
      );
      expect(res.status).toBe(201);
      const body = res.body as Record<string, unknown>;
      expect(body).not.toHaveProperty('passwordHash');
      expect(body).not.toHaveProperty('rolePermissions');
      expect(body).not.toHaveProperty('permissions');
      assetIdsToDelete.push((body as AssetBody).id);
    });

    it('returns exactly the safe AssetSummary projection', async () => {
      const res = await send(
        'post',
        '/assets',
        await tokenFor(adminA),
        tenantAId,
        { name: 'Shape', code: assetCode('shape'), type: 'crane' },
      );
      expect(res.status).toBe(201);
      // Exact key set: no Prisma internals, no relation objects, nothing extra.
      expect(Object.keys(res.body as object).sort()).toEqual([
        'code',
        'createdAt',
        'description',
        'id',
        'name',
        'settings',
        'status',
        'storeId',
        'tenantId',
        'type',
        'updatedAt',
      ]);
      assetIdsToDelete.push((res.body as AssetBody).id);
    });
  });
});
