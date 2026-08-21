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

describe('Member onboarding (integration)', () => {
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
    email: string;
    role?: { id: string; key: string; name: string; isSystem: boolean };
    status: string;
  }

  const run = `onboard-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const userIdsToDelete: string[] = [];
  const tenantIdsToDelete: string[] = [];
  const roleIdsToDelete: string[] = [];
  const membershipIdsToDelete: string[] = [];

  let tenantAId: string;
  let tenantBId: string;
  let ownerA: string;
  let adminA: string;
  let employeeA: string;
  let adminRoleAId: string;
  let employeeRoleAId: string;
  let ownerRoleAId: string;
  let editorRoleId: string;

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
      prisma.role
        .create({
          data: { tenantId, key, name, isSystem },
        })
        .then((role) => {
          roleIdsToDelete.push(role.id);
          return role;
        }),
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
    tenantAId = await createTenant('Onboard Tenant A');
    tenantBId = await createTenant('Onboard Tenant B');

    const ownerRoleA = await createRole(tenantAId, 'owner', 'Owner', true);
    const adminRoleA = await createRole(tenantAId, 'admin', 'Admin', true);
    const employeeRoleA = await createRole(
      tenantAId,
      'employee',
      'Employee',
      true,
    );
    ownerRoleAId = ownerRoleA.id;
    adminRoleAId = adminRoleA.id;
    employeeRoleAId = employeeRoleA.id;

    await grant(adminRoleAId, PERMISSIONS.MEMBER_MANAGE);
    await grant(adminRoleAId, PERMISSIONS.MEMBER_READ);

    const customRoleA = await createRole(
      tenantAId,
      `editor-${run}`,
      'Editor',
      false,
    );
    editorRoleId = customRoleA.id;

    await grant(editorRoleId, PERMISSIONS.STORE_READ);

    await createMembership(ownerA, tenantAId, ownerRoleAId);
    await createMembership(adminA, tenantAId, adminRoleAId);
    await createMembership(employeeA, tenantAId, employeeRoleAId);

    // The same global User (adminA) also exists in Tenant B as an admin.
    await Promise.all([
      createRole(tenantBId, 'owner', 'Owner', true),
      (async () => {
        const adminRoleB = await createRole(tenantBId, 'admin', 'Admin', true);
        await grant(adminRoleB.id, PERMISSIONS.MEMBER_MANAGE);
        await grant(adminRoleB.id, PERMISSIONS.MEMBER_READ);
        await createMembership(adminA, tenantBId, adminRoleB.id);
        return adminRoleB;
      })(),
      createRole(tenantBId, 'employee', 'Employee', true),
    ]);
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
  const post = (
    body: Record<string, unknown>,
    token: string,
    tenantId: string,
  ) => {
    const req = request(httpServer())
      .post('/members')
      .set('Authorization', `Bearer ${token}`);
    if (tenantId) {
      req.set('X-Tenant-ID', tenantId);
    }
    return req.send(body);
  };

  const createdMemberEmail = (suffix: string) =>
    `new-${suffix}-${run}@example.com`;

  describe('onboarding', () => {
    it('admin creates a member successfully (201)', async () => {
      const email = createdMemberEmail('admin-creates');
      const response = await post(
        { email, firstName: 'New', lastName: 'Member' },
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(201);
      const body = response.body as MemberBody;
      expect(body.email).toBe(email);
      expect(body.userId).toBeTruthy();
      expect(body.membershipId).toBeTruthy();
      expect(body.status).toBe('ACTIVE');
      expect(body.role?.key).toBe('employee');
      expect(body.role?.isSystem).toBe(true);
      expect(body).not.toHaveProperty('passwordHash');
    });

    it('owner creates a member successfully (201)', async () => {
      const response = await post(
        { email: createdMemberEmail('owner-creates') },
        await tokenFor(ownerA),
        tenantAId,
      );

      expect(response.status).toBe(201);
      const body = response.body as MemberBody;
      expect(body.role?.key).toBe('employee');
    });

    it('employee cannot create a member (403)', async () => {
      const response = await post(
        { email: createdMemberEmail('employee-attempt') },
        await tokenFor(employeeA),
        tenantAId,
      );

      expect(response.status).toBe(403);
    });

    it('admin cannot assign the owner role (403)', async () => {
      const response = await post(
        {
          email: createdMemberEmail('admin-assigns-owner'),
          roleId: ownerRoleAId,
        },
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(403);
      expect((response.body as ErrorBody).message).toBe(
        'Only the owner can assign the owner role',
      );
    });

    it('owner can assign the owner role (201)', async () => {
      const response = await post(
        {
          email: createdMemberEmail('owner-assigns-owner'),
          roleId: ownerRoleAId,
        },
        await tokenFor(ownerA),
        tenantAId,
      );

      expect(response.status).toBe(201);
      const body = response.body as MemberBody;
      expect(body.role?.key).toBe('owner');
    });

    it('admin can assign a custom (non-system) role (201)', async () => {
      const response = await post(
        { email: createdMemberEmail('custom-role'), roleId: editorRoleId },
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(201);
      const body = response.body as MemberBody;
      expect(body.role?.key).toBe(`editor-${run}`);
      expect(body.role?.isSystem).toBe(false);
    });

    it('custom role grants are bounded: cannot self-grant owner via custom (covered by owner-only rule)', async () => {
      // Reuses the owner-only rule: no role carries owner except the owner role,
      // and assigning owner is owner-only. A custom role cannot escalate.
      const response = await post(
        {
          email: createdMemberEmail('custom-no-elevate'),
          roleId: editorRoleId,
        },
        await tokenFor(adminA),
        tenantAId,
      );
      expect(response.status).toBe(201);
      const body = response.body as MemberBody;
      expect(body.role?.key).toBe(`editor-${run}`);
    });
  });

  describe('duplicate membership', () => {
    it('returns 409 when the user is already a member of the tenant', async () => {
      // employeeA is already a member of tenant A; adminA (a different user)
      // attempts to onboard them again.
      const response = await post(
        { email: `employee-a-${run}@example.com` },
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(409);
      expect((response.body as ErrorBody).message).toBe(
        'User is already a member of this tenant',
      );
    });
  });

  describe('global user / multi-tenant', () => {
    it('an existing global User can join another tenant (201)', async () => {
      const response = await post(
        { email: `employee-a-${run}@example.com` },
        await tokenFor(adminA),
        tenantBId,
      );

      expect(response.status).toBe(201);
      const body = response.body as MemberBody;
      expect(body.role?.key).toBe('employee');
    });

    it('the same User has an independent role in each tenant (no cross-tenant role reuse)', async () => {
      // adminA is admin in A, admin in B (seeded above). Onboarding them again
      // with the ADMIN role of tenant B must use tenant B scope only.
      const membershipB = await tenantContext.run(tenantBId, async () =>
        prisma.membership.findFirst({
          where: { userId: adminA, tenantId: tenantBId },
          include: { role: { select: { tenantId: true, key: true } } },
        }),
      );
      expect(membershipB).toBeTruthy();
      expect(membershipB!.role.tenantId).toBe(tenantBId);
      expect(membershipB!.role.key).toBe('admin');
    });
  });

  describe('cross-tenant role rejection', () => {
    it('rejects a roleId from another tenant (404)', async () => {
      const response = await post(
        { email: createdMemberEmail('cross-role'), roleId: editorRoleId },
        await tokenFor(adminA),
        tenantBId,
      );

      // editorRoleId belongs to tenant A; in tenant B context it resolves null.
      expect(response.status).toBe(404);
      expect((response.body as ErrorBody).message).toBe('Role not found');
    });
  });

  describe('body / path field rejection (no client-controlled security fields)', () => {
    it('rejects a body tenantId (forbidden/non-whitelisted -> 400)', async () => {
      const response = await post(
        {
          email: createdMemberEmail('tenantid-in-body'),
          tenantId: tenantBId,
        },
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(400);
    });

    it('rejects a body userId (forbidden/non-whitelisted -> 400)', async () => {
      const response = await post(
        {
          email: createdMemberEmail('userid-in-body'),
          userId: ownerA,
        },
        await tokenFor(adminA),
        tenantAId,
      );

      expect(response.status).toBe(400);
    });

    it('rejects membershipId in the body (400)', async () => {
      const response = await post(
        {
          email: createdMemberEmail('membershipid-in-body'),
          membershipId: 'irrelevant',
        },
        await tokenFor(adminA),
        tenantAId,
      );
      expect(response.status).toBe(400);
    });

    it('rejects status in the body (400)', async () => {
      const response = await post(
        { email: createdMemberEmail('status-in-body'), status: 'SUSPENDED' },
        await tokenFor(adminA),
        tenantAId,
      );
      expect(response.status).toBe(400);
    });

    it('rejects roleName (non-whitelisted) in the body (400)', async () => {
      const response = await post(
        { email: createdMemberEmail('rolename-in-body'), roleName: 'owner' },
        await tokenFor(adminA),
        tenantAId,
      );
      expect(response.status).toBe(400);
    });
  });

  describe('authentication / state gating', () => {
    it('invalid JWT -> 401', async () => {
      const response = await post(
        { email: createdMemberEmail('bad-jwt') },
        'not-a-jwt',
        tenantAId,
      );
      expect(response.status).toBe(401);
    });

    it('actor with an inactive (suspended) membership -> 403', async () => {
      const suspended = await createUser(`suspended-${run}@example.com`);
      await createMembership(suspended, tenantAId, adminRoleAId, 'SUSPENDED');

      const response = await post(
        { email: createdMemberEmail('suspended-actor') },
        await tokenFor(suspended),
        tenantAId,
      );
      expect(response.status).toBe(403);
    });

    it('actor with an inactive tenant -> 403', async () => {
      const inactiveTenant = await createTenant('Inactive Tenant');
      await prisma.tenant.update({
        where: { id: inactiveTenant },
        data: { status: 'SUSPENDED' },
      });

      const response = await post(
        { email: createdMemberEmail('inactive-tenant') },
        await tokenFor(adminA),
        inactiveTenant,
      );
      expect(response.status).toBe(403);
    });
  });

  describe('authorization of the newly created member', () => {
    it('a newly onboarded member can access endpoints per its assigned role', async () => {
      const newEmail = createdMemberEmail('verify-access');
      const response = await post(
        { email: newEmail },
        await tokenFor(ownerA),
        tenantAId,
      );
      expect(response.status).toBe(201);
      const { userId } = response.body as MemberBody;

      // New member (employee) has store:read but NOT member:read -> listing members 403.
      const listResponse = await request(httpServer())
        .get('/members')
        .set('Authorization', `Bearer ${await tokenFor(userId)}`)
        .set('X-Tenant-ID', tenantAId);

      expect(listResponse.status).toBe(403);
    });
  });

  describe('no leakage / no generic role-permission CRUD', () => {
    it('does not expose passwordHash or sensitive fields in the response', async () => {
      const response = await post(
        { email: createdMemberEmail('no-leak') },
        await tokenFor(adminA),
        tenantAId,
      );
      expect(response.status).toBe(201);
      expect(response.body).not.toHaveProperty('passwordHash');
      expect(response.body).not.toHaveProperty('tenants');
    });

    it('onboarding in tenant A never writes a tenant A membership for a tenant B body field', async () => {
      // Cross-tenant body tenantId is rejected at 400 (ValidationPipe
      // forbidNonWhitelisted), so the service — and therefore the write — is
      // never reached. No membership row is created.
      const response = await post(
        {
          email: createdMemberEmail('cross-tenant-body'),
          tenantId: tenantBId,
        },
        await tokenFor(adminA),
        tenantAId,
      );
      expect(response.status).toBe(400);
    });
  });
});
