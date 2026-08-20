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

describe('Membership administration (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  interface ErrorBody {
    message?: string | string[];
    statusCode?: number;
  }

  interface MemberBody {
    membershipId: string;
    userId: string;
    email?: string;
    role?: { key: string };
    status?: string;
  }

  const run = `member-${Date.now()}-${randomUUID().slice(0, 6)}`;
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

  const findMembership = (userId: string, tenantId: string) =>
    tenantContext.run(tenantId, async () =>
      prisma.membership.findFirst({ where: { userId, tenantId } }),
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
    tenantAId = await createTenant('Member Tenant A');
    tenantBId = await createTenant('Member Tenant B');

    const ownerRoleA = await createRole(tenantAId, 'owner', 'Owner', true);
    const adminRoleA = await createRole(tenantAId, 'admin', 'Admin', true);
    const employeeRoleA = await createRole(
      tenantAId,
      'employee',
      'Employee',
      true,
    );
    await createRole(tenantBId, 'owner', 'Owner', true);
    adminRoleAId = adminRoleA.id;
    employeeRoleAId = employeeRoleA.id;

    await grant(adminRoleAId, PERMISSIONS.MEMBER_READ);
    await grant(adminRoleAId, PERMISSIONS.MEMBER_MANAGE);
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
    method: 'put',
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

  describe('listing members', () => {
    it('lets an admin list tenant members', async () => {
      const response = await get('/members', await tokenFor(adminA), tenantAId);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      const body = response.body as MemberBody[];
      expect(body.map((m) => m.email)).toContain(`admin-a-${run}@example.com`);
      expect(body.map((m) => m.email)).toContain(
        `employee-a-${run}@example.com`,
      );
    });

    it('lets the owner list members', async () => {
      const response = await get('/members', await tokenFor(ownerA), tenantAId);

      expect(response.status).toBe(200);
    });

    it('denies a member without member:read with 403', async () => {
      const response = await get(
        '/members',
        await tokenFor(employeeA),
        tenantAId,
      );

      expect(response.status).toBe(403);
      expect((response.body as ErrorBody).message).toBe(
        'Insufficient permissions',
      );
    });

    it('requires an X-Tenant-ID header (400)', async () => {
      const response = await get('/members', await tokenFor(adminA), '');

      expect(response.status).toBe(400);
    });

    it('denies a user with no membership in the tenant (403)', async () => {
      const response = await get(
        '/members',
        await tokenFor(outsider),
        tenantAId,
      );

      expect(response.status).toBe(403);
    });

    it('requires authentication (401)', async () => {
      const response = await get('/members', '', tenantAId);

      expect(response.status).toBe(401);
    });
  });

  describe('getting a member', () => {
    it('returns a member by user id for an admin', async () => {
      const response = await get(
        `/members/${employeeA}`,
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(200);
      const body = response.body as MemberBody;
      expect(body.userId).toBe(employeeA);
      expect(body.membershipId).toBeTruthy();
      expect(body.role?.key).toBe('employee');
    });

    it('returns 404 for a user not in the tenant', async () => {
      const userB = await createUser(`user-b-${run}@example.com`);

      const response = await get(
        `/members/${userB}`,
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(404);
    });

    it('requires member:read (403)', async () => {
      const response = await get(
        `/members/${employeeA}`,
        await tokenFor(employeeA),
        tenantAId,
      );

      expect(response.status).toBe(403);
    });
  });

  describe('updating membership status', () => {
    let employeeMembership: { id: string };
    let adminMembership: { id: string };

    beforeAll(async () => {
      employeeMembership = (await findMembership(employeeA, tenantAId))!;
      adminMembership = (await findMembership(adminA, tenantAId))!;
      membershipIdsToDelete.push(employeeMembership.id);
    });

    it('suspends and reactivates a member as an admin', async () => {
      const suspend = await send(
        'put',
        `/members/${employeeMembership.id}/status`,
        await tokenFor(adminA),
        tenantAId,
        { status: 'SUSPENDED' },
      );

      expect(suspend.status).toBe(200);
      expect((suspend.body as MemberBody).status).toBe('SUSPENDED');

      const reactivate = await send(
        'put',
        `/members/${employeeMembership.id}/status`,
        await tokenFor(adminA),
        tenantAId,
        { status: 'ACTIVE' },
      );

      expect(reactivate.status).toBe(200);
      expect((reactivate.body as MemberBody).status).toBe('ACTIVE');
    });

    it('denies a member without member:manage with 403', async () => {
      const response = await send(
        'put',
        `/members/${employeeMembership.id}/status`,
        await tokenFor(employeeA),
        tenantAId,
        { status: 'SUSPENDED' },
      );

      expect(response.status).toBe(403);
    });

    it('rejects changing your own membership status with 403', async () => {
      const response = await send(
        'put',
        `/members/${adminMembership.id}/status`,
        await tokenFor(adminA),
        tenantAId,
        { status: 'SUSPENDED' },
      );

      expect(response.status).toBe(403);
      expect((response.body as ErrorBody).message).toBe(
        'Cannot change your own membership status',
      );
    });

    it('rejects a membership from another tenant with 404', async () => {
      const employeeB = await createUser(`employee-b-${run}@example.com`);
      const employeeRoleB = await createRole(
        tenantBId,
        'employee',
        'Employee',
        true,
      );
      roleIdsToDelete.push(employeeRoleB.id);
      const employeeMembershipB = await createMembership(
        employeeB,
        tenantBId,
        employeeRoleB.id,
      );

      const response = await send(
        'put',
        `/members/${employeeMembershipB.id}/status`,
        await tokenFor(adminA),
        tenantAId,
        { status: 'SUSPENDED' },
      );

      expect(response.status).toBe(404);
      expect((response.body as ErrorBody).message).toBe('Membership not found');
    });

    it('rejects an invalid status with 400', async () => {
      const response = await send(
        'put',
        `/members/${employeeMembership.id}/status`,
        await tokenFor(adminA),
        tenantAId,
        { status: 'PURGED' },
      );

      expect(response.status).toBe(400);
    });

    it('lets an admin suspend an owner when another active owner remains', async () => {
      // Fresh tenant with two owners plus an admin holding member:manage.
      const tenantDId = await createTenant('Member Tenant D');
      const ownerD1 = await createUser(`owner-d1-${run}@example.com`);
      const ownerD2 = await createUser(`owner-d2-${run}@example.com`);
      const adminD = await createUser(`admin-d-${run}@example.com`);

      const ownerRoleD = await createRole(tenantDId, 'owner', 'Owner', true);
      const adminRoleD = await createRole(tenantDId, 'admin', 'Admin', true);
      await grant(adminRoleD.id, PERMISSIONS.MEMBER_MANAGE);

      const ownerMembershipD1 = await createMembership(
        ownerD1,
        tenantDId,
        ownerRoleD.id,
      );
      await createMembership(ownerD2, tenantDId, ownerRoleD.id);
      await createMembership(adminD, tenantDId, adminRoleD.id);

      const response = await send(
        'put',
        `/members/${ownerMembershipD1.id}/status`,
        await tokenFor(adminD),
        tenantDId,
        { status: 'SUSPENDED' },
      );

      expect(response.status).toBe(200);
      expect((response.body as MemberBody).status).toBe('SUSPENDED');
    });

    it('rejects suspending the last active owner with 409', async () => {
      // Fresh tenant where the owner is the ONLY owner; an admin holding
      // member:manage attempts the suspension.
      const tenantCId = await createTenant('Member Tenant C');
      const ownerC = await createUser(`owner-c-${run}@example.com`);
      const adminC = await createUser(`admin-c-${run}@example.com`);

      const ownerRoleC = await createRole(tenantCId, 'owner', 'Owner', true);
      const adminRoleC = await createRole(tenantCId, 'admin', 'Admin', true);
      await grant(adminRoleC.id, PERMISSIONS.MEMBER_MANAGE);

      const ownerMembershipC = await createMembership(
        ownerC,
        tenantCId,
        ownerRoleC.id,
      );
      await createMembership(adminC, tenantCId, adminRoleC.id);
      membershipIdsToDelete.push(ownerMembershipC.id);

      const response = await send(
        'put',
        `/members/${ownerMembershipC.id}/status`,
        await tokenFor(adminC),
        tenantCId,
        { status: 'SUSPENDED' },
      );

      expect(response.status).toBe(409);
      expect((response.body as ErrorBody).message).toBe(
        'Cannot suspend the last active owner of the tenant',
      );
    });

    it('keeps at least one active owner under concurrent suspensions', async () => {
      // Two owners in the same tenant plus an admin holding member:manage.
      // Both owners are suspended concurrently by the admin; the shared
      // FOR UPDATE row lock must serialize the suspensions so exactly one
      // succeeds and the tenant keeps at least one active owner.
      const tenantEId = await createTenant('Member Tenant E');
      const ownerE1 = await createUser(`owner-e1-${run}@example.com`);
      const ownerE2 = await createUser(`owner-e2-${run}@example.com`);
      const adminE = await createUser(`admin-e-${run}@example.com`);

      const ownerRoleE = await createRole(tenantEId, 'owner', 'Owner', true);
      const adminRoleE = await createRole(tenantEId, 'admin', 'Admin', true);
      await grant(adminRoleE.id, PERMISSIONS.MEMBER_MANAGE);

      const ownerMembershipE1 = await createMembership(
        ownerE1,
        tenantEId,
        ownerRoleE.id,
      );
      const ownerMembershipE2 = await createMembership(
        ownerE2,
        tenantEId,
        ownerRoleE.id,
      );
      await createMembership(adminE, tenantEId, adminRoleE.id);
      membershipIdsToDelete.push(ownerMembershipE1.id, ownerMembershipE2.id);

      const token = await tokenFor(adminE);
      const [first, second] = await Promise.all([
        send(
          'put',
          `/members/${ownerMembershipE1.id}/status`,
          token,
          tenantEId,
          { status: 'SUSPENDED' },
        ),
        send(
          'put',
          `/members/${ownerMembershipE2.id}/status`,
          token,
          tenantEId,
          { status: 'SUSPENDED' },
        ),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 409]);

      const activeOwners = await tenantContext.run(tenantEId, async () =>
        prisma.membership.count({
          where: {
            status: 'ACTIVE',
            role: { key: 'owner' },
          },
        }),
      );
      expect(activeOwners).toBeGreaterThanOrEqual(1);
    });
  });
});
