import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { MembershipStatus, TenantStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../app.module';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';

describe('Tenant resolution (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  interface ContextBody {
    tenantId?: string;
    tenantName?: string;
    contextTenantId?: string;
    message?: string;
  }

  const run = `tint-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const userIdsToDelete: string[] = [];
  const tenantIdsToDelete: string[] = [];

  let userAId: string;
  let tenantAId: string;
  let tenantBId: string;
  let tenantInvitedId: string;
  let tenantSuspendedMembershipId: string;
  let tenantSuspendedId: string;
  let tenantDisabledId: string;

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
    const user = await prisma.user.create({
      data: { email: `user-a-${run}@example.com` },
    });
    userIdsToDelete.push(user.id);
    userAId = user.id;

    const createTenant = async (name: string, status?: TenantStatus) => {
      const tenant = await prisma.tenant.create({
        data: {
          name,
          slug: `${run}-${name}-${randomUUID().slice(0, 6)}`,
          status,
        },
      });
      tenantIdsToDelete.push(tenant.id);
      return tenant;
    };

    const createRole = (tenantId: string, key: string) =>
      tenantContext.run(tenantId, async () =>
        prisma.role.create({
          data: { tenantId, key: `${run}-${key}`, name: key },
        }),
      );

    const createMembership = (
      userId: string,
      tenantId: string,
      roleId: string,
      status: MembershipStatus = 'ACTIVE',
    ) =>
      tenantContext.run(tenantId, async () =>
        prisma.membership.create({
          data: { userId, tenantId, roleId, status },
        }),
      );

    const tenantA = await createTenant('Tenant A');
    const tenantB = await createTenant('Tenant B');
    const tenantInvited = await createTenant('Tenant Invited');
    const tenantSuspendedMembership = await createTenant(
      'Tenant Suspended Membership',
    );
    const tenantSuspended = await createTenant('Tenant Suspended', 'SUSPENDED');
    const tenantDisabled = await createTenant('Tenant Disabled', 'DISABLED');

    tenantAId = tenantA.id;
    tenantBId = tenantB.id;
    tenantInvitedId = tenantInvited.id;
    tenantSuspendedMembershipId = tenantSuspendedMembership.id;
    tenantSuspendedId = tenantSuspended.id;
    tenantDisabledId = tenantDisabled.id;

    const roleA = await createRole(tenantAId, 'role-a');
    await createRole(tenantBId, 'role-b');
    const roleInvited = await createRole(tenantInvitedId, 'role-invited');
    const roleSuspendedMembership = await createRole(
      tenantSuspendedMembershipId,
      'role-suspended-membership',
    );
    const roleSuspended = await createRole(tenantSuspendedId, 'role-suspended');
    const roleDisabled = await createRole(tenantDisabledId, 'role-disabled');

    await createMembership(userAId, tenantAId, roleA.id);
    await createMembership(userAId, tenantInvitedId, roleInvited.id, 'INVITED');
    await createMembership(
      userAId,
      tenantSuspendedMembershipId,
      roleSuspendedMembership.id,
      'SUSPENDED',
    );
    await createMembership(userAId, tenantSuspendedId, roleSuspended.id);
    await createMembership(userAId, tenantDisabledId, roleDisabled.id);

    await tenantContext.run(tenantAId, async () =>
      prisma.store.create({
        data: { tenantId: tenantAId, name: 'Store A', code: `store-a-${run}` },
      }),
    );
    await tenantContext.run(tenantBId, async () =>
      prisma.store.create({
        data: { tenantId: tenantBId, name: 'Store B', code: `store-b-${run}` },
      }),
    );
  });

  afterAll(async () => {
    if (prisma) {
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
  const contextRequest = (token: string, tenantId?: string) => {
    const req = request(httpServer()).get('/tenant/_test/context');
    if (token) {
      req.set('Authorization', `Bearer ${token}`);
    }
    if (tenantId) {
      req.set('X-Tenant-ID', tenantId);
    }
    return req;
  };

  it('allows an authenticated member with a valid X-Tenant-ID', async () => {
    const response = await contextRequest(await tokenFor(userAId), tenantAId);

    const body = response.body as ContextBody;
    expect(response.status).toBe(200);
    expect(body.tenantId).toBe(tenantAId);
    expect(body.tenantName).toBe('Tenant A');
    expect(body.contextTenantId).toBe(tenantAId);
  });

  it('rejects a request without X-Tenant-ID with 400', async () => {
    const response = await contextRequest(await tokenFor(userAId));

    const body = response.body as ContextBody;
    expect(response.status).toBe(400);
    expect(body.message).toBe('Missing X-Tenant-ID header');
  });

  it('rejects an authenticated user with no membership in the tenant with 403', async () => {
    const response = await contextRequest(await tokenFor(userAId), tenantBId);

    const body = response.body as ContextBody;
    expect(response.status).toBe(403);
    expect(body.message).toBe('Tenant access denied');
  });

  it('rejects an INVITED membership with 403', async () => {
    const response = await contextRequest(
      await tokenFor(userAId),
      tenantInvitedId,
    );

    expect(response.status).toBe(403);
  });

  it('rejects a SUSPENDED membership with 403', async () => {
    const response = await contextRequest(
      await tokenFor(userAId),
      tenantSuspendedMembershipId,
    );

    expect(response.status).toBe(403);
  });

  it('rejects a SUSPENDED tenant with 403', async () => {
    const response = await contextRequest(
      await tokenFor(userAId),
      tenantSuspendedId,
    );

    expect(response.status).toBe(403);
  });

  it('rejects a DISABLED tenant with 403', async () => {
    const response = await contextRequest(
      await tokenFor(userAId),
      tenantDisabledId,
    );

    expect(response.status).toBe(403);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const response = await contextRequest('');

    expect(response.status).toBe(401);
  });

  it('proves that knowing Tenant B id alone is insufficient for User A', async () => {
    const token = await tokenFor(userAId);

    const allowed = await contextRequest(token, tenantAId);
    expect(allowed.status).toBe(200);
    expect((allowed.body as ContextBody).tenantId).toBe(tenantAId);

    const forbidden = await contextRequest(token, tenantBId);
    expect(forbidden.status).toBe(403);
  });
});
