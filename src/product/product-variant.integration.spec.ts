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
 * Phase 3 U3 — ProductVariant + Price integration suite.
 *
 * Variants and prices are product internals reusing the product:* RBAC keys
 * (no new catalog entries, per assessment §10). Coverage: auth gates, RBAC
 * matrix incl. manage-only and owner, tenant isolation/IDOR, DTO whitelist
 * and BigInt string serialization, price upsert overwrite semantics (no
 * history), currency validation, SKU uniqueness, product-parent resolution,
 * keyset pagination envelope, and product->variant->price cascade.
 */
describe('ProductVariant (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }

  interface PriceEntry {
    currency: string;
    amountMinor: string;
  }

  interface VariantBody {
    id: string;
    tenantId: string;
    productId: string;
    sku: string;
    name: string | null;
    status: string;
    prices: PriceEntry[];
  }

  interface ListBody {
    data: VariantBody[];
    meta: { nextCursor: string | null };
  }

  interface PriceBody {
    id: string;
    variantId: string;
    currency: string;
    amountMinor: string;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `var-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

  const createProductFixture = async (
    tenantId: string,
    code: string,
    name: string,
  ) => {
    const product = await tenantContext.run(tenantId, async () =>
      prisma.product.create({
        data: { tenantId, code, name },
      }),
    );
    return product;
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
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
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

  const callRaw = async (
    method: 'put',
    path: string,
    headers: Record<string, string>,
    payload: unknown,
  ): Promise<Res> => {
    const res = await request(httpServer())
      [method](path)
      .set(headers)
      .send(payload as object);
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
    if (app) {
      await app.close();
    }
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

  let productAId: string;
  let productBId: string;

  let seq = 0;

  beforeEach(async () => {
    seq += 1;
    const tenantA = await createTenant('a');
    tenantAId = tenantA.id;
    const adminRole = await grantRole(tenantAId, `admin-a-${run}`, [
      PERMISSIONS.PRODUCT_READ,
      PERMISSIONS.PRODUCT_CREATE,
      PERMISSIONS.PRODUCT_UPDATE,
      PERMISSIONS.PRODUCT_DELETE,
      PERMISSIONS.PRODUCT_MANAGE,
    ]);
    const employeeRole = await grantRole(tenantAId, `employee-a-${run}`, [
      PERMISSIONS.PRODUCT_READ,
    ]);
    const managerRole = await grantRole(tenantAId, `manager-a-${run}`, []);
    const manageOnlyRole = await grantRole(tenantAId, `manageonly-a-${run}`, [
      PERMISSIONS.PRODUCT_MANAGE,
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

    // Product fixtures for this test row (direct DB, independent of variant permissions).
    const pA = await createProductFixture(
      tenantAId,
      `PROD-A-${run}-${seq}`,
      `Prod A ${run}`,
    );
    productAId = pA.id;
    const pB = await createProductFixture(
      tenantBId,
      `PROD-B-${run}-${seq}`,
      `Prod B ${run}`,
    );
    productBId = pB.id;
  });

  describe('authentication and authorization gates', () => {
    it('rejects unauthenticated requests with 401', async () => {
      expect(
        (await call('get', `/products/${productAId}/variants`, {})).status,
      ).toBe(401);
      expect(
        (
          await call(
            'post',
            `/products/${productAId}/variants`,
            {},
            { sku: 'X' },
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await call(
            'put',
            '/variants/some-id/price',
            {},
            { currency: 'USD', amountMinor: 100 },
          )
        ).status,
      ).toBe(401);
    });

    it('rejects an authenticated user without tenant membership with 403', async () => {
      const outsiderUser = await prisma.user.findUniqueOrThrow({
        where: { email: `outsider-${run}-${seq}@x.test` },
      });
      const headers = await loginAs(outsiderUser.id, tenantAId);
      expect(
        (await call('get', `/products/${productAId}/variants`, headers)).status,
      ).toBe(403);
      expect(
        (
          await call('post', `/products/${productAId}/variants`, headers, {
            sku: 'X',
          })
        ).status,
      ).toBe(403);
      expect(
        (await call('patch', '/variants/some-id', headers, { name: 'Nope' }))
          .status,
      ).toBe(403);
      expect((await call('delete', '/variants/some-id', headers)).status).toBe(
        403,
      );
      expect(
        (
          await call('put', '/variants/some-id/price', headers, {
            currency: 'USD',
            amountMinor: 100,
          })
        ).status,
      ).toBe(403);
    });

    it('rejects a member without product permissions with 403', async () => {
      expect(
        (await call('get', `/products/${productAId}/variants`, managerA))
          .status,
      ).toBe(403);
      expect(
        (
          await call('post', `/products/${productAId}/variants`, managerA, {
            sku: 'X',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call('put', '/variants/some-id/price', managerA, {
            currency: 'USD',
            amountMinor: 100,
          })
        ).status,
      ).toBe(403);
    });
  });

  describe('variant lifecycle (admin)', () => {
    it('creates (default ACTIVE, empty prices), lists envelope, patches incl. archive, upserts price, deletes', async () => {
      const createdRes = await call(
        'post',
        `/products/${productAId}/variants`,
        adminA,
        {
          sku: `SKU-${run}`,
          name: '250g bag',
        },
      );
      expect(createdRes.status).toBe(201);
      const created = createdRes.body as unknown as VariantBody;
      expect(created.tenantId).toBe(tenantAId);
      expect(created.productId).toBe(productAId);
      expect(created.sku).toBe(`SKU-${run}`);
      expect(created.status).toBe('ACTIVE');
      expect(created.prices).toEqual([]);

      const listRes = await call(
        'get',
        `/products/${productAId}/variants`,
        adminA,
      );
      expect(listRes.status).toBe(200);
      expect(Object.keys(listRes.body)).toEqual(['data', 'meta']);
      const listed = listRes.body as unknown as ListBody;
      expect(Object.keys(listed.meta)).toEqual(['nextCursor']);
      expect(listed.data.some((row) => row.id === created.id)).toBe(true);

      const patchedRes = await call(
        'patch',
        `/variants/${created.id}`,
        adminA,
        {
          name: '500g bag',
          status: 'ARCHIVED',
        },
      );
      expect(patchedRes.status).toBe(200);
      const patched = patchedRes.body as unknown as VariantBody;
      expect(patched.name).toBe('500g bag');
      expect(patched.status).toBe('ARCHIVED');

      // Price upsert — create
      const priceRes = await call(
        'put',
        `/variants/${created.id}/price`,
        adminA,
        {
          currency: 'USD',
          amountMinor: 1250,
        },
      );
      expect(priceRes.status).toBe(200);
      const priceBody = priceRes.body as unknown as PriceBody;
      expect(priceBody.variantId).toBe(created.id);
      expect(priceBody.currency).toBe('USD');
      expect(priceBody.amountMinor).toBe('1250');
      expect(typeof priceBody.amountMinor).toBe('string');

      // Variant now embeds the price
      const listedWithPrice = (
        await call('get', `/products/${productAId}/variants`, adminA)
      ).body as unknown as ListBody;
      const withPrice = listedWithPrice.data.find(
        (row) => row.id === created.id,
      );
      expect(withPrice?.prices).toEqual([
        { currency: 'USD', amountMinor: '1250' },
      ]);

      // Overwrite same currency — no history
      const overwriteRes = await call(
        'put',
        `/variants/${created.id}/price`,
        adminA,
        {
          currency: 'USD',
          amountMinor: 2000,
        },
      );
      expect(overwriteRes.status).toBe(200);
      const overwriteBody = overwriteRes.body as unknown as PriceBody;
      expect(overwriteBody.amountMinor).toBe('2000');
      // Same row id (update, not duplicate)
      expect(overwriteBody.id).toBe(priceBody.id);

      const afterOverwrite = (
        await call('get', `/products/${productAId}/variants`, adminA)
      ).body as unknown as ListBody;
      const variantAfter = afterOverwrite.data.find(
        (row) => row.id === created.id,
      );
      const usdPrices =
        variantAfter?.prices.filter((p) => p.currency === 'USD') ?? [];
      expect(usdPrices).toHaveLength(1);
      expect(usdPrices[0].amountMinor).toBe('2000');

      // Additional currency coexists
      const eurRes = await call(
        'put',
        `/variants/${created.id}/price`,
        adminA,
        {
          currency: 'EUR',
          amountMinor: 999,
        },
      );
      expect(eurRes.status).toBe(200);
      const withTwo = (
        await call('get', `/products/${productAId}/variants`, adminA)
      ).body as unknown as ListBody;
      const two = withTwo.data.find((row) => row.id === created.id);
      expect(two?.prices).toHaveLength(2);

      // Delete cascades prices
      const delRes = await call('delete', `/variants/${created.id}`, adminA);
      expect(delRes.status).toBe(204);

      const afterDel = await call(
        'get',
        `/products/${productAId}/variants`,
        adminA,
      );
      expect(afterDel.status).toBe(200);
      const afterDelList = afterDel.body as unknown as ListBody;
      expect(afterDelList.data.some((row) => row.id === created.id)).toBe(
        false,
      );

      // Deleted variant's price is gone; further putPrice => 404
      expect(
        (
          await call('put', `/variants/${created.id}/price`, adminA, {
            currency: 'USD',
            amountMinor: 100,
          })
        ).status,
      ).toBe(404);
    });

    it('maps duplicate SKU in same tenant to 409', async () => {
      const sku = `DUP-${run}`;
      const first = await call(
        'post',
        `/products/${productAId}/variants`,
        adminA,
        { sku },
      );
      expect(first.status).toBe(201);
      const second = await call(
        'post',
        `/products/${productAId}/variants`,
        adminA,
        { sku },
      );
      expect(second.status).toBe(409);
      const error = second.body as unknown as ErrorBody;
      expect(error.message).toBe(
        'A variant with this SKU already exists in the tenant',
      );
    });

    it('allows same SKU in different tenants', async () => {
      const sku = `SHARED-${run}`;
      const inA = await call(
        'post',
        `/products/${productAId}/variants`,
        adminA,
        { sku },
      );
      expect(inA.status).toBe(201);
      const inB = await call(
        'post',
        `/products/${productBId}/variants`,
        adminB,
        { sku },
      );
      expect(inB.status).toBe(201);
    });

    it('returns 404 for unknown or cross-tenant product on create/list', async () => {
      const badList = await call(
        'get',
        `/products/no-such-${run}/variants`,
        adminA,
      );
      expect(badList.status).toBe(404);
      expect((badList.body as unknown as ErrorBody).message).toBe(
        'Product not found',
      );

      const foreignList = await call(
        'get',
        `/products/${productBId}/variants`,
        adminA,
      );
      expect(foreignList.status).toBe(404);

      const foreignCreate = await call(
        'post',
        `/products/${productBId}/variants`,
        adminA,
        {
          sku: `FK-${run}`,
        },
      );
      expect(foreignCreate.status).toBe(404);
    });

    it('returns 404 for unknown variant on patch/delete/price', async () => {
      const fake = `no-var-${run}`;
      expect(
        (await call('patch', `/variants/${fake}`, adminA, { name: 'X' }))
          .status,
      ).toBe(404);
      expect((await call('delete', `/variants/${fake}`, adminA)).status).toBe(
        404,
      );
      expect(
        (
          await call('put', `/variants/${fake}/price`, adminA, {
            currency: 'USD',
            amountMinor: 100,
          })
        ).status,
      ).toBe(404);
    });

    it('hides cross-tenant variants on patch/delete/price (IDOR 404)', async () => {
      const createdRes = await call(
        'post',
        `/products/${productBId}/variants`,
        adminB,
        {
          sku: `CROSS-${run}`,
        },
      );
      expect(createdRes.status).toBe(201);
      const foreign = createdRes.body as unknown as VariantBody;

      expect(
        (
          await call('patch', `/variants/${foreign.id}`, adminA, {
            name: 'Hijack',
          })
        ).status,
      ).toBe(404);
      expect(
        (await call('delete', `/variants/${foreign.id}`, adminA)).status,
      ).toBe(404);
      expect(
        (
          await call('put', `/variants/${foreign.id}/price`, adminA, {
            currency: 'USD',
            amountMinor: 100,
          })
        ).status,
      ).toBe(404);
      // Even listing under B's product from A's token is 404 (product IDOR).
      expect(
        (await call('get', `/products/${productBId}/variants`, adminA)).status,
      ).toBe(404);
    });
  });

  describe('RBAC matrix', () => {
    it('grants manage-only writes but never reads', async () => {
      expect(
        (await call('get', `/products/${productAId}/variants`, manageOnlyA))
          .status,
      ).toBe(403);
      const createdRes = await call(
        'post',
        `/products/${productAId}/variants`,
        manageOnlyA,
        {
          sku: `MO-${run}`,
        },
      );
      expect(createdRes.status).toBe(201);
      const created = createdRes.body as unknown as VariantBody;
      expect(
        (
          await call('put', `/variants/${created.id}/price`, manageOnlyA, {
            currency: 'USD',
            amountMinor: 500,
          })
        ).status,
      ).toBe(200);
      expect(
        (await call('delete', `/variants/${created.id}`, manageOnlyA)).status,
      ).toBe(204);
    });

    it('makes employee strictly read-only', async () => {
      const seededRes = await call(
        'post',
        `/products/${productAId}/variants`,
        adminA,
        {
          sku: `READ-${run}`,
        },
      );
      expect(seededRes.status).toBe(201);
      const seeded = seededRes.body as unknown as VariantBody;

      expect(
        (await call('get', `/products/${productAId}/variants`, employeeA))
          .status,
      ).toBe(200);
      expect(
        (
          await call('patch', `/variants/${seeded.id}`, employeeA, {
            name: 'Nope',
          })
        ).status,
      ).toBe(403);
      expect(
        (await call('delete', `/variants/${seeded.id}`, employeeA)).status,
      ).toBe(403);
      expect(
        (
          await call('put', `/variants/${seeded.id}/price`, employeeA, {
            currency: 'USD',
            amountMinor: 100,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call('post', `/products/${productAId}/variants`, employeeA, {
            sku: `NOPE-${run}`,
          })
        ).status,
      ).toBe(403);
    });

    it('gives owner semantic-all without grants', async () => {
      const createdRes = await call(
        'post',
        `/products/${productAId}/variants`,
        ownerA,
        {
          sku: `OWN-${run}`,
        },
      );
      expect(createdRes.status).toBe(201);
      const created = createdRes.body as unknown as VariantBody;
      expect(
        (await call('get', `/products/${productAId}/variants`, ownerA)).status,
      ).toBe(200);
      expect(
        (
          await call('patch', `/variants/${created.id}`, ownerA, {
            name: 'owner edit',
          })
        ).status,
      ).toBe(200);
      const priceRes = await call(
        'put',
        `/variants/${created.id}/price`,
        ownerA,
        {
          currency: 'USD',
          amountMinor: 777,
        },
      );
      expect(priceRes.status).toBe(200);
      expect(
        (await call('delete', `/variants/${created.id}`, ownerA)).status,
      ).toBe(204);
    });
  });

  describe('validation contract', () => {
    it('rejects invalid variant create payloads with 400', async () => {
      const invalids: Array<Record<string, unknown>> = [
        {},
        { sku: '' },
        { sku: 'x'.repeat(101) },
        { sku: 12 },
        { sku: 'OK', status: 'PUBLISHED' },
        { sku: 'OK', bogus: true },
      ];
      for (const payload of invalids) {
        const res = await call(
          'post',
          `/products/${productAId}/variants`,
          adminA,
          payload,
        );
        expect(res.status).toBe(400);
      }
    });

    it('rejects tenantId/productId injection on create and patch', async () => {
      expect(
        (
          await call('post', `/products/${productAId}/variants`, adminA, {
            sku: `INJ-${run}`,
            tenantId: tenantBId,
          })
        ).status,
      ).toBe(400);
      const seededRes = await call(
        'post',
        `/products/${productAId}/variants`,
        adminA,
        {
          sku: `GUARD-${run}`,
        },
      );
      expect(seededRes.status).toBe(201);
      const seeded = seededRes.body as unknown as VariantBody;
      expect(
        (
          await call('patch', `/variants/${seeded.id}`, adminA, {
            tenantId: tenantBId,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call('patch', `/variants/${seeded.id}`, adminA, {
            productId: productBId,
          })
        ).status,
      ).toBe(400);
      expect(
        (await call('patch', `/variants/${seeded.id}`, adminA, { id: 'new' }))
          .status,
      ).toBe(400);
    });

    it('rejects invalid price payloads with 400 (currency, amountMinor)', async () => {
      const vRes = await call(
        'post',
        `/products/${productAId}/variants`,
        adminA,
        {
          sku: `PRICE-VAL-${run}`,
        },
      );
      expect(vRes.status).toBe(201);
      const variant = vRes.body as unknown as VariantBody;

      const cases: Array<unknown> = [
        {},
        { currency: 'USD' },
        { amountMinor: 100 },
        { currency: 'usd', amountMinor: 100 },
        { currency: 'USDX', amountMinor: 100 },
        { currency: 'US', amountMinor: 100 },
        { currency: 12, amountMinor: 100 },
        { currency: 'USD', amountMinor: -1 },
        { currency: 'USD', amountMinor: 12.5 },
        { currency: 'USD', amountMinor: '100' },
        { currency: 'USD', amountMinor: Number.MAX_SAFE_INTEGER + 1 },
        { currency: 'USD', amountMinor: 100, variantId: 'x' },
      ];
      for (const payload of cases) {
        const res = await callRaw(
          'put',
          `/variants/${variant.id}/price`,
          adminA,
          payload,
        );
        expect(res.status).toBe(400);
      }
    });

    it('rejects unknown query fields and malformed cursors on list', async () => {
      expect(
        (
          await call(
            'get',
            `/products/${productAId}/variants?status=ACTIVE`,
            adminA,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await call(
            'get',
            `/products/${productAId}/variants?cursor=!!!not-base64!!!`,
            adminA,
          )
        ).status,
      ).toBe(400);
    });
  });

  describe('pagination envelope', () => {
    it('returns shared envelope and chains cursors asc/desc', async () => {
      // Dedicated tenant for exact counts.
      const pagTenant = await createTenant(`pag-var-${seq}`);
      const pagRole = await grantRole(pagTenant.id, `pag-var-admin-${run}`, [
        PERMISSIONS.PRODUCT_READ,
        PERMISSIONS.PRODUCT_CREATE,
        PERMISSIONS.PRODUCT_MANAGE,
      ]);
      const pagUser = await createUser(
        `pag-var-${run}-${seq}@a.test`,
        pagTenant.id,
        pagRole.id,
      );
      const pagHeaders = await loginAs(pagUser.id, pagTenant.id);
      const pagProduct = await createProductFixture(
        pagTenant.id,
        `PAG-${run}-${seq}`,
        `Pag ${run}`,
      );

      const skus = [
        `S1-${run}`,
        `S2-${run}`,
        `S3-${run}`,
        `S4-${run}`,
        `S5-${run}`,
      ];
      for (const sku of skus) {
        const r = await call(
          'post',
          `/products/${pagProduct.id}/variants`,
          pagHeaders,
          { sku },
        );
        expect(r.status).toBe(201);
      }

      const page1Res = await call(
        'get',
        `/products/${pagProduct.id}/variants?limit=2&order=asc`,
        pagHeaders,
      );
      expect(page1Res.status).toBe(200);
      expect(Object.keys(page1Res.body)).toEqual(['data', 'meta']);
      const page1 = page1Res.body as unknown as ListBody;
      expect(page1.data.map((row) => row.sku)).toEqual([
        `S1-${run}`,
        `S2-${run}`,
      ]);
      const cursor1 = page1.meta.nextCursor;
      if (!cursor1) throw new Error('expected page 1 nextCursor');

      const page2Res = await call(
        'get',
        `/products/${pagProduct.id}/variants?limit=2&order=asc&cursor=${encodeURIComponent(cursor1)}`,
        pagHeaders,
      );
      expect(page2Res.status).toBe(200);
      const page2 = page2Res.body as unknown as ListBody;
      expect(page2.data.map((row) => row.sku)).toEqual([
        `S3-${run}`,
        `S4-${run}`,
      ]);
      const cursor2 = page2.meta.nextCursor;
      if (!cursor2) throw new Error('expected page 2 nextCursor');

      const page3Res = await call(
        'get',
        `/products/${pagProduct.id}/variants?limit=2&order=asc&cursor=${encodeURIComponent(cursor2)}`,
        pagHeaders,
      );
      expect(page3Res.status).toBe(200);
      const page3 = page3Res.body as unknown as ListBody;
      expect(page3.data.map((row) => row.sku)).toEqual([`S5-${run}`]);
      expect(page3.meta.nextCursor).toBeNull();

      const descRes = await call(
        'get',
        `/products/${pagProduct.id}/variants?limit=2&order=desc`,
        pagHeaders,
      );
      expect(descRes.status).toBe(200);
      const descPage = descRes.body as unknown as ListBody;
      expect(descPage.data.map((row) => row.sku)).toEqual([
        `S5-${run}`,
        `S4-${run}`,
      ]);
    });
  });

  describe('cascade and product relationship protection', () => {
    it('cascades variant delete -> prices, and product delete -> variants+prices', async () => {
      const vRes = await call(
        'post',
        `/products/${productAId}/variants`,
        adminA,
        {
          sku: `CASC-${run}`,
        },
      );
      expect(vRes.status).toBe(201);
      const variant = vRes.body as unknown as VariantBody;
      const priceRes = await call(
        'put',
        `/variants/${variant.id}/price`,
        adminA,
        {
          currency: 'USD',
          amountMinor: 100,
        },
      );
      expect(priceRes.status).toBe(200);

      // Variant delete removes its price.
      expect(
        (await call('delete', `/variants/${variant.id}`, adminA)).status,
      ).toBe(204);
      const priceCountAfterVariantDelete = await tenantContext.run(
        tenantAId,
        async () => prisma.price.count({ where: { variantId: variant.id } }),
      );
      expect(priceCountAfterVariantDelete).toBe(0);

      // New variant + price under a dedicated product, then delete product.
      const tempProduct = await createProductFixture(
        tenantAId,
        `CASC-PROD-${run}-${seq}`,
        `Casc Prod ${run}`,
      );
      const v2Res = await call(
        'post',
        `/products/${tempProduct.id}/variants`,
        adminA,
        {
          sku: `CASC2-${run}`,
        },
      );
      expect(v2Res.status).toBe(201);
      const v2 = v2Res.body as unknown as VariantBody;
      const p2Res = await call('put', `/variants/${v2.id}/price`, adminA, {
        currency: 'USD',
        amountMinor: 50,
      });
      expect(p2Res.status).toBe(200);

      const delProdRes = await call(
        'delete',
        `/products/${tempProduct.id}`,
        adminA,
      );
      expect(delProdRes.status).toBe(204);

      const variantCountAfterProductDelete = await tenantContext.run(
        tenantAId,
        async () =>
          prisma.productVariant.count({ where: { productId: tempProduct.id } }),
      );
      expect(variantCountAfterProductDelete).toBe(0);
      const priceCountAfterProductDelete = await tenantContext.run(
        tenantAId,
        async () => prisma.price.count({ where: { variantId: v2.id } }),
      );
      expect(priceCountAfterProductDelete).toBe(0);

      // Listing variants of deleted product -> 404
      expect(
        (await call('get', `/products/${tempProduct.id}/variants`, adminA))
          .status,
      ).toBe(404);
    });
  });
});
