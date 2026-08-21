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

describe('Customer administration (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  interface ErrorBody {
    message?: string | string[];
    statusCode?: number;
  }

  interface CustomerBody {
    id: string;
    tenantId: string;
    name: string;
    code: string;
    email: string | null;
    phone: string | null;
    notes: string | null;
    status: string;
  }

  interface PaginatedBody {
    data: CustomerBody[];
    meta: { nextCursor: string | null };
  }

  const run = `cust-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const customerIdsToDelete: string[] = [];
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
  let adminRoleAId: string;
  let managerRoleId: string;
  let custAId: string;
  let custBId: string;

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
      const permission = await prisma.permission.findUnique({
        where: { key: definition.key },
      });
      if (!permission) {
        await prisma.permission
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
              return undefined;
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

    tenantAId = await createTenant('Customer Tenant A');
    tenantBId = await createTenant('Customer Tenant B');

    // Tenant A roles.
    const ownerRoleA = await createRole(tenantAId, 'owner', 'Owner', true);
    adminRoleAId = (await createRole(tenantAId, 'admin', 'Admin', true)).id;
    const employeeRoleA = await createRole(
      tenantAId,
      'employee',
      'Employee',
      true,
    );
    // Manage-only custom role: exercises that customer:manage covers writes
    // but must NOT implicitly grant GET (GET requires customer:read).
    managerRoleId = (await createRole(tenantAId, `crm-${run}`, 'CrmManager'))
      .id;

    await grant(adminRoleAId, PERMISSIONS.CUSTOMER_READ);
    await grant(adminRoleAId, PERMISSIONS.CUSTOMER_CREATE);
    await grant(adminRoleAId, PERMISSIONS.CUSTOMER_UPDATE);
    await grant(adminRoleAId, PERMISSIONS.CUSTOMER_DELETE);
    await grant(employeeRoleA.id, PERMISSIONS.CUSTOMER_READ);
    await grant(managerRoleId, PERMISSIONS.CUSTOMER_MANAGE);

    await createMembership(ownerA, tenantAId, ownerRoleA.id);
    await createMembership(adminA, tenantAId, adminRoleAId);
    await createMembership(employeeA, tenantAId, employeeRoleA.id);
    await createMembership(managerA, tenantAId, managerRoleId);

    // Tenant B roles: full customer grants mirroring tenant A.
    const adminRoleB = await createRole(tenantBId, 'admin', 'Admin', true);
    await grant(adminRoleB.id, PERMISSIONS.CUSTOMER_READ);
    await grant(adminRoleB.id, PERMISSIONS.CUSTOMER_CREATE);
    await grant(adminRoleB.id, PERMISSIONS.CUSTOMER_UPDATE);
    await grant(adminRoleB.id, PERMISSIONS.CUSTOMER_DELETE);
    await createMembership(adminB, tenantBId, adminRoleB.id);

    // Baseline customers through the API (also exercises the create path).
    const resA = await send(
      'post',
      '/customers',
      await tokenFor(adminA),
      tenantAId,
      { name: 'Alpha Construction', code: `${run}-A` },
    );
    expect(resA.status).toBe(201);
    custAId = (resA.body as CustomerBody).id;
    customerIdsToDelete.push(custAId);

    const resB = await send(
      'post',
      '/customers',
      await tokenFor(adminB),
      tenantBId,
      { name: 'Beta Logistics', code: `${run}-B` },
    );
    expect(resB.status).toBe(201);
    custBId = (resB.body as CustomerBody).id;
    customerIdsToDelete.push(custBId);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.customer
        .deleteMany({ where: { id: { in: customerIdsToDelete } } })
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

  describe('listing customers', () => {
    it('list with customer:read -> 200 envelope', async () => {
      const res = await get('/customers', await tokenFor(adminA), tenantAId);
      expect(res.status).toBe(200);
      const body = res.body as PaginatedBody;
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.some((c) => c.id === custAId)).toBe(true);
    });

    it('lists only the active tenant customers (cross-tenant list isolation)', async () => {
      const listB = await get('/customers', await tokenFor(adminB), tenantBId);
      expect(listB.status).toBe(200);
      const bodyB = listB.body as PaginatedBody;
      expect(bodyB.data.some((c) => c.id === custAId)).toBe(false);
      expect(bodyB.data.some((c) => c.id === custBId)).toBe(true);

      const listA = await get('/customers', await tokenFor(adminA), tenantAId);
      expect(listA.status).toBe(200);
      const bodyA = listA.body as PaginatedBody;
      expect(bodyA.data.some((c) => c.id === custBId)).toBe(false);
    });

    it('insufficient permission -> 403', async () => {
      const nobody = await createUser(`nobody-${run}@example.com`);
      const nobodyRole = await createRole(
        tenantAId,
        `nobody-${run}`,
        'NoPerms',
      );
      await createMembership(nobody, tenantAId, nobodyRole.id);

      const res = await get('/customers', await tokenFor(nobody), tenantAId);
      expect(res.status).toBe(403);
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
        qs ? `/customers?${qs}` : '/customers',
        await tokenFor(userId),
        tenantId,
      );
      return { res, body: res.body as PaginatedBody };
    };

    const createCustomer = async (i: number, status: 'ACTIVE' | 'INACTIVE') => {
      const res = await send(
        'post',
        '/customers',
        await tokenFor(adminA),
        tenantAId,
        {
          name: `Paged Customer ${i}`,
          code: `${run}-paged-${i}`,
          status,
        },
      );
      expect(res.status).toBe(201);
      const id = (res.body as CustomerBody).id;
      customerIdsToDelete.push(id);
      return id;
    };

    it('walks pages deterministically with limit 2', async () => {
      const created: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        created.push(await createCustomer(i, 'ACTIVE'));
      }

      const collected: string[] = [];
      let cursor: string | null | undefined;
      do {
        const q: Record<string, string> = { status: 'ACTIVE', limit: '2' };
        if (cursor) {
          q.cursor = cursor;
        }
        const { body } = await listQuery(q);
        for (const row of body.data) {
          expect(row.status).toBe('ACTIVE');
        }
        collected.push(...body.data.map((c) => c.id));
        cursor = body.meta.nextCursor;
      } while (cursor);
      for (const id of created) {
        expect(collected.filter((x) => x === id)).toHaveLength(1);
      }
    });

    it('filters by status; inactive fixtures stay out of the ACTIVE walk', async () => {
      await createCustomer(90, 'INACTIVE');
      const { body } = await listQuery({ status: 'INACTIVE' });
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const row of body.data) {
        expect(row.status).toBe('INACTIVE');
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

  describe('single customer', () => {
    it('get customer -> 200', async () => {
      const res = await get(
        `/customers/${custAId}`,
        await tokenFor(adminA),
        tenantAId,
      );
      expect(res.status).toBe(200);
      const body = res.body as CustomerBody;
      expect(body.id).toBe(custAId);
      expect(body.tenantId).toBe(tenantAId);
      expect(body.name).toBe('Alpha Construction');
      expect(body.code).toBe(`${run}-A`);
    });

    it('get missing customer -> 404', async () => {
      const res = await get(
        '/customers/non-existent-customer',
        await tokenFor(adminA),
        tenantAId,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('create customer', () => {
    it('minimal record -> 201 with defaults', async () => {
      const res = await send(
        'post',
        '/customers',
        await tokenFor(adminA),
        tenantAId,
        { name: 'Gamma Retail', code: `${run}-gamma` },
      );
      expect(res.status).toBe(201);
      const body = res.body as CustomerBody;
      expect(body.tenantId).toBe(tenantAId);
      expect(body.name).toBe('Gamma Retail');
      expect(body.email).toBeNull();
      expect(body.phone).toBeNull();
      expect(body.notes).toBeNull();
      expect(body.status).toBe('ACTIVE');
      customerIdsToDelete.push(body.id);
    });

    it('full contact payload -> 201 echoes all fields', async () => {
      const res = await send(
        'post',
        '/customers',
        await tokenFor(adminA),
        tenantAId,
        {
          name: 'Delta Mining',
          code: `${run}-delta`,
          email: 'ops@delta.example',
          phone: '+1-555-0140',
          notes: 'Net 45',
          status: 'INACTIVE',
        },
      );
      expect(res.status).toBe(201);
      const body = res.body as CustomerBody;
      expect(body.email).toBe('ops@delta.example');
      expect(body.phone).toBe('+1-555-0140');
      expect(body.notes).toBe('Net 45');
      expect(body.status).toBe('INACTIVE');
      customerIdsToDelete.push(body.id);
    });

    it('missing name -> 400', async () => {
      const res = await send(
        'post',
        '/customers',
        await tokenFor(adminA),
        tenantAId,
        { code: `${run}-noname` },
      );
      expect(res.status).toBe(400);
    });

    it('invalid email -> 400', async () => {
      const res = await send(
        'post',
        '/customers',
        await tokenFor(adminA),
        tenantAId,
        {
          name: 'Bad Email Co',
          code: `${run}-badmail`,
          email: 'not-an-email',
        },
      );
      expect(res.status).toBe(400);
    });

    it('rejects a client-supplied tenantId with 400', async () => {
      const res = await send(
        'post',
        '/customers',
        await tokenFor(adminA),
        tenantAId,
        {
          name: 'Injection Co',
          code: `${run}-inj`,
          tenantId: 'tenant-9',
        },
      );
      // forbidNonWhitelisted rejects non-DTO properties before the service.
      expect(res.status).toBe(400);
    });

    it('rejects a client-supplied id with 400', async () => {
      const res = await send(
        'post',
        '/customers',
        await tokenFor(adminA),
        tenantAId,
        { name: 'Id Injection Co', code: `${run}-injid`, id: 'cust-9' },
      );
      expect(res.status).toBe(400);
    });

    it('rejects arbitrary privilege/foreign-key fields with 400', async () => {
      const res = await send(
        'post',
        '/customers',
        await tokenFor(adminA),
        tenantAId,
        {
          name: 'Privilege Co',
          code: `${run}-priv`,
          roleId: 'role-9',
          permissions: ['customer:read'],
          permissionIds: ['perm-1'],
          membershipId: 'mem-9',
          userId: 'user-9',
          storeId: 'store-9',
          assetId: 'asset-9',
          equipmentId: 'equip-9',
        },
      );
      expect(res.status).toBe(400);
    });
  });

  describe('code uniqueness (tenant-scoped)', () => {
    it('duplicate code within the same tenant -> 409', async () => {
      const res = await send(
        'post',
        '/customers',
        await tokenFor(adminA),
        tenantAId,
        { name: 'Duplicate Co', code: `${run}-A` },
      );
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe(
        'A customer with this code already exists in the tenant',
      );
    });

    it('same code remains independently valid in another tenant -> 201', async () => {
      const res = await send(
        'post',
        '/customers',
        await tokenFor(adminB),
        tenantBId,
        { name: 'Cross-Tenant Twin', code: `${run}-A` },
      );
      expect(res.status).toBe(201);
      expect((res.body as CustomerBody).tenantId).toBe(tenantBId);
      customerIdsToDelete.push((res.body as CustomerBody).id);
    });
  });

  describe('update customer', () => {
    it('partial update -> 200', async () => {
      const res = await send(
        'put',
        `/customers/${custAId}`,
        await tokenFor(adminA),
        tenantAId,
        { phone: '+1-555-0177', notes: 'Updated note' },
      );
      expect(res.status).toBe(200);
      const body = res.body as CustomerBody;
      expect(body.phone).toBe('+1-555-0177');
      expect(body.notes).toBe('Updated note');
      expect(body.name).toBe('Alpha Construction');
    });

    it('rejects tenantId injection on update with 400', async () => {
      const res = await send(
        'put',
        `/customers/${custAId}`,
        await tokenFor(adminA),
        tenantAId,
        { tenantId: 'tenant-9' },
      );
      expect(res.status).toBe(400);
    });

    it('rename to an existing code in the tenant -> 409', async () => {
      const created = await send(
        'post',
        '/customers',
        await tokenFor(adminA),
        tenantAId,
        { name: 'Rename Target', code: `${run}-ren` },
      );
      expect(created.status).toBe(201);
      const id = (created.body as CustomerBody).id;
      customerIdsToDelete.push(id);

      const res = await send(
        'put',
        `/customers/${id}`,
        await tokenFor(adminA),
        tenantAId,
        { code: `${run}-A` },
      );
      expect(res.status).toBe(409);
    });
  });

  describe('delete customer', () => {
    it('delete -> 204 and scoped lookup confirms removal', async () => {
      const created = await send(
        'post',
        '/customers',
        await tokenFor(adminA),
        tenantAId,
        { name: 'Doomed Co', code: `${run}-doomed` },
      );
      const id = (created.body as CustomerBody).id;

      const res = await send(
        'delete',
        `/customers/${id}`,
        await tokenFor(adminA),
        tenantAId,
      );
      expect(res.status).toBe(204);

      const gone = await tenantContext.run(tenantAId, async () =>
        prisma.customer.findUnique({ where: { id } }),
      );
      expect(gone).toBeNull();
    });
  });

  describe('IDOR protection (no tenant data leakage)', () => {
    it('cross-tenant customer GET -> 404', async () => {
      const res = await get(
        `/customers/${custAId}`,
        await tokenFor(adminB),
        tenantBId,
      );
      expect(res.status).toBe(404);
    });

    it('cross-tenant customer PUT -> 404', async () => {
      const res = await send(
        'put',
        `/customers/${custAId}`,
        await tokenFor(adminB),
        tenantBId,
        { name: 'Hacked' },
      );
      expect(res.status).toBe(404);
    });

    it('cross-tenant customer DELETE -> 404', async () => {
      const res = await send(
        'delete',
        `/customers/${custAId}`,
        await tokenFor(adminB),
        tenantBId,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('authorization matrix', () => {
    it('customer:manage alone can create/update/delete but NOT read (GET -> 403)', async () => {
      const createRes = await send(
        'post',
        '/customers',
        await tokenFor(managerA),
        tenantAId,
        { name: 'Managed Client', code: `${run}-managed` },
      );
      expect(createRes.status).toBe(201);
      const id = (createRes.body as CustomerBody).id;
      customerIdsToDelete.push(id);

      const updRes = await send(
        'put',
        `/customers/${id}`,
        await tokenFor(managerA),
        tenantAId,
        { phone: '+1-555-0190' },
      );
      expect(updRes.status).toBe(200);

      const delRes = await send(
        'delete',
        `/customers/${id}`,
        await tokenFor(managerA),
        tenantAId,
      );
      expect(delRes.status).toBe(204);

      // GET requires customer:read; customer:manage must NOT imply it.
      const listRes = await get(
        '/customers',
        await tokenFor(managerA),
        tenantAId,
      );
      expect(listRes.status).toBe(403);

      const getRes = await get(
        `/customers/${custAId}`,
        await tokenFor(managerA),
        tenantAId,
      );
      expect(getRes.status).toBe(403);
    });

    it('read-only member can GET but not create (403)', async () => {
      const getRes = await get(
        `/customers/${custAId}`,
        await tokenFor(employeeA),
        tenantAId,
      );
      expect(getRes.status).toBe(200);

      const postRes = await send(
        'post',
        '/customers',
        await tokenFor(employeeA),
        tenantAId,
        { name: 'Employee Co', code: `${run}-emp` },
      );
      expect(postRes.status).toBe(403);
    });

    it('owner semantic-all -> full CRUD without explicit customer grants', async () => {
      const created = await send(
        'post',
        '/customers',
        await tokenFor(ownerA),
        tenantAId,
        { name: 'Owner Client', code: `${run}-owner` },
      );
      expect(created.status).toBe(201);
      const id = (created.body as CustomerBody).id;

      const got = await get(
        `/customers/${id}`,
        await tokenFor(ownerA),
        tenantAId,
      );
      expect(got.status).toBe(200);

      const updated = await send(
        'put',
        `/customers/${id}`,
        await tokenFor(ownerA),
        tenantAId,
        { notes: 'Owner was here' },
      );
      expect(updated.status).toBe(200);

      const deleted = await send(
        'delete',
        `/customers/${id}`,
        await tokenFor(ownerA),
        tenantAId,
      );
      expect(deleted.status).toBe(204);
    });
  });

  describe('auth / tenant state gating', () => {
    it('invalid JWT -> 401', async () => {
      const res = await send('post', '/customers', 'not-a-jwt', tenantAId, {
        name: 'Nope',
        code: `${run}-nojwt`,
      });
      expect(res.status).toBe(401);
    });

    it('missing tenant header -> 400', async () => {
      const res = await send('post', '/customers', await tokenFor(adminA), '', {
        name: 'NoHeader Co',
        code: `${run}-nohdr`,
      });
      expect(res.status).toBe(400);
    });

    it('suspended membership actor -> 403', async () => {
      const suspended = await createUser(`cu-suspended-${run}@example.com`);
      await createMembership(suspended, tenantAId, adminRoleAId, 'SUSPENDED');

      const res = await send(
        'post',
        '/customers',
        await tokenFor(suspended),
        tenantAId,
        { name: 'Suspended Co', code: `${run}-sus` },
      );
      expect(res.status).toBe(403);
    });

    it('inactive tenant -> 403', async () => {
      const inactiveTenant = await createTenant('Inactive Customer Tenant');
      await prisma.tenant.update({
        where: { id: inactiveTenant },
        data: { status: 'SUSPENDED' },
      });

      const res = await send(
        'post',
        '/customers',
        await tokenFor(adminA),
        inactiveTenant,
        { name: 'Ghost Co', code: `${run}-ghost` },
      );
      expect(res.status).toBe(403);
    });
  });

  describe('response safety', () => {
    it('returns exactly the safe CustomerSummary projection', async () => {
      const res = await get(
        `/customers/${custBId}`,
        await tokenFor(adminB),
        tenantBId,
      );
      expect(res.status).toBe(200);
      expect(Object.keys(res.body as object).sort()).toEqual([
        'code',
        'createdAt',
        'email',
        'id',
        'name',
        'notes',
        'phone',
        'status',
        'tenantId',
        'updatedAt',
      ]);
    });
  });
});
