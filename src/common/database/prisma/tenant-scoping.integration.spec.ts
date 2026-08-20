import { INestApplication, InternalServerErrorException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../../app.module';
import { PrismaService } from './prisma.service';
import { TenantContextService } from '../../tenant-context/tenant-context.service';

describe('Central Prisma tenant scoping (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantContext: TenantContextService;

  const run = `scope-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const tenantIdsToDelete: string[] = [];

  let tenantAId: string;
  let tenantBId: string;
  let storeA1Id: string;
  let storeB1Id: string;

  const readStore = (id: string, tenantId: string) =>
    tenantContext.run(tenantId, async () =>
      prisma.store.findUnique({ where: { id } }),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tenantContext = moduleRef.get(TenantContextService);
  });

  beforeAll(async () => {
    // Global models are created without any tenant context.
    const tenantA = await prisma.tenant.create({
      data: { name: 'Tenant A', slug: `${run}-a` },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: 'Tenant B', slug: `${run}-b` },
    });
    tenantIdsToDelete.push(tenantA.id, tenantB.id);
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    // Tenant-scoped rows are created while acting as their own tenant.
    const storeA1 = await tenantContext.run(tenantAId, async () =>
      prisma.store.create({
        data: { tenantId: tenantAId, name: 'Store A1', code: `${run}-a1` },
      }),
    );
    const storeB1 = await tenantContext.run(tenantBId, async () =>
      prisma.store.create({
        data: { tenantId: tenantBId, name: 'Store B1', code: `${run}-b1` },
      }),
    );
    storeA1Id = storeA1.id;
    storeB1Id = storeB1.id;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.tenant
        .deleteMany({ where: { id: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
    }
    if (app) {
      await app.close();
    }
  });

  it('Tenant A context: Store.findMany returns only Tenant A stores', async () => {
    const stores = await tenantContext.run(tenantAId, async () =>
      prisma.store.findMany(),
    );

    expect(stores.map((store) => store.id)).toEqual([storeA1Id]);
  });

  it('Tenant B context: Store.findMany returns only Tenant B stores', async () => {
    const stores = await tenantContext.run(tenantBId, async () =>
      prisma.store.findMany(),
    );

    expect(stores.map((store) => store.id)).toEqual([storeB1Id]);
  });

  it('Tenant A context cannot findUnique a Tenant B store', async () => {
    const store = await tenantContext.run(tenantAId, async () =>
      prisma.store.findUnique({ where: { id: storeB1Id } }),
    );

    expect(store).toBeNull();
  });

  it('propagates TenantContext inside interactive transactions', async () => {
    const stores = await tenantContext.run(tenantAId, async () =>
      prisma.$transaction(async (tx) => {
        expect(tenantContext.requireTenantId()).toBe(tenantAId);
        return tx.store.findMany();
      }),
    );

    expect(stores.map((store) => store.id)).toEqual([storeA1Id]);
  });

  it('scopes array transactions to the tenant context', async () => {
    const [count] = await tenantContext.run(tenantAId, async () =>
      prisma.$transaction([prisma.store.count()]),
    );

    expect(count).toBe(1);
  });

  it('Tenant A context cannot update a Tenant B store', async () => {
    await expect(
      tenantContext.run(tenantAId, async () =>
        prisma.store.update({
          where: { id: storeB1Id },
          data: { name: 'Hacked' },
        }),
      ),
    ).rejects.toThrow();

    const b1 = await readStore(storeB1Id, tenantBId);
    expect(b1?.name).toBe('Store B1');
  });

  it('Tenant A context cannot delete a Tenant B store', async () => {
    await expect(
      tenantContext.run(tenantAId, async () =>
        prisma.store.delete({ where: { id: storeB1Id } }),
      ),
    ).rejects.toThrow();

    const b1 = await readStore(storeB1Id, tenantBId);
    expect(b1).not.toBeNull();
  });

  it('Tenant A context cannot create a store for Tenant B (tenantId forced from context)', async () => {
    const created = await tenantContext.run(tenantAId, async () =>
      prisma.store.create({
        data: {
          name: 'Forced',
          code: `${run}-forced`,
          tenantId: tenantBId,
        },
      }),
    );

    expect(created.tenantId).toBe(tenantAId);

    const b1 = await readStore(storeB1Id, tenantBId);
    expect(b1).not.toBeNull();
  });

  it('Tenant A context cannot updateMany Tenant B records', async () => {
    const result = await tenantContext.run(tenantAId, async () =>
      prisma.store.updateMany({
        where: { id: { in: [storeB1Id] } },
        data: { name: 'Hacked Many' },
      }),
    );

    expect(result.count).toBe(0);

    const b1 = await readStore(storeB1Id, tenantBId);
    expect(b1?.name).toBe('Store B1');
  });

  it('Tenant A context cannot deleteMany Tenant B records', async () => {
    const result = await tenantContext.run(tenantAId, async () =>
      prisma.store.deleteMany({ where: { id: { in: [storeB1Id] } } }),
    );

    expect(result.count).toBe(0);

    const b1 = await readStore(storeB1Id, tenantBId);
    expect(b1).not.toBeNull();
  });

  it('Tenant A context cannot upsert a Tenant B record (scoped where cannot match it)', async () => {
    await tenantContext.run(tenantAId, async () =>
      prisma.store.upsert({
        where: { id: storeB1Id },
        create: {
          name: 'Upserted',
          code: `${run}-upserted`,
          tenantId: tenantAId,
        },
        update: { name: 'Hacked Upsert' },
      }),
    );

    const b1 = await readStore(storeB1Id, tenantBId);
    expect(b1?.name).toBe('Store B1');
  });

  it('RolePermission is an internal RBAC relation, NOT a tenant-scoped model', async () => {
    const permission = await prisma.permission.create({
      data: { key: `${run}-perm-read`, name: 'Read' },
    });
    const role = await tenantContext.run(tenantAId, async () =>
      prisma.role.create({
        data: {
          tenantId: tenantAId,
          key: `${run}-role-with-perm`,
          name: 'Role with perm',
        },
      }),
    );

    // Pass-through: no TenantContext is required, so RolePermission is NOT
    // fail-closed and NOT automatically tenant-isolated.
    const join = await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    const joins = await prisma.rolePermission.findMany({
      where: { roleId: role.id },
    });

    expect(join.roleId).toBe(role.id);
    expect(joins.map((j) => j.permissionId)).toContain(permission.id);

    // The intended access path: reach RolePermission only through a
    // tenant-resolved Role (Role IS scoped, so the lookup is tenant-bound).
    const scopedRole = await tenantContext.run(tenantAId, async () =>
      prisma.role.findUnique({
        where: { id: role.id },
        include: { permissions: { include: { permission: true } } },
      }),
    );

    expect(scopedRole?.id).toBe(role.id);
    expect(scopedRole?.permissions.map((p) => p.permission.key)).toContain(
      `${run}-perm-read`,
    );

    await prisma.rolePermission
      .deleteMany({ where: { roleId: role.id } })
      .catch(() => undefined);
    await prisma.permission
      .delete({ where: { id: permission.id } })
      .catch(() => undefined);
  });

  it('include/select traversal from a global model is NOT filtered', async () => {
    const user = await prisma.user.create({
      data: { email: `traverse-${run}@example.com` },
    });
    const roleA = await tenantContext.run(tenantAId, async () =>
      prisma.role.create({
        data: { tenantId: tenantAId, key: `${run}-trav-a`, name: 'Trav A' },
      }),
    );
    const roleB = await tenantContext.run(tenantBId, async () =>
      prisma.role.create({
        data: { tenantId: tenantBId, key: `${run}-trav-b`, name: 'Trav B' },
      }),
    );
    await tenantContext.run(tenantAId, async () =>
      prisma.membership.create({
        data: { userId: user.id, tenantId: tenantAId, roleId: roleA.id },
      }),
    );
    await tenantContext.run(tenantBId, async () =>
      prisma.membership.create({
        data: { userId: user.id, tenantId: tenantBId, roleId: roleB.id },
      }),
    );

    // A global User query with include returns memberships from EVERY tenant.
    const withMemberships = await prisma.user.findUnique({
      where: { id: user.id },
      include: { memberships: true },
    });

    expect(withMemberships?.memberships.map((m) => m.tenantId).sort()).toEqual(
      [tenantAId, tenantBId].sort(),
    );

    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  });

  it('raw SQL bypasses tenant scoping (hard rule)', async () => {
    const allStores = await prisma.$queryRaw<
      Array<{ id: string; tenantId: string }>
    >`SELECT "id", "tenantId" FROM "Store"`;
    const allIds = allStores.map((s) => s.id);

    // The unscoped raw query sees stores from BOTH tenants.
    expect(allIds).toContain(storeA1Id);
    expect(allIds).toContain(storeB1Id);

    // Safe pattern: the SQL explicitly applies the tenant id.
    const tenantAStores = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Store" WHERE "tenantId" = ${tenantAId}
    `;
    expect(tenantAStores.map((s) => s.id)).toContain(storeA1Id);
  });

  it('tenant-scoped operations must be awaited inside the run() callback', async () => {
    // Safe pattern: async callback awaits inside run() — context propagates
    // and the query is scoped to Tenant A only.
    const scoped = await tenantContext.run(tenantAId, async () =>
      prisma.store.findMany(),
    );
    expect(scoped.map((s) => s.id)).toContain(storeA1Id);
    expect(scoped.map((s) => s.id)).not.toContain(storeB1Id);

    // Anti-pattern: returning the deferred PrismaPromise from the callback
    // executes the query OUTSIDE the AsyncLocalStorage context and fails
    // closed.
    await expect(
      tenantContext.run(tenantAId, () => prisma.store.findMany()),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('fails closed: tenant-scoped operation without TenantContext throws', async () => {
    await expect(prisma.store.findMany()).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    await expect(prisma.role.findMany()).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    await expect(prisma.membership.findMany()).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('global User queries work without TenantContext', async () => {
    await expect(prisma.user.findMany()).resolves.toBeDefined();
    await expect(prisma.user.count()).resolves.toBeGreaterThanOrEqual(0);
  });

  it('global Tenant queries work without TenantContext', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantAId } });

    expect(tenant?.name).toBe('Tenant A');
  });
});
