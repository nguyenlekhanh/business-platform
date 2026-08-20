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
  SYSTEM_ROLE_KEYS,
} from './permission-catalog';

describe('RBAC (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  interface ErrorBody {
    message?: string | string[];
    statusCode?: number;
  }

  interface RoleBody {
    id: string;
    key: string;
    name: string;
    permissionCount?: number;
    permissions?: Array<{ id: string; key: string; name: string }>;
  }

  interface RoleListBody {
    id: string;
    key: string;
  }

  const run = `rbac-${Date.now()}-${randomUUID().slice(0, 6)}`;
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
  let adminRoleAId: string;
  let employeeRoleAId: string;
  let employeeRoleBId: string;

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

  const permissionId = (key: string) =>
    prisma.permission
      .findUnique({ where: { key } })
      .then((permission) => permission!.id);

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
    tenantAId = await createTenant('Rbac Tenant A');
    tenantBId = await createTenant('Rbac Tenant B');

    const ownerRoleA = await createRole(tenantAId, 'owner', 'Owner', true);
    const adminRoleA = await createRole(tenantAId, 'admin', 'Admin', true);
    const employeeRoleA = await createRole(
      tenantAId,
      'employee',
      'Employee',
      true,
    );
    await createRole(tenantBId, 'owner', 'Owner', true);
    const employeeRoleB = await createRole(
      tenantBId,
      'employee',
      'Employee',
      true,
    );
    adminRoleAId = adminRoleA.id;
    employeeRoleAId = employeeRoleA.id;
    employeeRoleBId = employeeRoleB.id;

    await grant(adminRoleAId, PERMISSIONS.ROLE_READ);
    await grant(adminRoleAId, PERMISSIONS.ROLE_MANAGE);
    await grant(adminRoleAId, PERMISSIONS.STORE_MANAGE);
    await grant(adminRoleAId, PERMISSIONS.REPORT_READ);
    await grant(employeeRoleAId, PERMISSIONS.STORE_READ);

    await createMembership(ownerA, tenantAId, ownerRoleA.id);
    await createMembership(adminA, tenantAId, adminRoleAId);
    await createMembership(employeeA, tenantAId, employeeRoleAId);
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

  describe('permission enforcement', () => {
    it('allows a member whose role grants store:read', async () => {
      const response = await get(
        '/rbac/_test/store-read',
        await tokenFor(employeeA),
        tenantAId,
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ granted: true });
    });

    it('denies a member without store:read with 403', async () => {
      const response = await get(
        '/rbac/_test/store-read',
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(403);
      expect((response.body as ErrorBody).message).toBe(
        'Insufficient permissions',
      );
    });

    it('owner passes any permission check', async () => {
      const response = await get(
        '/rbac/_test/store-read',
        await tokenFor(ownerA),
        tenantAId,
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ granted: true, isOwner: true });
    });

    it('requires an X-Tenant-ID header (400)', async () => {
      const response = await get(
        '/rbac/_test/store-read',
        await tokenFor(employeeA),
        '',
      );

      expect(response.status).toBe(400);
    });

    it('denies a user with no membership in the tenant (403)', async () => {
      const response = await get(
        '/rbac/_test/store-read',
        await tokenFor(outsider),
        tenantAId,
      );

      expect(response.status).toBe(403);
    });

    it('denies a member of another tenant (403)', async () => {
      const response = await get(
        '/rbac/_test/store-read',
        await tokenFor(employeeA),
        tenantBId,
      );

      expect(response.status).toBe(403);
    });

    it('requires authentication (401)', async () => {
      const response = await get('/rbac/_test/store-read', '', tenantAId);

      expect(response.status).toBe(401);
    });

    it('passes when ANY permission is held', async () => {
      const response = await get(
        '/rbac/_test/any-report-settings',
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ granted: true });
    });

    it('denies when no permission in the ANY set is held', async () => {
      const response = await get(
        '/rbac/_test/any-report-settings',
        await tokenFor(employeeA),
        tenantAId,
      );

      expect(response.status).toBe(403);
    });
  });

  describe('role management', () => {
    const customRoleKey = `custom-${run}`;
    let customRoleId: string;
    let employeeMembershipA: { id: string };

    beforeAll(async () => {
      employeeMembershipA = (await tenantContext.run(tenantAId, async () =>
        prisma.membership.findFirst({ where: { userId: employeeA } }),
      ))!;
      membershipIdsToDelete.push(employeeMembershipA.id);
    });

    it('lets an admin create a custom role', async () => {
      const response = await send(
        'post',
        '/rbac/roles',
        await tokenFor(adminA),
        tenantAId,
        {
          key: customRoleKey,
          name: 'Custom Role',
          permissionIds: [await permissionId(PERMISSIONS.REPORT_READ)],
        },
      );

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        key: customRoleKey,
        name: 'Custom Role',
      });
      customRoleId = (response.body as RoleBody).id;
      roleIdsToDelete.push(customRoleId);
    });

    it('rejects a duplicate role key with 409', async () => {
      const response = await send(
        'post',
        '/rbac/roles',
        await tokenFor(adminA),
        tenantAId,
        {
          key: customRoleKey,
          name: 'Custom Role',
          permissionIds: [await permissionId(PERMISSIONS.REPORT_READ)],
        },
      );

      expect(response.status).toBe(409);
      expect((response.body as ErrorBody).message).toBe(
        'Role key already exists in this tenant',
      );
    });

    it('rejects creating a role with an unknown permission id (400)', async () => {
      const response = await send(
        'post',
        '/rbac/roles',
        await tokenFor(adminA),
        tenantAId,
        { key: `${customRoleKey}-2`, name: 'X', permissionIds: ['nope'] },
      );

      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).message).toBe(
        'Unknown permission id',
      );
    });

    it('rejects an admin granting a permission they do not hold on create (403)', async () => {
      const response = await send(
        'post',
        '/rbac/roles',
        await tokenFor(adminA),
        tenantAId,
        {
          key: `${customRoleKey}-unheld`,
          name: 'Unheld',
          permissionIds: [await permissionId(PERMISSIONS.STORE_CREATE)],
        },
      );

      expect(response.status).toBe(403);
      expect((response.body as ErrorBody).message).toBe(
        'Cannot grant permissions you do not hold',
      );
    });

    it('lets the owner create a role with any permission (owner semantic-all)', async () => {
      const response = await send(
        'post',
        '/rbac/roles',
        await tokenFor(ownerA),
        tenantAId,
        {
          key: `${customRoleKey}-owner-any`,
          name: 'Owner Any',
          permissionIds: [await permissionId(PERMISSIONS.STORE_DELETE)],
        },
      );

      expect(response.status).toBe(201);
      roleIdsToDelete.push((response.body as RoleBody).id);
    });

    it.each(['owner', 'admin', 'employee'])(
      'rejects reserved system role key %s (400)',
      async (key) => {
        const response = await send(
          'post',
          '/rbac/roles',
          await tokenFor(adminA),
          tenantAId,
          {
            key,
            name: 'Reserved',
            permissionIds: [await permissionId(PERMISSIONS.REPORT_READ)],
          },
        );

        expect(response.status).toBe(400);
        expect(Array.isArray((response.body as ErrorBody).message)).toBe(true);
        expect(
          ((response.body as ErrorBody).message as string[]).some((m) =>
            /reserved/i.test(m),
          ),
        ).toBe(true);
      },
    );

    it('rejects a permission list over the max size (400)', async () => {
      const many = Array.from({ length: 51 }, (_, i) => `p${i}`);
      const response = await send(
        'post',
        '/rbac/roles',
        await tokenFor(adminA),
        tenantAId,
        {
          key: `${customRoleKey}-big`,
          name: 'Big',
          permissionIds: many,
        },
      );

      expect(response.status).toBe(400);
    });

    it('rejects an over-long permission id (400)', async () => {
      const response = await send(
        'post',
        '/rbac/roles',
        await tokenFor(adminA),
        tenantAId,
        {
          key: `${customRoleKey}-long`,
          name: 'Long',
          permissionIds: ['x'.repeat(41)],
        },
      );

      expect(response.status).toBe(400);
    });

    it('rejects role management from a member without role:manage (403)', async () => {
      const response = await send(
        'post',
        '/rbac/roles',
        await tokenFor(employeeA),
        tenantAId,
        { key: `${customRoleKey}-nope`, name: 'X', permissionIds: [] },
      );

      expect(response.status).toBe(403);
    });

    it('lists roles in the tenant for an admin', async () => {
      const response = await get(
        '/rbac/roles',
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(
        (response.body as RoleListBody[]).some((r) => r.key === customRoleKey),
      ).toBe(true);
    });

    it('returns the custom role with its permissions', async () => {
      const response = await get(
        `/rbac/roles/${customRoleId}`,
        await tokenFor(adminA),
        tenantAId,
      );

      const body = response.body as RoleBody;
      expect(response.status).toBe(200);
      expect(body.key).toBe(customRoleKey);
      expect(body.permissions?.map((p) => p.key)).toContain(
        PERMISSIONS.REPORT_READ,
      );
    });

    it('returns 404 for a role from another tenant', async () => {
      const otherTenantRole = await tenantContext.run(tenantBId, async () =>
        prisma.role.findFirst({ where: { tenantId: tenantBId } }),
      );

      const response = await get(
        `/rbac/roles/${otherTenantRole!.id}`,
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(404);
    });

    it('rejects updating a system role with 403', async () => {
      const response = await send(
        'put',
        `/rbac/roles/${adminRoleAId}`,
        await tokenFor(adminA),
        tenantAId,
        { name: 'Hacked Admin' },
      );

      expect(response.status).toBe(403);
      expect((response.body as ErrorBody).message).toBe(
        'System roles are immutable',
      );
    });

    it('rejects deleting a system role with 403', async () => {
      const response = await send(
        'delete',
        `/rbac/roles/${employeeRoleAId}`,
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(403);
    });

    it('lets the owner assign permissions to a custom role', async () => {
      const response = await send(
        'put',
        `/rbac/roles/${customRoleId}/permissions`,
        await tokenFor(ownerA),
        tenantAId,
        { permissionIds: [await permissionId(PERMISSIONS.REPORT_READ)] },
      );

      expect(response.status).toBe(200);
      expect((response.body as RoleBody).permissionCount).toBe(1);
    });

    it('rejects an admin assigning a permission they do not hold (403)', async () => {
      const response = await send(
        'put',
        `/rbac/roles/${customRoleId}/permissions`,
        await tokenFor(adminA),
        tenantAId,
        { permissionIds: [await permissionId(PERMISSIONS.STORE_DELETE)] },
      );

      expect(response.status).toBe(403);
      expect((response.body as ErrorBody).message).toBe(
        'Cannot grant permissions you do not hold',
      );
    });

    it('lets the owner delete the custom role', async () => {
      const response = await send(
        'delete',
        `/rbac/roles/${customRoleId}`,
        await tokenFor(ownerA),
        tenantAId,
      );

      expect(response.status).toBe(204);
    });

    it('rejects assigning a role from another tenant to a membership (404)', async () => {
      const response = await send(
        'put',
        `/rbac/roles/memberships/${employeeMembershipA.id}/role`,
        await tokenFor(ownerA),
        tenantAId,
        { roleId: employeeRoleBId },
      );

      expect(response.status).toBe(404);
    });

    it('rejects a member changing their own role (403)', async () => {
      const response = await send(
        'put',
        `/rbac/roles/memberships/${employeeMembershipA.id}/role`,
        await tokenFor(ownerA),
        tenantAId,
        { roleId: adminRoleAId },
      );

      // ownerA reassigning employeeA is allowed; this test asserts the
      // self-role-change guard fires when the ACTOR is the membership owner.
      expect(response.status).toBe(200);

      const selfResponse = await send(
        'put',
        `/rbac/roles/memberships/${employeeMembershipA.id}/role`,
        await tokenFor(employeeA),
        tenantAId,
        { roleId: adminRoleAId },
      );

      // employeeA lacks role:manage, so this is a plain permission denial.
      expect(selfResponse.status).toBe(403);
    });

    it('rejects assigning the owner role by a non-owner (403)', async () => {
      const ownerRoleA = await tenantContext.run(tenantAId, async () =>
        prisma.role.findFirst({ where: { tenantId: tenantAId, key: 'owner' } }),
      );

      const response = await send(
        'put',
        `/rbac/roles/memberships/${employeeMembershipA.id}/role`,
        await tokenFor(adminA),
        tenantAId,
        { roleId: ownerRoleA!.id },
      );

      expect(response.status).toBe(403);
    });

    it('rejects demoting the last owner (409)', async () => {
      // Fresh tenant where the owner is the ONLY owner. A second admin user
      // (with role:manage) attempts to demote the owner.
      const tenantCId = await createTenant('Rbac Tenant C');
      const ownerC = await createUser(`owner-c-${run}@example.com`);
      const adminC = await createUser(`admin-c-${run}@example.com`);

      const ownerRoleC = await createRole(tenantCId, 'owner', 'Owner', true);
      const adminRoleC = await createRole(tenantCId, 'admin', 'Admin', true);
      await grant(adminRoleC.id, PERMISSIONS.ROLE_MANAGE);

      await createMembership(ownerC, tenantCId, ownerRoleC.id);
      await createMembership(adminC, tenantCId, adminRoleC.id);
      const ownerMembershipC = (await tenantContext.run(tenantCId, async () =>
        prisma.membership.findFirst({ where: { userId: ownerC } }),
      ))!;

      const response = await send(
        'put',
        `/rbac/roles/memberships/${ownerMembershipC.id}/role`,
        await tokenFor(adminC),
        tenantCId,
        { roleId: adminRoleC.id },
      );

      expect(response.status).toBe(409);
      expect((response.body as ErrorBody).message).toBe(
        'Cannot demote the last owner of the tenant',
      );
    });

    it('keeps at least one active owner under concurrent demotions', async () => {
      // Two owners in the same tenant plus an admin with role:manage. Both
      // owners are demoted concurrently; the FOR UPDATE row lock must
      // serialize the demotions so exactly one succeeds and the tenant keeps
      // at least one active owner (never zero).
      const tenantDId = await createTenant('Rbac Tenant D');
      const ownerD1 = await createUser(`owner-d1-${run}@example.com`);
      const ownerD2 = await createUser(`owner-d2-${run}@example.com`);
      const adminD = await createUser(`admin-d-${run}@example.com`);

      const ownerRoleD = await createRole(tenantDId, 'owner', 'Owner', true);
      const adminRoleD = await createRole(tenantDId, 'admin', 'Admin', true);
      await grant(adminRoleD.id, PERMISSIONS.ROLE_MANAGE);

      await createMembership(ownerD1, tenantDId, ownerRoleD.id);
      await createMembership(ownerD2, tenantDId, ownerRoleD.id);
      await createMembership(adminD, tenantDId, adminRoleD.id);

      const ownerMembershipD1 = (await tenantContext.run(tenantDId, async () =>
        prisma.membership.findFirst({ where: { userId: ownerD1 } }),
      ))!;
      const ownerMembershipD2 = (await tenantContext.run(tenantDId, async () =>
        prisma.membership.findFirst({ where: { userId: ownerD2 } }),
      ))!;

      const token = await tokenFor(adminD);
      const [first, second] = await Promise.all([
        send(
          'put',
          `/rbac/roles/memberships/${ownerMembershipD1.id}/role`,
          token,
          tenantDId,
          { roleId: adminRoleD.id },
        ),
        send(
          'put',
          `/rbac/roles/memberships/${ownerMembershipD2.id}/role`,
          token,
          tenantDId,
          { roleId: adminRoleD.id },
        ),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 409]);

      const activeOwners = await tenantContext.run(tenantDId, async () =>
        prisma.membership.count({
          where: {
            status: 'ACTIVE',
            role: { key: SYSTEM_ROLE_KEYS.OWNER },
          },
        }),
      );
      expect(activeOwners).toBeGreaterThanOrEqual(1);
    });
  });
});
