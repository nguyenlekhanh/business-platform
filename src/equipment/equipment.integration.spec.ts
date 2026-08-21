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

describe('Equipment administration (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  interface ErrorBody {
    message?: string | string[];
    statusCode?: number;
  }

  interface EquipmentBody {
    id: string;
    tenantId: string;
    assetId: string;
    type: string;
    manufacturer: string | null;
    model: string | null;
    serialNumber: string | null;
    year: number | null;
  }

  interface PaginatedBody {
    data: EquipmentBody[];
    meta: { nextCursor: string | null };
  }

  const run = `equip-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const equipmentIdsToDelete: string[] = [];
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
  let adminRoleAId: string;
  let managerRoleId: string;
  let assetPreAId: string;
  let assetBId: string;
  let equipAId: string;
  let equipBId: string;

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

    tenantAId = await createTenant('Equipment Tenant A');
    tenantBId = await createTenant('Equipment Tenant B');

    // Tenant A roles.
    const ownerRoleA = await createRole(tenantAId, 'owner', 'Owner', true);
    adminRoleAId = (await createRole(tenantAId, 'admin', 'Admin', true)).id;
    const employeeRoleA = await createRole(
      tenantAId,
      'employee',
      'Employee',
      true,
    );
    // Manage-only custom role: exercises that equipment:manage covers writes
    // but must NOT implicitly grant GET (GET requires equipment:read).
    managerRoleId = (
      await createRole(tenantAId, `fleetmgr-${run}`, 'FleetManager')
    ).id;

    await grant(adminRoleAId, PERMISSIONS.EQUIPMENT_READ);
    await grant(adminRoleAId, PERMISSIONS.EQUIPMENT_CREATE);
    await grant(adminRoleAId, PERMISSIONS.EQUIPMENT_UPDATE);
    await grant(adminRoleAId, PERMISSIONS.EQUIPMENT_DELETE);
    await grant(employeeRoleA.id, PERMISSIONS.EQUIPMENT_READ);
    await grant(managerRoleId, PERMISSIONS.EQUIPMENT_MANAGE);

    await createMembership(ownerA, tenantAId, ownerRoleA.id);
    await createMembership(adminA, tenantAId, adminRoleAId);
    await createMembership(employeeA, tenantAId, employeeRoleA.id);
    await createMembership(managerA, tenantAId, managerRoleId);

    // Tenant B roles: full equipment grants mirroring tenant A.
    const adminRoleB = await createRole(tenantBId, 'admin', 'Admin', true);
    await grant(adminRoleB.id, PERMISSIONS.EQUIPMENT_READ);
    await grant(adminRoleB.id, PERMISSIONS.EQUIPMENT_CREATE);
    await grant(adminRoleB.id, PERMISSIONS.EQUIPMENT_UPDATE);
    await grant(adminRoleB.id, PERMISSIONS.EQUIPMENT_DELETE);
    await createMembership(adminB, tenantBId, adminRoleB.id);

    // Baseline assets.
    assetPreAId = (
      await createAssetDirect(
        tenantAId,
        'Preexisting Crane',
        `${run}-pre`,
        'crane',
      )
    ).id;
    assetBId = (
      await createAssetDirect(tenantBId, 'B Forklift', `${run}-b`, 'forklift')
    ).id;

    // Baseline equipment through the API (also exercises the create path).
    const resA = await send(
      'post',
      '/equipment',
      await tokenFor(adminA),
      tenantAId,
      { assetId: assetPreAId, type: 'CRANE' },
    );
    expect(resA.status).toBe(201);
    equipAId = (resA.body as EquipmentBody).id;
    equipmentIdsToDelete.push(equipAId);

    const resB = await send(
      'post',
      '/equipment',
      await tokenFor(adminB),
      tenantBId,
      { assetId: assetBId, type: 'FORKLIFT' },
    );
    expect(resB.status).toBe(201);
    equipBId = (resB.body as EquipmentBody).id;
    equipmentIdsToDelete.push(equipBId);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.equipment
        .deleteMany({ where: { id: { in: equipmentIdsToDelete } } })
        .catch(() => undefined);
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

  describe('listing equipment', () => {
    it('list with equipment:read -> 200 envelope', async () => {
      const res = await get('/equipment', await tokenFor(adminA), tenantAId);
      expect(res.status).toBe(200);
      const body = res.body as PaginatedBody;
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.some((e) => e.id === equipAId)).toBe(true);
    });

    it('lists only the active tenant equipment (cross-tenant list isolation)', async () => {
      const listB = await get('/equipment', await tokenFor(adminB), tenantBId);
      expect(listB.status).toBe(200);
      const bodyB = listB.body as PaginatedBody;
      expect(bodyB.data.some((e) => e.id === equipAId)).toBe(false);
      expect(bodyB.data.some((e) => e.id === equipBId)).toBe(true);

      const listA = await get('/equipment', await tokenFor(adminA), tenantAId);
      expect(listA.status).toBe(200);
      const bodyA = listA.body as PaginatedBody;
      expect(bodyA.data.some((e) => e.id === equipBId)).toBe(false);
    });

    it('insufficient permission -> 403', async () => {
      const nobody = await createUser(`nobody-${run}@example.com`);
      const nobodyRole = await createRole(
        tenantAId,
        `nobody-${run}`,
        'NoPerms',
      );
      await createMembership(nobody, tenantAId, nobodyRole.id);

      const res = await get('/equipment', await tokenFor(nobody), tenantAId);
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
        qs ? `/equipment?${qs}` : '/equipment',
        await tokenFor(userId),
        tenantId,
      );
      return { res, body: res.body as PaginatedBody };
    };

    it('walks pages deterministically with limit 2', async () => {
      const created: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const asset = await createAssetDirect(
          tenantAId,
          `Paged Equip Asset ${i}`,
          `${run}-pe-${i}`,
          'paged-equip',
        );
        assetIdsToDelete.push(asset.id);
        const res = await send(
          'post',
          '/equipment',
          await tokenFor(adminA),
          tenantAId,
          { assetId: asset.id, type: 'FORKLIFT' },
        );
        expect(res.status).toBe(201);
        created.push((res.body as EquipmentBody).id);
        equipmentIdsToDelete.push(created[i]);
      }

      const collected: string[] = [];
      let cursor: string | null | undefined;
      do {
        const q: Record<string, string> = { type: 'FORKLIFT', limit: '2' };
        if (cursor) {
          q.cursor = cursor;
        }
        const { body } = await listQuery(q);
        for (const row of body.data) {
          expect(row.type).toBe('FORKLIFT');
        }
        collected.push(...body.data.map((e) => e.id));
        cursor = body.meta.nextCursor;
      } while (cursor);
      // All five fixtures present exactly once.
      for (const id of created) {
        expect(collected.filter((x) => x === id)).toHaveLength(1);
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

  describe('single equipment', () => {
    it('get equipment -> 200', async () => {
      const res = await get(
        `/equipment/${equipAId}`,
        await tokenFor(adminA),
        tenantAId,
      );
      expect(res.status).toBe(200);
      const body = res.body as EquipmentBody;
      expect(body.id).toBe(equipAId);
      expect(body.assetId).toBe(assetPreAId);
      expect(body.type).toBe('CRANE');
    });

    it('get missing equipment -> 404', async () => {
      const res = await get(
        '/equipment/non-existent-equipment',
        await tokenFor(adminA),
        tenantAId,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('create equipment', () => {
    it('minimal crane record -> 201', async () => {
      const asset = await createAssetDirect(
        tenantAId,
        'Crane Two',
        `${run}-crane2`,
        'crane',
      );
      const res = await send(
        'post',
        '/equipment',
        await tokenFor(adminA),
        tenantAId,
        { assetId: asset.id, type: 'CRANE' },
      );
      expect(res.status).toBe(201);
      const body = res.body as EquipmentBody;
      expect(body.tenantId).toBe(tenantAId);
      expect(body.assetId).toBe(asset.id);
      expect(body.type).toBe('CRANE');
      expect(body.serialNumber).toBeNull();
      equipmentIdsToDelete.push(body.id);
    });

    it('full excavator identity -> 201 echoes all fields', async () => {
      const asset = await createAssetDirect(
        tenantAId,
        'Digger One',
        `${run}-dig1`,
        'excavator',
      );
      const res = await send(
        'post',
        '/equipment',
        await tokenFor(adminA),
        tenantAId,
        {
          assetId: asset.id,
          type: 'EXCAVATOR',
          manufacturer: 'Komatsu',
          model: 'PC210',
          serialNumber: `${run}-SN-PC210`,
          year: 2021,
        },
      );
      expect(res.status).toBe(201);
      const body = res.body as EquipmentBody;
      expect(body.manufacturer).toBe('Komatsu');
      expect(body.model).toBe('PC210');
      expect(body.serialNumber).toBe(`${run}-SN-PC210`);
      expect(body.year).toBe(2021);
      equipmentIdsToDelete.push(body.id);
    });

    it('invalid equipment type -> 400', async () => {
      const res = await send(
        'post',
        '/equipment',
        await tokenFor(adminA),
        tenantAId,
        { assetId: assetPreAId, type: 'BOBCAT' },
      );
      expect(res.status).toBe(400);
    });

    it('nonexistent asset -> 404', async () => {
      const res = await send(
        'post',
        '/equipment',
        await tokenFor(adminA),
        tenantAId,
        { assetId: 'non-existent-asset', type: 'CRANE' },
      );
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Asset not found');
    });

    it('foreign-tenant asset attachment -> 404 (no existence leak)', async () => {
      // Tenant B admin tries to attach equipment to tenant A's asset: the
      // tenant-scoped lookup resolves null -> 404 before any write.
      const res = await send(
        'post',
        '/equipment',
        await tokenFor(adminB),
        tenantBId,
        { assetId: assetPreAId, type: 'CRANE' },
      );
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Asset not found');
    });

    it('duplicate asset attachment -> 409 (1:1 enforced)', async () => {
      const res = await send(
        'post',
        '/equipment',
        await tokenFor(adminA),
        tenantAId,
        { assetId: assetPreAId, type: 'EXCAVATOR' },
      );
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe(
        'This asset already has an equipment record',
      );
    });

    it('rejects a client-supplied tenantId with 400', async () => {
      const res = await send(
        'post',
        '/equipment',
        await tokenFor(adminA),
        tenantAId,
        { assetId: assetPreAId, type: 'CRANE', tenantId: 'tenant-9' },
      );
      // forbidNonWhitelisted rejects non-DTO properties before the service.
      expect(res.status).toBe(400);
    });

    it('rejects arbitrary privilege fields (roleId/permissionIds) with 400', async () => {
      const res = await send(
        'post',
        '/equipment',
        await tokenFor(adminA),
        tenantAId,
        {
          assetId: assetPreAId,
          type: 'CRANE',
          roleId: 'role-9',
          permissionIds: ['perm-1'],
        },
      );
      expect(res.status).toBe(400);
    });

    it('rejects a storeId field with 400 (store lives on Asset, not Equipment)', async () => {
      const res = await send(
        'post',
        '/equipment',
        await tokenFor(adminA),
        tenantAId,
        { assetId: assetPreAId, type: 'CRANE', storeId: 'store-9' },
      );
      expect(res.status).toBe(400);
    });
  });

  describe('serial number constraints', () => {
    it('duplicate serial number within the tenant -> 409', async () => {
      const serial = `${run}-SN-DUP`;
      const assetOne = await createAssetDirect(
        tenantAId,
        'Serial One',
        `${run}-sn1`,
        'crane',
      );
      const first = await send(
        'post',
        '/equipment',
        await tokenFor(adminA),
        tenantAId,
        { assetId: assetOne.id, type: 'CRANE', serialNumber: serial },
      );
      expect(first.status).toBe(201);
      equipmentIdsToDelete.push((first.body as EquipmentBody).id);

      const assetTwo = await createAssetDirect(
        tenantAId,
        'Serial Two',
        `${run}-sn2`,
        'crane',
      );
      const second = await send(
        'post',
        '/equipment',
        await tokenFor(adminA),
        tenantAId,
        { assetId: assetTwo.id, type: 'CRANE', serialNumber: serial },
      );
      expect(second.status).toBe(409);
      expect((second.body as ErrorBody).message).toContain(
        'serial number already exists in the tenant',
      );
    });

    it('same serial number remains independently valid in another tenant', async () => {
      const serial = `${run}-SN-CROSS`;
      const assetA = await createAssetDirect(
        tenantAId,
        'Cross A',
        `${run}-crossa`,
        'crane',
      );
      const inA = await send(
        'post',
        '/equipment',
        await tokenFor(adminA),
        tenantAId,
        { assetId: assetA.id, type: 'CRANE', serialNumber: serial },
      );
      expect(inA.status).toBe(201);
      equipmentIdsToDelete.push((inA.body as EquipmentBody).id);

      const assetB = await createAssetDirect(
        tenantBId,
        'Cross B',
        `${run}-crossb`,
        'crane',
      );
      const inB = await send(
        'post',
        '/equipment',
        await tokenFor(adminB),
        tenantBId,
        { assetId: assetB.id, type: 'FORKLIFT', serialNumber: serial },
      );
      expect(inB.status).toBe(201);
      expect((inB.body as EquipmentBody).tenantId).toBe(tenantBId);
      equipmentIdsToDelete.push((inB.body as EquipmentBody).id);
    });
  });

  describe('update equipment', () => {
    it('update identity fields -> 200', async () => {
      const res = await send(
        'put',
        `/equipment/${equipAId}`,
        await tokenFor(adminA),
        tenantAId,
        { manufacturer: 'Liebherr', year: 2020 },
      );
      expect(res.status).toBe(200);
      const body = res.body as EquipmentBody;
      expect(body.manufacturer).toBe('Liebherr');
      expect(body.year).toBe(2020);
    });

    it('re-parenting via assetId is rejected with 400 (link immutable)', async () => {
      const res = await send(
        'put',
        `/equipment/${equipAId}`,
        await tokenFor(adminA),
        tenantAId,
        { assetId: assetBId },
      );
      expect(res.status).toBe(400);
    });
  });

  describe('delete equipment', () => {
    it('delete -> 204 and scoped lookup confirms removal', async () => {
      const asset = await createAssetDirect(
        tenantAId,
        'To Detach',
        `${run}-detach`,
        'excavator',
      );
      const created = await send(
        'post',
        '/equipment',
        await tokenFor(adminA),
        tenantAId,
        { assetId: asset.id, type: 'EXCAVATOR' },
      );
      const id = (created.body as EquipmentBody).id;

      const res = await send(
        'delete',
        `/equipment/${id}`,
        await tokenFor(adminA),
        tenantAId,
      );
      expect(res.status).toBe(204);

      const gone = await tenantContext.run(tenantAId, async () =>
        prisma.equipment.findUnique({ where: { id } }),
      );
      expect(gone).toBeNull();
    });
  });

  describe('asset/store relationship semantics', () => {
    it('equipment can attach to an asset that references a same-tenant store', async () => {
      // Store isolation itself is enforced and tested at the Asset layer
      // (Phase 2D): foreign storeId -> 404. Equipment inherits this because
      // it carries NO store reference of its own and cannot alter one.
      const store = await tenantContext.run(tenantAId, async () =>
        prisma.store
          .create({
            data: {
              tenantId: tenantAId,
              name: 'Equip Store',
              code: `${run}-es`,
              type: 'GENERAL',
              settings: {},
            },
          })
          .then((s) => {
            storeIdsToDelete.push(s.id);
            return s;
          }),
      );
      const stored = await tenantContext.run(tenantAId, async () =>
        prisma.asset
          .create({
            data: {
              tenantId: tenantAId,
              name: 'Stored Crane',
              code: `${run}-stored`,
              type: 'crane',
              storeId: store.id,
            },
          })
          .then((a) => {
            assetIdsToDelete.push(a.id);
            return a;
          }),
      );

      const res = await send(
        'post',
        '/equipment',
        await tokenFor(adminA),
        tenantAId,
        { assetId: stored.id, type: 'CRANE' },
      );
      expect(res.status).toBe(201);
      equipmentIdsToDelete.push((res.body as EquipmentBody).id);
    });
  });

  describe('IDOR protection (no tenant data leakage)', () => {
    it('cross-tenant equipment GET -> 404', async () => {
      const res = await get(
        `/equipment/${equipAId}`,
        await tokenFor(adminB),
        tenantBId,
      );
      expect(res.status).toBe(404);
    });

    it('cross-tenant equipment PUT -> 404', async () => {
      const res = await send(
        'put',
        `/equipment/${equipAId}`,
        await tokenFor(adminB),
        tenantBId,
        { manufacturer: 'Hacked' },
      );
      expect(res.status).toBe(404);
    });

    it('cross-tenant equipment DELETE -> 404', async () => {
      const res = await send(
        'delete',
        `/equipment/${equipAId}`,
        await tokenFor(adminB),
        tenantBId,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('authorization matrix', () => {
    it('equipment:manage alone can create/update/delete but NOT read (GET -> 403)', async () => {
      const asset = await createAssetDirect(
        tenantAId,
        'Managed Unit',
        `${run}-managed`,
        'forklift',
      );

      const createRes = await send(
        'post',
        '/equipment',
        await tokenFor(managerA),
        tenantAId,
        { assetId: asset.id, type: 'FORKLIFT' },
      );
      expect(createRes.status).toBe(201);
      const id = (createRes.body as EquipmentBody).id;
      equipmentIdsToDelete.push(id);

      const updRes = await send(
        'put',
        `/equipment/${id}`,
        await tokenFor(managerA),
        tenantAId,
        { model: 'H200' },
      );
      expect(updRes.status).toBe(200);

      const delRes = await send(
        'delete',
        `/equipment/${id}`,
        await tokenFor(managerA),
        tenantAId,
      );
      expect(delRes.status).toBe(204);

      // GET requires equipment:read; equipment:manage must NOT imply it.
      const listRes = await get(
        '/equipment',
        await tokenFor(managerA),
        tenantAId,
      );
      expect(listRes.status).toBe(403);

      const getRes = await get(
        `/equipment/${equipAId}`,
        await tokenFor(managerA),
        tenantAId,
      );
      expect(getRes.status).toBe(403);
    });

    it('read-only member can GET but not create (403)', async () => {
      const getRes = await get(
        `/equipment/${equipAId}`,
        await tokenFor(employeeA),
        tenantAId,
      );
      expect(getRes.status).toBe(200);

      const postRes = await send(
        'post',
        '/equipment',
        await tokenFor(employeeA),
        tenantAId,
        { assetId: assetPreAId, type: 'CRANE' },
      );
      expect(postRes.status).toBe(403);
    });

    it('owner semantic-all -> CRUD succeeds without explicit equipment grants', async () => {
      const asset = await createAssetDirect(
        tenantAId,
        'Owner Unit',
        `${run}-owner`,
        'crane',
      );
      const res = await send(
        'post',
        '/equipment',
        await tokenFor(ownerA),
        tenantAId,
        { assetId: asset.id, type: 'CRANE' },
      );
      expect(res.status).toBe(201);
      equipmentIdsToDelete.push((res.body as EquipmentBody).id);
    });
  });

  describe('auth / tenant state gating', () => {
    it('invalid JWT -> 401', async () => {
      const res = await send('post', '/equipment', 'not-a-jwt', tenantAId, {
        assetId: assetPreAId,
        type: 'CRANE',
      });
      expect(res.status).toBe(401);
    });

    it('missing tenant header -> 400', async () => {
      const res = await send('post', '/equipment', await tokenFor(adminA), '', {
        assetId: assetPreAId,
        type: 'CRANE',
      });
      expect(res.status).toBe(400);
    });

    it('suspended membership actor -> 403', async () => {
      const suspended = await createUser(`eq-suspended-${run}@example.com`);
      await createMembership(suspended, tenantAId, adminRoleAId, 'SUSPENDED');

      const res = await send(
        'post',
        '/equipment',
        await tokenFor(suspended),
        tenantAId,
        { assetId: assetPreAId, type: 'CRANE' },
      );
      expect(res.status).toBe(403);
    });

    it('inactive tenant -> 403', async () => {
      const inactiveTenant = await createTenant('Inactive Equipment Tenant');
      await prisma.tenant.update({
        where: { id: inactiveTenant },
        data: { status: 'SUSPENDED' },
      });

      const res = await send(
        'post',
        '/equipment',
        await tokenFor(adminA),
        inactiveTenant,
        { assetId: assetPreAId, type: 'CRANE' },
      );
      expect(res.status).toBe(403);
    });
  });

  describe('response safety', () => {
    it('returns exactly the safe EquipmentSummary projection', async () => {
      const res = await get(
        `/equipment/${equipBId}`,
        await tokenFor(adminB),
        tenantBId,
      );
      expect(res.status).toBe(200);
      expect(Object.keys(res.body as object).sort()).toEqual([
        'assetId',
        'createdAt',
        'id',
        'manufacturer',
        'model',
        'serialNumber',
        'tenantId',
        'type',
        'updatedAt',
        'year',
      ]);
    });
  });
});
