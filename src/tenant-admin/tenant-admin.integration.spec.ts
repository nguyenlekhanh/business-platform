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

describe('Tenant administration (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  interface ErrorBody {
    message?: string | string[];
    statusCode?: number;
  }

  interface TenantBody {
    id: string;
    name: string;
    slug: string;
    status?: string;
    settings?: unknown;
    createdAt?: string;
    updatedAt?: string;
  }

  const run = `tenant-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const userIdsToDelete: string[] = [];
  const tenantIdsToDelete: string[] = [];
  const roleIdsToDelete: string[] = [];
  const membershipIdsToDelete: string[] = [];

  let tenantAId: string;
  let tenantBId: string;
  let ownerA: string;
  let adminA: string;
  let employeeA: string;
  let outsider: string;
  let adminB: string;
  let tenantBSlug: string;

  const createUser = async (email: string) => {
    const user = await prisma.user.create({ data: { email } });
    userIdsToDelete.push(user.id);
    return user.id;
  };

  const createTenant = async (name: string) => {
    const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const tenant = await prisma.tenant.create({
      data: { name, slug: `${run}-${slugBase}-${randomUUID().slice(0, 6)}` },
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

    ownerA = await createUser(`owner-a-${run}@example.com`);
    adminA = await createUser(`admin-a-${run}@example.com`);
    employeeA = await createUser(`employee-a-${run}@example.com`);
    outsider = await createUser(`outsider-${run}@example.com`);
    adminB = await createUser(`admin-b-${run}@example.com`);
    tenantAId = await createTenant('Tenant Admin A');
    tenantBId = await createTenant('Tenant Admin B');
    const tenantB = await prisma.tenant.findUnique({
      where: { id: tenantBId },
    });
    tenantBSlug = tenantB!.slug;

    const ownerRoleA = await createRole(tenantAId, 'owner', 'Owner', true);
    const adminRoleA = await createRole(tenantAId, 'admin', 'Admin', true);
    const employeeRoleA = await createRole(
      tenantAId,
      'employee',
      'Employee',
      true,
    );
    const ownerRoleB = await createRole(tenantBId, 'owner', 'Owner', true);
    const adminRoleB = await createRole(tenantBId, 'admin', 'Admin', true);

    await grant(adminRoleA.id, PERMISSIONS.SETTINGS_READ);
    await grant(adminRoleA.id, PERMISSIONS.SETTINGS_MANAGE);
    await grant(employeeRoleA.id, PERMISSIONS.STORE_READ);
    await grant(adminRoleB.id, PERMISSIONS.SETTINGS_READ);
    await grant(adminRoleB.id, PERMISSIONS.SETTINGS_MANAGE);

    await createMembership(ownerA, tenantAId, ownerRoleA.id);
    await createMembership(adminA, tenantAId, adminRoleA.id);
    await createMembership(employeeA, tenantAId, employeeRoleA.id);
    await createMembership(ownerA, tenantBId, ownerRoleB.id);
    await createMembership(adminB, tenantBId, adminRoleB.id);
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
  const put = (
    path: string,
    token: string,
    tenantId: string,
    body?: Record<string, unknown>,
  ) => {
    const req = request(httpServer())
      .put(path)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-ID', tenantId);
    if (body) {
      req.send(body);
    }
    return req;
  };

  describe('reading the tenant', () => {
    it('returns the tenant for a member with settings:read (200)', async () => {
      const response = await get('/tenant', await tokenFor(adminA), tenantAId);

      expect(response.status).toBe(200);
      const body = response.body as TenantBody;
      expect(body.id).toBe(tenantAId);
      expect(body.name).toBe('Tenant Admin A');
      expect(body.slug).toBeTruthy();
      expect(body.status).toBe('ACTIVE');
      expect(body.settings).toBeNull();
      expect(body.createdAt).toBeTruthy();
      expect(body.updatedAt).toBeTruthy();
      // Only the safe scalar tenant fields are exposed - no relation data.
      expect(Object.keys(body).sort()).toEqual([
        'createdAt',
        'id',
        'name',
        'settings',
        'slug',
        'status',
        'updatedAt',
      ]);
    });

    it('lets the owner read the tenant (owner semantic-all)', async () => {
      const response = await get('/tenant', await tokenFor(ownerA), tenantAId);

      expect(response.status).toBe(200);
      expect((response.body as TenantBody).id).toBe(tenantAId);
    });

    it('denies a member without settings:read with 403', async () => {
      const response = await get(
        '/tenant',
        await tokenFor(employeeA),
        tenantAId,
      );

      expect(response.status).toBe(403);
      expect((response.body as ErrorBody).message).toBe(
        'Insufficient permissions',
      );
    });

    it('requires an X-Tenant-ID header (400)', async () => {
      const response = await get('/tenant', await tokenFor(adminA), '');

      expect(response.status).toBe(400);
    });

    it('denies a user with no membership in the tenant (403)', async () => {
      const response = await get(
        '/tenant',
        await tokenFor(outsider),
        tenantAId,
      );

      expect(response.status).toBe(403);
    });

    it('requires authentication (401)', async () => {
      const response = await get('/tenant', '', tenantAId);

      expect(response.status).toBe(401);
    });

    it('ignores a tenantId query parameter (header wins)', async () => {
      const response = await get(
        `/tenant?tenantId=${tenantBId}`,
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(200);
      expect((response.body as TenantBody).id).toBe(tenantAId);
    });

    it('denies access for an inactive tenant (403)', async () => {
      const suspendedTenantId = await createTenant('Suspended Tenant');
      await prisma.tenant.update({
        where: { id: suspendedTenantId },
        data: { status: 'SUSPENDED' },
      });
      const ownerRoleS = await createRole(
        suspendedTenantId,
        'owner',
        'Owner',
        true,
      );
      await createMembership(ownerA, suspendedTenantId, ownerRoleS.id);

      const response = await get(
        '/tenant',
        await tokenFor(ownerA),
        suspendedTenantId,
      );

      expect(response.status).toBe(403);
    });
  });

  describe('updating the tenant', () => {
    it('updates name, slug and settings as an admin (200)', async () => {
      const newSlug = `${run}-updated`;
      const response = await put('/tenant', await tokenFor(adminA), tenantAId, {
        name: 'Tenant Admin A Renamed',
        slug: newSlug,
        settings: { theme: 'dark' },
      });

      expect(response.status).toBe(200);
      const body = response.body as TenantBody;
      expect(body.id).toBe(tenantAId);
      expect(body.name).toBe('Tenant Admin A Renamed');
      expect(body.slug).toBe(newSlug);
      expect(body.settings).toEqual({ theme: 'dark' });
      expect(body.status).toBe('ACTIVE');

      const persisted = await prisma.tenant.findUnique({
        where: { id: tenantAId },
      });
      expect(persisted?.name).toBe('Tenant Admin A Renamed');
      expect(persisted?.slug).toBe(newSlug);
    });

    it('rejects a duplicate slug with 409', async () => {
      const response = await put('/tenant', await tokenFor(adminA), tenantAId, {
        slug: tenantBSlug,
      });

      expect(response.status).toBe(409);
      expect((response.body as ErrorBody).message).toBe(
        'Slug is already in use',
      );
    });

    it('denies a member without settings:manage with 403', async () => {
      const response = await put(
        '/tenant',
        await tokenFor(employeeA),
        tenantAId,
        { name: 'Nope' },
      );

      expect(response.status).toBe(403);
      expect((response.body as ErrorBody).message).toBe(
        'Insufficient permissions',
      );
    });

    it('rejects a client-supplied id with 400', async () => {
      const response = await put('/tenant', await tokenFor(adminA), tenantAId, {
        id: 'tenant-9',
        name: 'Hacked',
      });

      expect(response.status).toBe(400);
    });

    it('rejects a client-supplied status with 400', async () => {
      const response = await put('/tenant', await tokenFor(adminA), tenantAId, {
        status: 'DISABLED',
      });

      expect(response.status).toBe(400);
    });

    it('rejects a client-supplied tenantId with 400', async () => {
      const response = await put('/tenant', await tokenFor(adminA), tenantAId, {
        tenantId: tenantBId,
        name: 'Hacked',
      });

      expect(response.status).toBe(400);
    });

    it('rejects an invalid slug format with 400', async () => {
      const response = await put('/tenant', await tokenFor(adminA), tenantAId, {
        slug: 'Bad Slug!',
      });

      expect(response.status).toBe(400);
    });

    it('rejects non-object settings with 400', async () => {
      const response = await put('/tenant', await tokenFor(adminA), tenantAId, {
        settings: 'not-an-object',
      });

      expect(response.status).toBe(400);
    });

    it('lets the owner update the tenant (owner semantic-all)', async () => {
      const response = await put('/tenant', await tokenFor(ownerA), tenantAId, {
        name: 'Tenant Admin A Owner',
      });

      expect(response.status).toBe(200);
      expect((response.body as TenantBody).name).toBe('Tenant Admin A Owner');
    });

    it('denies updating an inactive tenant (403)', async () => {
      const suspendedTenantId = await createTenant('Suspended Tenant 2');
      await prisma.tenant.update({
        where: { id: suspendedTenantId },
        data: { status: 'SUSPENDED' },
      });
      const ownerRoleS = await createRole(
        suspendedTenantId,
        'owner',
        'Owner',
        true,
      );
      await createMembership(ownerA, suspendedTenantId, ownerRoleS.id);

      const response = await put(
        '/tenant',
        await tokenFor(ownerA),
        suspendedTenantId,
        { name: 'Nope' },
      );

      expect(response.status).toBe(403);
    });
  });

  describe('tenant isolation', () => {
    it('rejects a tenant A user against a tenant B header (403)', async () => {
      const response = await get('/tenant', await tokenFor(adminA), tenantBId);

      expect(response.status).toBe(403);
    });

    it('rejects a tenant B user against a tenant A header (403)', async () => {
      const response = await get('/tenant', await tokenFor(adminB), tenantAId);

      expect(response.status).toBe(403);
    });

    it('reads the tenant bound to the header, not another tenant', async () => {
      const responseB = await get('/tenant', await tokenFor(adminB), tenantBId);
      expect(responseB.status).toBe(200);
      expect((responseB.body as TenantBody).id).toBe(tenantBId);

      const responseA = await get('/tenant', await tokenFor(adminA), tenantAId);
      expect(responseA.status).toBe(200);
      expect((responseA.body as TenantBody).id).toBe(tenantAId);
    });

    it('rejects updating another tenant via a body tenantId injection (400)', async () => {
      const response = await put('/tenant', await tokenFor(adminB), tenantBId, {
        tenantId: tenantAId,
        name: 'Hacked A',
      });

      expect(response.status).toBe(400);

      const tenantA = await prisma.tenant.findUnique({
        where: { id: tenantAId },
      });
      expect(tenantA?.name).not.toBe('Hacked A');
    });

    it('applies updates only to the tenant in context', async () => {
      const response = await put('/tenant', await tokenFor(adminB), tenantBId, {
        name: 'Tenant Admin B Renamed',
      });

      expect(response.status).toBe(200);
      expect((response.body as TenantBody).id).toBe(tenantBId);

      const tenantA = await prisma.tenant.findUnique({
        where: { id: tenantAId },
      });
      const tenantB = await prisma.tenant.findUnique({
        where: { id: tenantBId },
      });
      expect(tenantB?.name).toBe('Tenant Admin B Renamed');
      expect(tenantA?.name).not.toBe('Tenant Admin B Renamed');
    });
  });
});
