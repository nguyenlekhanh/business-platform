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
 * Phase 3 U4 — Inventory integration suite.
 * Single pool per variant, guarded atomic updateMany, lazy row ==0,
 * DB CHECK >=0, tenant-isolated via variant lookup, RBAC inventory:read/manage.
 */
describe('Inventory (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }
  interface InventoryBody {
    id: string | null;
    tenantId: string;
    variantId: string;
    quantityOnHand: number;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `inv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
      prisma.role.create({ data: { tenantId, key, name: `${key} ${run}` } }),
    );
    roleIdsToDelete.push(role.id);
    if (permissionKeys.length > 0) {
      await tenantContext.run(tenantId, async () => {
        const permissions = await prisma.permission.findMany({
          where: { key: { in: [...permissionKeys] } },
        });
        await prisma.rolePermission.createMany({
          data: permissions.map((p) => ({
            roleId: role.id,
            permissionId: p.id,
          })),
        });
      });
    }
    return role;
  };

  const createProductFixture = async (tenantId: string, code: string) =>
    tenantContext.run(tenantId, async () =>
      prisma.product.create({ data: { tenantId, code, name: code } }),
    );

  const createVariantFixture = async (
    tenantId: string,
    productId: string,
    sku: string,
  ) =>
    tenantContext.run(tenantId, async () =>
      prisma.productVariant.create({ data: { tenantId, productId, sku } }),
    );

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
      prisma.membership.create({ data: { userId: user.id, tenantId, roleId } }),
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
    method: 'get' | 'post',
    path: string,
    headers: Record<string, string>,
    payload?: Record<string, unknown>,
  ): Promise<Res> => {
    let req = request(httpServer())[method](path).set(headers);
    if (payload !== undefined) req = req.send(payload);
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
    await prisma.permission.createMany({
      data: PERMISSION_DEFINITIONS.map((d) => ({
        key: d.key,
        name: d.name,
        category: d.category,
        description: d.description ?? null,
      })),
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.inventory
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.price
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.productVariant
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
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
    if (app) await app.close();
  });

  let tenantAId: string;
  let tenantBId: string;
  let adminAId: string;
  let employeeAId: string;
  let managerAId: string;
  let manageOnlyAId: string;
  let ownerAId: string;
  let adminBId: string;

  let adminA: Record<string, string>;
  let employeeA: Record<string, string>;
  let managerA: Record<string, string>;
  let manageOnlyA: Record<string, string>;
  let ownerA: Record<string, string>;
  let adminB: Record<string, string>;

  let variantAId: string;
  let variantBId: string;
  let seq = 0;

  beforeEach(async () => {
    seq += 1;
    const tenantA = await createTenant('a');
    tenantAId = tenantA.id;
    const adminRole = await grantRole(tenantAId, `admin-a-${run}`, [
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.INVENTORY_MANAGE,
      PERMISSIONS.PRODUCT_READ,
      PERMISSIONS.PRODUCT_CREATE,
      PERMISSIONS.PRODUCT_MANAGE,
    ]);
    const employeeRole = await grantRole(tenantAId, `employee-a-${run}`, [
      PERMISSIONS.INVENTORY_READ,
    ]);
    const managerRole = await grantRole(tenantAId, `manager-a-${run}`, []);
    const manageOnlyRole = await grantRole(tenantAId, `manageonly-a-${run}`, [
      PERMISSIONS.INVENTORY_MANAGE,
    ]);
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

    const tenantB = await createTenant('b');
    tenantBId = tenantB.id;
    const adminRoleB = await grantRole(tenantBId, `admin-b-${run}`, [
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.INVENTORY_MANAGE,
      PERMISSIONS.PRODUCT_READ,
      PERMISSIONS.PRODUCT_CREATE,
      PERMISSIONS.PRODUCT_MANAGE,
    ]);
    adminBId = (
      await createUser(`admin-${run}-${seq}@b.test`, tenantBId, adminRoleB.id)
    ).id;

    const outsider = await prisma.user.create({
      data: { email: `outsider-${run}-${seq}@x.test`, passwordHash: 'hash-x' },
    });
    userIdsToDelete.push(outsider.id);

    adminA = await loginAs(adminAId, tenantAId);
    employeeA = await loginAs(employeeAId, tenantAId);
    managerA = await loginAs(managerAId, tenantAId);
    manageOnlyA = await loginAs(manageOnlyAId, tenantAId);
    ownerA = await loginAs(ownerAId, tenantAId);
    adminB = await loginAs(adminBId, tenantBId);

    const pA = await createProductFixture(tenantAId, `PROD-A-${run}-${seq}`);
    const vA = await createVariantFixture(
      tenantAId,
      pA.id,
      `SKU-A-${run}-${seq}`,
    );
    variantAId = vA.id;
    const pB = await createProductFixture(tenantBId, `PROD-B-${run}-${seq}`);
    const vB = await createVariantFixture(
      tenantBId,
      pB.id,
      `SKU-B-${run}-${seq}`,
    );
    variantBId = vB.id;
  });

  describe('authentication and authorization gates', () => {
    it('rejects unauthenticated with 401', async () => {
      expect((await call('get', `/inventory/${variantAId}`, {})).status).toBe(
        401,
      );
      expect(
        (
          await call(
            'post',
            '/inventory/adjust',
            {},
            { variantId: variantAId, delta: 1 },
          )
        ).status,
      ).toBe(401);
    });

    it('rejects outsider without membership with 403', async () => {
      const outsiderUser = await prisma.user.findUniqueOrThrow({
        where: { email: `outsider-${run}-${seq}@x.test` },
      });
      const headers = await loginAs(outsiderUser.id, tenantAId);
      expect(
        (await call('get', `/inventory/${variantAId}`, headers)).status,
      ).toBe(403);
      expect(
        (
          await call('post', '/inventory/adjust', headers, {
            variantId: variantAId,
            delta: 1,
          })
        ).status,
      ).toBe(403);
    });

    it('rejects member without inventory permissions with 403', async () => {
      expect(
        (await call('get', `/inventory/${variantAId}`, managerA)).status,
      ).toBe(403);
      expect(
        (
          await call('post', '/inventory/adjust', managerA, {
            variantId: variantAId,
            delta: 1,
          })
        ).status,
      ).toBe(403);
    });
  });

  describe('initial stock and valid adjustment', () => {
    it('returns 0 for never-adjusted variant and adjusts atomically', async () => {
      const get0 = await call('get', `/inventory/${variantAId}`, adminA);
      expect(get0.status).toBe(200);
      const body0 = get0.body as unknown as InventoryBody;
      expect(body0.quantityOnHand).toBe(0);
      expect(body0.variantId).toBe(variantAId);
      expect(body0.id).toBeNull();

      const adj1 = await call('post', '/inventory/adjust', adminA, {
        variantId: variantAId,
        delta: 10,
      });
      expect(adj1.status).toBe(201);
      const adjBody1 = adj1.body as unknown as InventoryBody;
      expect(adjBody1.quantityOnHand).toBe(10);
      expect(adjBody1.id).not.toBeNull();

      const get10 = await call('get', `/inventory/${variantAId}`, adminA);
      expect((get10.body as unknown as InventoryBody).quantityOnHand).toBe(10);

      const adj2 = await call('post', '/inventory/adjust', adminA, {
        variantId: variantAId,
        delta: -3,
        reason: 'sale',
      });
      expect(adj2.status).toBe(201);
      expect((adj2.body as unknown as InventoryBody).quantityOnHand).toBe(7);

      const adj3 = await call('post', '/inventory/adjust', adminA, {
        variantId: variantAId,
        delta: 5,
      });
      expect((adj3.body as unknown as InventoryBody).quantityOnHand).toBe(12);
    });
  });

  describe('insufficient stock and negative protection', () => {
    it('rejects decrement below zero with 409 and leaves quantity unchanged', async () => {
      const setup = await call('post', '/inventory/adjust', adminA, {
        variantId: variantAId,
        delta: 5,
      });
      expect(setup.status).toBe(201);

      const fail = await call('post', '/inventory/adjust', adminA, {
        variantId: variantAId,
        delta: -10,
      });
      expect(fail.status).toBe(409);
      expect((fail.body as unknown as ErrorBody).message).toBe(
        'Insufficient stock',
      );

      const after = await call('get', `/inventory/${variantAId}`, adminA);
      expect((after.body as unknown as InventoryBody).quantityOnHand).toBe(5);
    });

    it('rejects decrement on missing row (0 stock) with 409', async () => {
      const fail = await call('post', '/inventory/adjust', adminA, {
        variantId: variantAId,
        delta: -1,
      });
      expect(fail.status).toBe(409);
    });

    it('allows exact depletion to zero but not beyond', async () => {
      await call('post', '/inventory/adjust', adminA, {
        variantId: variantAId,
        delta: 3,
      });
      const toZero = await call('post', '/inventory/adjust', adminA, {
        variantId: variantAId,
        delta: -3,
      });
      expect(toZero.status).toBe(201);
      expect((toZero.body as unknown as InventoryBody).quantityOnHand).toBe(0);
      const beyond = await call('post', '/inventory/adjust', adminA, {
        variantId: variantAId,
        delta: -1,
      });
      expect(beyond.status).toBe(409);
    });
  });

  describe('tenant isolation / IDOR', () => {
    it('hides cross-tenant variant inventory as 404', async () => {
      expect(
        (await call('get', `/inventory/${variantBId}`, adminA)).status,
      ).toBe(404);
      expect(
        (
          await call('post', '/inventory/adjust', adminA, {
            variantId: variantBId,
            delta: 1,
          })
        ).status,
      ).toBe(404);
      expect(
        (await call('get', `/inventory/${variantAId}`, adminB)).status,
      ).toBe(404);
    });

    it('unknown variant returns 404', async () => {
      const fake = `no-var-${run}`;
      expect((await call('get', `/inventory/${fake}`, adminA)).status).toBe(
        404,
      );
      expect(
        (
          await call('post', '/inventory/adjust', adminA, {
            variantId: fake,
            delta: 1,
          })
        ).status,
      ).toBe(404);
    });
  });

  describe('RBAC matrix', () => {
    it('manage-only can adjust but cannot read', async () => {
      expect(
        (await call('get', `/inventory/${variantAId}`, manageOnlyA)).status,
      ).toBe(403);
      const adj = await call('post', '/inventory/adjust', manageOnlyA, {
        variantId: variantAId,
        delta: 4,
      });
      expect(adj.status).toBe(201);
      expect((adj.body as unknown as InventoryBody).quantityOnHand).toBe(4);
    });

    it('employee read-only', async () => {
      await call('post', '/inventory/adjust', adminA, {
        variantId: variantAId,
        delta: 2,
      });
      expect(
        (await call('get', `/inventory/${variantAId}`, employeeA)).status,
      ).toBe(200);
      expect(
        (
          await call('post', '/inventory/adjust', employeeA, {
            variantId: variantAId,
            delta: 1,
          })
        ).status,
      ).toBe(403);
    });

    it('owner semantic-all works without grants', async () => {
      const get = await call('get', `/inventory/${variantAId}`, ownerA);
      expect(get.status).toBe(200);
      expect((get.body as unknown as InventoryBody).quantityOnHand).toBe(0);
      const adj = await call('post', '/inventory/adjust', ownerA, {
        variantId: variantAId,
        delta: 7,
      });
      expect(adj.status).toBe(201);
      expect((adj.body as unknown as InventoryBody).quantityOnHand).toBe(7);
    });
  });

  describe('validation contract', () => {
    it('rejects missing/invalid variantId and delta with 400', async () => {
      const cases: Array<Record<string, unknown>> = [
        {},
        { variantId: variantAId },
        { delta: 1 },
        { variantId: '', delta: 1 },
        { variantId: variantAId, delta: 0 },
        { variantId: variantAId, delta: 1.5 },
        { variantId: variantAId, delta: '1' },
        { variantId: variantAId, delta: 1, bogus: true },
      ];
      for (const payload of cases) {
        const res = await call('post', '/inventory/adjust', adminA, payload);
        expect(res.status).toBe(400);
      }
    });

    it('rejects tenantId injection and too-long reason', async () => {
      expect(
        (
          await call('post', '/inventory/adjust', adminA, {
            variantId: variantAId,
            delta: 1,
            tenantId: tenantBId,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call('post', '/inventory/adjust', adminA, {
            variantId: variantAId,
            delta: 1,
            reason: 'x'.repeat(501),
          })
        ).status,
      ).toBe(400);
    });
  });

  describe('concurrent stock mutation', () => {
    it('exactly one of two concurrent decrements on last units succeeds', async () => {
      await call('post', '/inventory/adjust', adminA, {
        variantId: variantAId,
        delta: 5,
      });
      const [a, b] = await Promise.all([
        call('post', '/inventory/adjust', adminA, {
          variantId: variantAId,
          delta: -3,
        }),
        call('post', '/inventory/adjust', adminA, {
          variantId: variantAId,
          delta: -3,
        }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]); // one success, one insufficient
      const winner = a.status === 201 ? a : b;
      const expected = (winner.body as unknown as InventoryBody).quantityOnHand;
      expect(expected).toBe(2);
      const finalGet = await call('get', `/inventory/${variantAId}`, adminA);
      expect((finalGet.body as unknown as InventoryBody).quantityOnHand).toBe(
        2,
      );
    });

    it('concurrent increments both succeed and sum correctly', async () => {
      const [a, b] = await Promise.all([
        call('post', '/inventory/adjust', adminA, {
          variantId: variantAId,
          delta: 3,
        }),
        call('post', '/inventory/adjust', adminA, {
          variantId: variantAId,
          delta: 4,
        }),
      ]);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      const finalGet = await call('get', `/inventory/${variantAId}`, adminA);
      expect((finalGet.body as unknown as InventoryBody).quantityOnHand).toBe(
        7,
      );
    });
  });

  describe('cascade', () => {
    it('deleting variant removes inventory; subsequent get is 404', async () => {
      await call('post', '/inventory/adjust', adminA, {
        variantId: variantAId,
        delta: 10,
      });
      // delete variant via product module (requires product:delete|manage, admin has it via product manage)
      // Need productId to delete variant - we have variantAId, need to fetch its product? Use direct variant delete endpoint
      const del = await request(httpServer())
        .delete(`/variants/${variantAId}`)
        .set(adminA);
      expect(del.status).toBe(204);
      expect(
        (await call('get', `/inventory/${variantAId}`, adminA)).status,
      ).toBe(404);
    });
  });
});
