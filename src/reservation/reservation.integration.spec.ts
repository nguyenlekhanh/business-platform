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

describe('Reservation administration (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  interface ErrorBody {
    message?: string | string[];
    statusCode?: number;
  }

  interface ReservationBody {
    id: string;
    tenantId: string;
    customerId: string;
    equipmentId: string;
    startAt: string;
    endAt: string;
    status: string;
    notes: string | null;
  }

  interface PaginatedBody {
    data: ReservationBody[];
    meta: { nextCursor: string | null };
  }

  const run = `resv-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const reservationIdsToDelete: string[] = [];
  const equipmentIdsToDelete: string[] = [];
  const assetIdsToDelete: string[] = [];
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
  let customerAId: string;
  let customerBId: string;
  let equipAId: string;
  let equipA2Id: string;
  let equipBId: string;
  let resvAId: string;
  let resvBId: string;

  // Time windows are derived from a run-unique base so repeated test runs can
  // never collide with leftover rows through the exclusion constraint.
  const base = Date.now() + 24 * 60 * 60 * 1000;
  const iso = (offsetHours: number) =>
    new Date(base + offsetHours * 60 * 60 * 1000).toISOString();
  // Baseline window far away from the small offsets used by tests.
  const BASE_START = iso(500);
  const BASE_END = iso(504);

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

  const createAssetDirect = (tenantId: string, code: string) =>
    tenantContext.run(tenantId, async () =>
      prisma.asset
        .create({
          data: { tenantId, name: `Asset ${code}`, code, type: 'crane' },
        })
        .then((asset) => {
          assetIdsToDelete.push(asset.id);
          return asset;
        }),
    );

  const createEquipmentDirect = (
    tenantId: string,
    assetId: string,
    type: 'CRANE' | 'FORKLIFT',
  ) =>
    tenantContext.run(tenantId, async () =>
      prisma.equipment
        .create({ data: { tenantId, assetId, type } })
        .then((equipment) => {
          equipmentIdsToDelete.push(equipment.id);
          return equipment;
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

  const postReservation = async (
    token: string,
    tenantId: string,
    body: Record<string, unknown>,
  ) => send('post', '/reservations', token, tenantId, body);

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

    tenantAId = await createTenant('Reservation Tenant A');
    tenantBId = await createTenant('Reservation Tenant B');

    // Tenant A roles.
    const ownerRoleA = await createRole(tenantAId, 'owner', 'Owner', true);
    adminRoleAId = (await createRole(tenantAId, 'admin', 'Admin', true)).id;
    const employeeRoleA = await createRole(
      tenantAId,
      'employee',
      'Employee',
      true,
    );
    // Manage-only custom role: exercises that reservation:manage covers
    // writes but must NOT implicitly grant GET (GET requires
    // reservation:read).
    managerRoleId = (
      await createRole(tenantAId, `dispatch-${run}`, 'Dispatcher')
    ).id;

    await grant(adminRoleAId, PERMISSIONS.RESERVATION_READ);
    await grant(adminRoleAId, PERMISSIONS.RESERVATION_CREATE);
    await grant(adminRoleAId, PERMISSIONS.RESERVATION_UPDATE);
    await grant(adminRoleAId, PERMISSIONS.RESERVATION_DELETE);
    await grant(employeeRoleA.id, PERMISSIONS.RESERVATION_READ);
    await grant(managerRoleId, PERMISSIONS.RESERVATION_MANAGE);

    await createMembership(ownerA, tenantAId, ownerRoleA.id);
    await createMembership(adminA, tenantAId, adminRoleAId);
    await createMembership(employeeA, tenantAId, employeeRoleA.id);
    await createMembership(managerA, tenantAId, managerRoleId);

    // Tenant B roles: full reservation grants mirroring tenant A.
    const adminRoleB = await createRole(tenantBId, 'admin', 'Admin', true);
    await grant(adminRoleB.id, PERMISSIONS.RESERVATION_READ);
    await grant(adminRoleB.id, PERMISSIONS.RESERVATION_CREATE);
    await grant(adminRoleB.id, PERMISSIONS.RESERVATION_UPDATE);
    await grant(adminRoleB.id, PERMISSIONS.RESERVATION_DELETE);
    // The baseline customer for tenant B is created through the customers API.
    await grant(adminRoleB.id, PERMISSIONS.CUSTOMER_CREATE);
    await createMembership(adminB, tenantBId, adminRoleB.id);

    // Baseline customers through the API.
    const custResA = await send(
      'post',
      '/customers',
      await tokenFor(ownerA),
      tenantAId,
      { name: 'Alpha Construction', code: `${run}-cust-a` },
    );
    expect(custResA.status).toBe(201);
    customerAId = (custResA.body as { id: string }).id;
    customerIdsToDelete.push(customerAId);

    const custResB = await send(
      'post',
      '/customers',
      await tokenFor(adminB),
      tenantBId,
      { name: 'Beta Logistics', code: `${run}-cust-b` },
    );
    expect(custResB.status).toBe(201);
    customerBId = (custResB.body as { id: string }).id;
    customerIdsToDelete.push(customerBId);

    // Baseline assets + equipment (direct, mirroring the equipment suite).
    const assetA = await createAssetDirect(tenantAId, `${run}-asset-a`);
    equipAId = (await createEquipmentDirect(tenantAId, assetA.id, 'CRANE')).id;
    const assetA2 = await createAssetDirect(tenantAId, `${run}-asset-a2`);
    equipA2Id = (await createEquipmentDirect(tenantAId, assetA2.id, 'FORKLIFT'))
      .id;
    const assetB = await createAssetDirect(tenantBId, `${run}-asset-b`);
    equipBId = (await createEquipmentDirect(tenantBId, assetB.id, 'FORKLIFT'))
      .id;

    // Baseline reservations through the API (also exercises the create path).
    const resvResA = await postReservation(await tokenFor(adminA), tenantAId, {
      customerId: customerAId,
      equipmentId: equipAId,
      startAt: BASE_START,
      endAt: BASE_END,
      notes: 'Baseline A',
    });
    expect(resvResA.status).toBe(201);
    resvAId = (resvResA.body as ReservationBody).id;
    reservationIdsToDelete.push(resvAId);

    const resvResB = await postReservation(await tokenFor(adminB), tenantBId, {
      customerId: customerBId,
      equipmentId: equipBId,
      startAt: BASE_START,
      endAt: BASE_END,
    });
    expect(resvResB.status).toBe(201);
    resvBId = (resvResB.body as ReservationBody).id;
    reservationIdsToDelete.push(resvBId);
  });

  afterAll(async () => {
    if (prisma) {
      // Reservations first: RESTRICT foreign keys would block the rest.
      await prisma.reservation
        .deleteMany({ where: { id: { in: reservationIdsToDelete } } })
        .catch(() => undefined);
      await prisma.equipment
        .deleteMany({ where: { id: { in: equipmentIdsToDelete } } })
        .catch(() => undefined);
      await prisma.asset
        .deleteMany({ where: { id: { in: assetIdsToDelete } } })
        .catch(() => undefined);
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

  describe('listing reservations', () => {
    it('list with reservation:read -> 200 envelope', async () => {
      const res = await get('/reservations', await tokenFor(adminA), tenantAId);
      expect(res.status).toBe(200);
      const body = res.body as PaginatedBody;
      expect(Array.isArray(body.data)).toBe(true);
      expect(typeof body.meta.nextCursor).toBe('object');
      expect(body.data.some((r) => r.id === resvAId)).toBe(true);
    });

    it('lists only the active tenant reservations (cross-tenant list isolation)', async () => {
      const listB = await get(
        '/reservations',
        await tokenFor(adminB),
        tenantBId,
      );
      expect(listB.status).toBe(200);
      const bodyB = listB.body as PaginatedBody;
      expect(bodyB.data.some((r) => r.id === resvAId)).toBe(false);
      expect(bodyB.data.some((r) => r.id === resvBId)).toBe(true);

      const listA = await get(
        '/reservations',
        await tokenFor(adminA),
        tenantAId,
      );
      expect(listA.status).toBe(200);
      const bodyA = listA.body as PaginatedBody;
      expect(bodyA.data.some((r) => r.id === resvBId)).toBe(false);
    });

    it('insufficient permission -> 403', async () => {
      const nobody = await createUser(`nobody-${run}@example.com`);
      const nobodyRole = await createRole(
        tenantAId,
        `nobody-${run}`,
        'NoPerms',
      );
      await createMembership(nobody, tenantAId, nobodyRole.id);

      const res = await get('/reservations', await tokenFor(nobody), tenantAId);
      expect(res.status).toBe(403);
    });
  });

  describe('single reservation', () => {
    it('get reservation -> 200', async () => {
      const res = await get(
        `/reservations/${resvAId}`,
        await tokenFor(adminA),
        tenantAId,
      );
      expect(res.status).toBe(200);
      const body = res.body as ReservationBody;
      expect(body.id).toBe(resvAId);
      expect(body.tenantId).toBe(tenantAId);
      expect(body.customerId).toBe(customerAId);
      expect(body.equipmentId).toBe(equipAId);
      expect(body.status).toBe('RESERVED');
      expect(body.notes).toBe('Baseline A');
    });

    it('get missing reservation -> 404', async () => {
      const res = await get(
        '/reservations/non-existent-reservation',
        await tokenFor(adminA),
        tenantAId,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('create reservation', () => {
    it('valid reservation -> 201 RESERVED with UTC instants', async () => {
      const res = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(10),
        endAt: iso(14),
      });
      expect(res.status).toBe(201);
      const body = res.body as ReservationBody;
      expect(body.tenantId).toBe(tenantAId);
      expect(body.customerId).toBe(customerAId);
      expect(body.equipmentId).toBe(equipAId);
      expect(body.status).toBe('RESERVED');
      expect(body.startAt).toBe(iso(10));
      expect(body.endAt).toBe(iso(14));
      expect(body.notes).toBeNull();
      reservationIdsToDelete.push(body.id);
    });

    it('startAt == endAt -> 400', async () => {
      const res = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(10),
        endAt: iso(10),
      });
      expect(res.status).toBe(400);
    });

    it('endAt < startAt -> 400', async () => {
      const res = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(14),
        endAt: iso(10),
      });
      expect(res.status).toBe(400);
    });

    it('non-ISO timestamp -> 400', async () => {
      const res = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: 'tomorrow morning',
        endAt: iso(14),
      });
      expect(res.status).toBe(400);
    });

    it('nonexistent customer -> 404', async () => {
      const res = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: 'non-existent-customer',
        equipmentId: equipAId,
        startAt: iso(20),
        endAt: iso(24),
      });
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Customer not found');
    });

    it('foreign-tenant customerId -> 404 (no existence leak)', async () => {
      const res = await postReservation(await tokenFor(adminB), tenantBId, {
        customerId: customerAId,
        equipmentId: equipBId,
        startAt: iso(20),
        endAt: iso(24),
      });
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Customer not found');
    });

    it('nonexistent equipment -> 404', async () => {
      const res = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: 'non-existent-equipment',
        startAt: iso(20),
        endAt: iso(24),
      });
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Equipment not found');
    });

    it('foreign-tenant equipmentId -> 404 (no existence leak)', async () => {
      const res = await postReservation(await tokenFor(adminB), tenantBId, {
        customerId: customerBId,
        equipmentId: equipAId,
        startAt: iso(20),
        endAt: iso(24),
      });
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Equipment not found');
    });

    it('INACTIVE customer can still reserve -> 201', async () => {
      const created = await send(
        'post',
        '/customers',
        await tokenFor(ownerA),
        tenantAId,
        { name: 'Dormant Co', code: `${run}-dormant` },
      );
      expect(created.status).toBe(201);
      const dormantId = (created.body as { id: string }).id;
      customerIdsToDelete.push(dormantId);
      await tenantContext.run(tenantAId, async () =>
        prisma.customer.update({
          where: { id: dormantId },
          data: { status: 'INACTIVE' },
        }),
      );

      const res = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: dormantId,
        equipmentId: equipAId,
        startAt: iso(30),
        endAt: iso(34),
      });
      expect(res.status).toBe(201);
      reservationIdsToDelete.push((res.body as ReservationBody).id);
    });

    it('rejects client-supplied status with 400 (server-controlled)', async () => {
      const res = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(40),
        endAt: iso(44),
        status: 'COMPLETED',
      });
      expect(res.status).toBe(400);
    });

    it('rejects client-supplied tenantId with 400', async () => {
      const res = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(40),
        endAt: iso(44),
        tenantId: 'tenant-9',
      });
      expect(res.status).toBe(400);
    });

    it('rejects arbitrary internal fields with 400', async () => {
      const res = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(40),
        endAt: iso(44),
        id: 'resv-9',
        userId: 'user-9',
        roleId: 'role-9',
        permissions: ['reservation:read'],
        permissionIds: ['perm-1'],
        membershipId: 'mem-9',
        storeId: 'store-9',
        assetId: 'asset-9',
        code: 'RESV-001',
        type: 'CRANE',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('overlap protection', () => {
    it('overlapping reservation on the same equipment -> 409', async () => {
      // [502, 506) overlaps the baseline reservation [500, 504) on equipA.
      const res = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(502),
        endAt: iso(506),
      });
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe(
        'Equipment is already reserved for the selected period',
      );
    });

    it('back-to-back reservations are allowed (half-open intervals)', async () => {
      // Free window: [10,14) is taken by the earlier "valid reservation" test.
      const first = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(20),
        endAt: iso(24),
      });
      expect(first.status).toBe(201);
      reservationIdsToDelete.push((first.body as ReservationBody).id);

      const second = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(24),
        endAt: iso(28),
      });
      expect(second.status).toBe(201);
      reservationIdsToDelete.push((second.body as ReservationBody).id);
    });

    it('overlapping windows on different equipment are allowed', async () => {
      // Same window as the rejected overlap above, but on a second piece of
      // tenant-A equipment: isolation is per equipment, not per tenant.
      const res = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipA2Id,
        startAt: iso(2),
        endAt: iso(6),
      });
      expect(res.status).toBe(201);
      reservationIdsToDelete.push((res.body as ReservationBody).id);
    });

    it('a cancelled slot can be rebooked', async () => {
      const first = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(60),
        endAt: iso(64),
      });
      expect(first.status).toBe(201);
      const firstId = (first.body as ReservationBody).id;

      const cancel = await send(
        'delete',
        `/reservations/${firstId}`,
        await tokenFor(adminA),
        tenantAId,
      );
      expect(cancel.status).toBe(204);

      const rebook = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(60),
        endAt: iso(64),
      });
      expect(rebook.status).toBe(201);
      reservationIdsToDelete.push((rebook.body as ReservationBody).id);
    });
  });

  describe('update reservation', () => {
    it('notes-only update -> 200', async () => {
      const res = await send(
        'put',
        `/reservations/${resvAId}`,
        await tokenFor(adminA),
        tenantAId,
        { notes: 'Updated note' },
      );
      expect(res.status).toBe(200);
      expect((res.body as ReservationBody).notes).toBe('Updated note');
    });

    it('time update -> 200 echoes UTC instants', async () => {
      const target = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(70),
        endAt: iso(74),
      });
      const id = (target.body as ReservationBody).id;
      reservationIdsToDelete.push(id);

      const res = await send(
        'put',
        `/reservations/${id}`,
        await tokenFor(adminA),
        tenantAId,
        { endAt: iso(76) },
      );
      expect(res.status).toBe(200);
      const body = res.body as ReservationBody;
      expect(body.startAt).toBe(iso(70));
      expect(body.endAt).toBe(iso(76));
    });

    it('extending into another reservation -> 409', async () => {
      const near = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(80),
        endAt: iso(84),
      });
      const nearId = (near.body as ReservationBody).id;
      reservationIdsToDelete.push(nearId);

      // Blocker occupying [84, 88): extending near into it must conflict.
      const blocker = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(84),
        endAt: iso(88),
      });
      expect(blocker.status).toBe(201);
      reservationIdsToDelete.push((blocker.body as ReservationBody).id);

      const res = await send(
        'put',
        `/reservations/${nearId}`,
        await tokenFor(adminA),
        tenantAId,
        { endAt: iso(86) },
      );
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe(
        'Equipment is already reserved for the selected period',
      );
    });

    it('customerId on update -> 400 (immutable link)', async () => {
      const res = await send(
        'put',
        `/reservations/${resvAId}`,
        await tokenFor(adminA),
        tenantAId,
        { customerId: customerBId },
      );
      expect(res.status).toBe(400);
    });

    it('equipmentId on update -> 400 (immutable link)', async () => {
      const res = await send(
        'put',
        `/reservations/${resvAId}`,
        await tokenFor(adminA),
        tenantAId,
        { equipmentId: equipBId },
      );
      expect(res.status).toBe(400);
    });

    it('status manipulation on update -> 400', async () => {
      const res = await send(
        'put',
        `/reservations/${resvAId}`,
        await tokenFor(adminA),
        tenantAId,
        { status: 'CANCELLED' },
      );
      expect(res.status).toBe(400);
    });

    it('PUT on a CANCELLED reservation -> 409', async () => {
      const target = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(90),
        endAt: iso(94),
      });
      const id = (target.body as ReservationBody).id;
      reservationIdsToDelete.push(id);
      await send(
        'delete',
        `/reservations/${id}`,
        await tokenFor(adminA),
        tenantAId,
      );

      const res = await send(
        'put',
        `/reservations/${id}`,
        await tokenFor(adminA),
        tenantAId,
        { notes: 'zombie edit' },
      );
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe(
        'Only reservations in RESERVED status can be updated',
      );
    });
  });

  describe('soft cancel (DELETE)', () => {
    it('cancel -> 204, row retained as CANCELLED', async () => {
      const target = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(100),
        endAt: iso(104),
      });
      const id = (target.body as ReservationBody).id;
      reservationIdsToDelete.push(id);

      const res = await send(
        'delete',
        `/reservations/${id}`,
        await tokenFor(adminA),
        tenantAId,
      );
      expect(res.status).toBe(204);

      const row = await tenantContext.run(tenantAId, async () =>
        prisma.reservation.findUnique({ where: { id } }),
      );
      expect(row).not.toBeNull();
      expect(row!.status).toBe('CANCELLED');
    });

    it('double cancel -> 409', async () => {
      const target = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(110),
        endAt: iso(114),
      });
      const id = (target.body as ReservationBody).id;
      reservationIdsToDelete.push(id);

      const first = await send(
        'delete',
        `/reservations/${id}`,
        await tokenFor(adminA),
        tenantAId,
      );
      expect(first.status).toBe(204);

      const second = await send(
        'delete',
        `/reservations/${id}`,
        await tokenFor(adminA),
        tenantAId,
      );
      expect(second.status).toBe(409);
      expect((second.body as ErrorBody).message).toBe(
        'Reservation is already cancelled',
      );
    });
  });

  describe('lifecycle transitions', () => {
    const startAs = async (
      userId: string,
      tenantId: string,
      id: string,
    ): Promise<ReturnType<typeof send>> =>
      send(
        'post',
        `/reservations/${id}/start`,
        await tokenFor(userId),
        tenantId,
      );

    const completeAs = async (
      userId: string,
      tenantId: string,
      id: string,
    ): Promise<ReturnType<typeof send>> =>
      send(
        'post',
        `/reservations/${id}/complete`,
        await tokenFor(userId),
        tenantId,
      );

    it('start -> 200 ACTIVE (RESERVED -> ACTIVE)', async () => {
      // Past window: the clock gate requires an opened window to start.
      const target = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(-110),
        endAt: iso(-106),
      });
      const id = (target.body as ReservationBody).id;
      reservationIdsToDelete.push(id);

      const res = await startAs(adminA, tenantAId, id);
      expect(res.status).toBe(200);
      expect((res.body as ReservationBody).status).toBe('ACTIVE');
    });

    it('start on an unknown id -> 404', async () => {
      const res = await startAs(adminA, tenantAId, randomUUID());
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Reservation not found');
    });

    it('start on a CANCELLED reservation -> 409', async () => {
      const target = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(-102),
        endAt: iso(-98),
      });
      const id = (target.body as ReservationBody).id;
      reservationIdsToDelete.push(id);
      expect(
        (
          await send(
            'delete',
            `/reservations/${id}`,
            await tokenFor(adminA),
            tenantAId,
          )
        ).status,
      ).toBe(204);

      const res = await startAs(adminA, tenantAId, id);
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe(
        'Only reservations in RESERVED status can be started',
      );
    });

    it('double start -> 409', async () => {
      const target = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(-94),
        endAt: iso(-90),
      });
      const id = (target.body as ReservationBody).id;
      reservationIdsToDelete.push(id);
      expect((await startAs(adminA, tenantAId, id)).status).toBe(200);

      const second = await startAs(adminA, tenantAId, id);
      expect(second.status).toBe(409);
      expect((second.body as ErrorBody).message).toBe(
        'Only reservations in RESERVED status can be started',
      );
    });

    it('complete after start -> 200 COMPLETED (ACTIVE -> COMPLETED)', async () => {
      const target = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(-86),
        endAt: iso(-82),
      });
      const id = (target.body as ReservationBody).id;
      reservationIdsToDelete.push(id);
      expect((await startAs(adminA, tenantAId, id)).status).toBe(200);

      const res = await completeAs(adminA, tenantAId, id);
      expect(res.status).toBe(200);
      expect((res.body as ReservationBody).status).toBe('COMPLETED');
    });

    it('completing a RESERVED reservation -> 409', async () => {
      const target = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(-78),
        endAt: iso(-74),
      });
      const id = (target.body as ReservationBody).id;
      reservationIdsToDelete.push(id);

      const res = await completeAs(adminA, tenantAId, id);
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe(
        'Only reservations in ACTIVE status can be completed',
      );
    });

    it('double complete -> 409', async () => {
      const target = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(-70),
        endAt: iso(-66),
      });
      const id = (target.body as ReservationBody).id;
      reservationIdsToDelete.push(id);
      expect((await startAs(adminA, tenantAId, id)).status).toBe(200);
      expect((await completeAs(adminA, tenantAId, id)).status).toBe(200);

      const second = await completeAs(adminA, tenantAId, id);
      expect(second.status).toBe(409);
      expect((second.body as ErrorBody).message).toBe(
        'Only reservations in ACTIVE status can be completed',
      );
    });

    it('a completed slot can be rebooked (COMPLETED does not hold the equipment)', async () => {
      const first = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(-62),
        endAt: iso(-58),
      });
      const firstId = (first.body as ReservationBody).id;
      reservationIdsToDelete.push(firstId);
      expect((await startAs(adminA, tenantAId, firstId)).status).toBe(200);
      expect((await completeAs(adminA, tenantAId, firstId)).status).toBe(200);

      const rebook = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(-62),
        endAt: iso(-58),
      });
      expect(rebook.status).toBe(201);
      reservationIdsToDelete.push((rebook.body as ReservationBody).id);
    });

    it('cross-tenant start -> 404 (IDOR)', async () => {
      const res = await startAs(adminB, tenantBId, resvAId);
      expect(res.status).toBe(404);
    });

    it('read-only member cannot start -> 403, row untouched', async () => {
      const target = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(-54),
        endAt: iso(-50),
      });
      const id = (target.body as ReservationBody).id;
      reservationIdsToDelete.push(id);

      const res = await startAs(employeeA, tenantAId, id);
      expect(res.status).toBe(403);

      const after = await get(
        `/reservations/${id}`,
        await tokenFor(employeeA),
        tenantAId,
      );
      expect(after.status).toBe(200);
      expect((after.body as ReservationBody).status).toBe('RESERVED');
    });

    it('reservation:manage alone CAN start -> 200 ACTIVE', async () => {
      const target = await postReservation(await tokenFor(adminA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(-46),
        endAt: iso(-42),
      });
      const id = (target.body as ReservationBody).id;
      reservationIdsToDelete.push(id);

      const res = await startAs(managerA, tenantAId, id);
      expect(res.status).toBe(200);
      expect((res.body as ReservationBody).status).toBe('ACTIVE');
    });

    describe('window-aware gating (real clock)', () => {
      // base = Date.now() + 24h, so offsets below -24h are in the past.
      it('start before startAt -> 409, row untouched', async () => {
        const target = await postReservation(
          await tokenFor(adminA),
          tenantAId,
          {
            customerId: customerAId,
            equipmentId: equipAId,
            startAt: iso(240),
            endAt: iso(244),
          },
        );
        const id = (target.body as ReservationBody).id;
        reservationIdsToDelete.push(id);

        const res = await startAs(adminA, tenantAId, id);
        expect(res.status).toBe(409);
        expect((res.body as ErrorBody).message).toBe(
          'Reservation cannot be started before its scheduled start time',
        );

        const after = await get(
          `/reservations/${id}`,
          await tokenFor(employeeA),
          tenantAId,
        );
        expect(after.status).toBe(200);
        expect((after.body as ReservationBody).status).toBe('RESERVED');
      });

      it('start once the window has opened -> 200 ACTIVE', async () => {
        const target = await postReservation(
          await tokenFor(adminA),
          tenantAId,
          {
            customerId: customerAId,
            equipmentId: equipAId,
            startAt: iso(-30),
            endAt: iso(-26),
          },
        );
        const id = (target.body as ReservationBody).id;
        reservationIdsToDelete.push(id);

        const res = await startAs(adminA, tenantAId, id);
        expect(res.status).toBe(200);
        expect((res.body as ReservationBody).status).toBe('ACTIVE');
      });

      it('complete before endAt -> 409, row still ACTIVE', async () => {
        // Window [2h ago, ~26h ahead): open for start, nowhere near closable.
        // Kept narrow so it cannot overlap the suite's other equipA windows.
        const target = await postReservation(
          await tokenFor(adminA),
          tenantAId,
          {
            customerId: customerAId,
            equipmentId: equipAId,
            startAt: iso(-26),
            endAt: iso(2),
          },
        );
        const id = (target.body as ReservationBody).id;
        reservationIdsToDelete.push(id);
        expect((await startAs(adminA, tenantAId, id)).status).toBe(200);

        const res = await completeAs(adminA, tenantAId, id);
        expect(res.status).toBe(409);
        expect((res.body as ErrorBody).message).toBe(
          'Reservation cannot be completed before its scheduled end time',
        );

        const after = await get(
          `/reservations/${id}`,
          await tokenFor(employeeA),
          tenantAId,
        );
        expect((after.body as ReservationBody).status).toBe('ACTIVE');
      });

      it('complete after endAt -> 200 COMPLETED', async () => {
        const target = await postReservation(
          await tokenFor(adminA),
          tenantAId,
          {
            customerId: customerAId,
            equipmentId: equipAId,
            startAt: iso(-38),
            endAt: iso(-34),
          },
        );
        const id = (target.body as ReservationBody).id;
        reservationIdsToDelete.push(id);
        expect((await startAs(adminA, tenantAId, id)).status).toBe(200);

        const res = await completeAs(adminA, tenantAId, id);
        expect(res.status).toBe(200);
        expect((res.body as ReservationBody).status).toBe('COMPLETED');
      });
    });
  });

  describe('IDOR protection (no tenant data leakage)', () => {
    it('cross-tenant reservation GET -> 404', async () => {
      const res = await get(
        `/reservations/${resvAId}`,
        await tokenFor(adminB),
        tenantBId,
      );
      expect(res.status).toBe(404);
    });

    it('cross-tenant reservation PUT -> 404', async () => {
      const res = await send(
        'put',
        `/reservations/${resvAId}`,
        await tokenFor(adminB),
        tenantBId,
        { notes: 'Hacked' },
      );
      expect(res.status).toBe(404);
    });

    it('cross-tenant reservation DELETE -> 404', async () => {
      const res = await send(
        'delete',
        `/reservations/${resvAId}`,
        await tokenFor(adminB),
        tenantBId,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('authorization matrix', () => {
    it('reservation:manage alone can create/update/cancel but NOT read (GET -> 403)', async () => {
      const createRes = await postReservation(
        await tokenFor(managerA),
        tenantAId,
        {
          customerId: customerAId,
          equipmentId: equipAId,
          startAt: iso(120),
          endAt: iso(124),
        },
      );
      expect(createRes.status).toBe(201);
      const id = (createRes.body as ReservationBody).id;
      reservationIdsToDelete.push(id);

      const updRes = await send(
        'put',
        `/reservations/${id}`,
        await tokenFor(managerA),
        tenantAId,
        { notes: 'dispatched' },
      );
      expect(updRes.status).toBe(200);

      const delRes = await send(
        'delete',
        `/reservations/${id}`,
        await tokenFor(managerA),
        tenantAId,
      );
      expect(delRes.status).toBe(204);

      // GET requires reservation:read; reservation:manage must NOT imply it.
      const listRes = await get(
        '/reservations',
        await tokenFor(managerA),
        tenantAId,
      );
      expect(listRes.status).toBe(403);

      const getRes = await get(
        `/reservations/${resvAId}`,
        await tokenFor(managerA),
        tenantAId,
      );
      expect(getRes.status).toBe(403);
    });

    it('read-only member can GET but not create (403)', async () => {
      const getRes = await get(
        `/reservations/${resvAId}`,
        await tokenFor(employeeA),
        tenantAId,
      );
      expect(getRes.status).toBe(200);

      const postRes = await postReservation(
        await tokenFor(employeeA),
        tenantAId,
        {
          customerId: customerAId,
          equipmentId: equipAId,
          startAt: iso(130),
          endAt: iso(134),
        },
      );
      expect(postRes.status).toBe(403);
    });

    it('owner semantic-all -> full CRUD without explicit reservation grants', async () => {
      const created = await postReservation(await tokenFor(ownerA), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(140),
        endAt: iso(144),
      });
      expect(created.status).toBe(201);
      const id = (created.body as ReservationBody).id;

      const got = await get(
        `/reservations/${id}`,
        await tokenFor(ownerA),
        tenantAId,
      );
      expect(got.status).toBe(200);

      const updated = await send(
        'put',
        `/reservations/${id}`,
        await tokenFor(ownerA),
        tenantAId,
        { notes: 'Owner was here' },
      );
      expect(updated.status).toBe(200);

      const cancelled = await send(
        'delete',
        `/reservations/${id}`,
        await tokenFor(ownerA),
        tenantAId,
      );
      expect(cancelled.status).toBe(204);
    });
  });

  describe('RESTRICT deletion of referenced records', () => {
    it('deleting a customer with reservations -> 409', async () => {
      const created = await send(
        'post',
        '/customers',
        await tokenFor(ownerA),
        tenantAId,
        { name: 'Protected Co', code: `${run}-protected` },
      );
      const protectedCustomerId = (created.body as { id: string }).id;
      customerIdsToDelete.push(protectedCustomerId);

      const reserved = await postReservation(
        await tokenFor(ownerA),
        tenantAId,
        {
          customerId: protectedCustomerId,
          equipmentId: equipAId,
          startAt: iso(150),
          endAt: iso(154),
        },
      );
      expect(reserved.status).toBe(201);
      reservationIdsToDelete.push((reserved.body as ReservationBody).id);

      const res = await send(
        'delete',
        `/customers/${protectedCustomerId}`,
        await tokenFor(ownerA),
        tenantAId,
      );
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe(
        'Customer has reservations and cannot be deleted',
      );
    });

    it('deleting an asset whose equipment has reservations -> 409', async () => {
      const asset = await createAssetDirect(tenantAId, `${run}-locked`);
      const equipment = await createEquipmentDirect(
        tenantAId,
        asset.id,
        'FORKLIFT',
      );

      const reserved = await postReservation(
        await tokenFor(ownerA),
        tenantAId,
        {
          customerId: customerAId,
          equipmentId: equipment.id,
          startAt: iso(160),
          endAt: iso(164),
        },
      );
      expect(reserved.status).toBe(201);
      reservationIdsToDelete.push((reserved.body as ReservationBody).id);

      const res = await send(
        'delete',
        `/assets/${asset.id}`,
        await tokenFor(ownerA),
        tenantAId,
      );
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe(
        'Asset has reservations and cannot be deleted',
      );
    });
  });

  describe('auth / tenant state gating', () => {
    it('invalid JWT -> 401', async () => {
      const res = await postReservation('not-a-jwt', tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(170),
        endAt: iso(174),
      });
      expect(res.status).toBe(401);
    });

    it('missing auth header -> 401', async () => {
      const res = await postReservation('', tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(170),
        endAt: iso(174),
      });
      expect(res.status).toBe(401);
    });

    it('missing tenant header -> 400', async () => {
      const res = await postReservation(await tokenFor(adminA), '', {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(170),
        endAt: iso(174),
      });
      expect(res.status).toBe(400);
    });

    it('suspended membership actor -> 403', async () => {
      const suspended = await createUser(`rs-suspended-${run}@example.com`);
      await createMembership(suspended, tenantAId, adminRoleAId, 'SUSPENDED');

      const res = await postReservation(await tokenFor(suspended), tenantAId, {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(180),
        endAt: iso(184),
      });
      expect(res.status).toBe(403);
    });

    it('inactive tenant -> 403', async () => {
      const inactiveTenant = await createTenant('Inactive Reservation Tenant');
      await prisma.tenant.update({
        where: { id: inactiveTenant },
        data: { status: 'SUSPENDED' },
      });

      const res = await postReservation(
        await tokenFor(adminA),
        inactiveTenant,
        {
          customerId: customerAId,
          equipmentId: equipAId,
          startAt: iso(190),
          endAt: iso(194),
        },
      );
      expect(res.status).toBe(403);
    });
  });

  describe('concurrency (exclusion constraint arbitration)', () => {
    it('8 parallel overlapping POSTs -> exactly one 201, rest 409', async () => {
      const token = await tokenFor(adminA);
      const body = {
        customerId: customerAId,
        equipmentId: equipAId,
        startAt: iso(200),
        endAt: iso(204),
      };

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          postReservation(token, tenantAId, body).then((res) => res.status),
        ),
      );

      const created = results.filter((status) => status === 201).length;
      const conflicts = results.filter((status) => status === 409).length;
      expect(created).toBe(1);
      expect(conflicts).toBe(7);
      expect(results.length).toBe(8);
    });

    it('parallel non-overlapping POSTs on one equipment all succeed', async () => {
      const token = await tokenFor(adminA);

      const results = await Promise.all(
        [0, 1, 2, 3].map((hour) =>
          postReservation(token, tenantAId, {
            customerId: customerAId,
            equipmentId: equipAId,
            startAt: iso(300 + hour),
            endAt: iso(301 + hour),
          }).then((res) => res.status),
        ),
      );

      expect(results.every((status) => status === 201)).toBe(true);
    });
  });

  describe('pagination & filters (Phase 2J)', () => {
    // Dedicated fixtures on their own equipment so equipmentId filters are
    // exact and no other suite's windows can interfere. Windows sit at
    // iso(400+10k)..iso(404+10k), far from every offset used elsewhere.
    let pilotEquipId: string;
    let customerA2Id: string;
    const pilot: Array<{
      id: string;
      createdAt: string;
      startAt: string;
      endAt: string;
    }> = [];

    beforeAll(async () => {
      const assetPilot = await createAssetDirect(
        tenantAId,
        `${run}-asset-pilot`,
      );
      pilotEquipId = (
        await createEquipmentDirect(tenantAId, assetPilot.id, 'CRANE')
      ).id;

      const custRes = await send(
        'post',
        '/customers',
        await tokenFor(ownerA),
        tenantAId,
        { name: 'Alpha Secondary', code: `${run}-cust-a2` },
      );
      expect(custRes.status).toBe(201);
      customerA2Id = (custRes.body as { id: string }).id;
      customerIdsToDelete.push(customerA2Id);

      for (let k = 0; k < 7; k += 1) {
        const res = await postReservation(await tokenFor(adminA), tenantAId, {
          customerId: k === 5 ? customerA2Id : customerAId,
          equipmentId: pilotEquipId,
          startAt: iso(400 + 10 * k),
          endAt: iso(404 + 10 * k),
        });
        expect(res.status).toBe(201);
        const body = res.body as ReservationBody;
        pilot.push({
          id: body.id,
          createdAt: (res.body as { createdAt: string }).createdAt,
          startAt: body.startAt,
          endAt: body.endAt,
        });
        reservationIdsToDelete.push(body.id);
      }

      // Soft-cancel the last pilot reservation for status-filter coverage.
      const cancel = await send(
        'delete',
        `/reservations/${pilot[6].id}`,
        await tokenFor(adminA),
        tenantAId,
      );
      expect(cancel.status).toBe(204);
    });

    const listQuery = async (
      token: string,
      tenantId: string,
      query: Record<string, string>,
    ) => {
      const qs = new URLSearchParams(query).toString();
      const path = qs ? `/reservations?${qs}` : '/reservations';
      const res = await get(path, token, tenantId);
      return { res, body: res.body as PaginatedBody };
    };

    const walk = async (
      query: Record<string, string>,
      maxPages = 20,
    ): Promise<PaginatedBody['data']> => {
      const all: PaginatedBody['data'] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const q: Record<string, string> = { ...query };
        if (cursor) {
          q.cursor = cursor;
        }
        const { res, body } = await listQuery(
          await tokenFor(adminA),
          tenantAId,
          q,
        );
        if (res.status !== 200) {
          throw new Error(
            `walk page ${pages + 1} failed: ${res.status} ${JSON.stringify(res.body)}`,
          );
        }
        all.push(...body.data);
        cursor = body.meta.nextCursor;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(maxPages);
      } while (cursor);
      return all;
    };

    const byCreatedAtAsc = (
      a: { createdAt: string; id: string },
      b: {
        createdAt: string;
        id: string;
      },
    ) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      a.id.localeCompare(b.id);

    it('returns the envelope with the whole filtered set under the default limit', async () => {
      const { res, body } = await listQuery(await tokenFor(adminA), tenantAId, {
        equipmentId: pilotEquipId,
      });
      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(7);
      expect(body.meta.nextCursor).toBeNull();
    });

    it('walks pages deterministically (limit 3, createdAt asc)', async () => {
      const expected = [...pilot].sort(byCreatedAtAsc).map((r) => r.id);

      const collected: string[] = [];
      const pageSizes: number[] = [];
      let cursor: string | null | undefined;
      do {
        const q: Record<string, string> = {
          equipmentId: pilotEquipId,
          limit: '3',
        };
        if (cursor) {
          q.cursor = cursor;
        }
        const { res, body } = await listQuery(
          await tokenFor(adminA),
          tenantAId,
          q,
        );
        if (res.status !== 200) {
          throw new Error(
            `page failed: ${res.status} ${JSON.stringify(res.body)} cursor=${String(cursor)}`,
          );
        }
        pageSizes.push(body.data.length);
        collected.push(...body.data.map((r) => r.id));
        cursor = body.meta.nextCursor;
      } while (cursor);

      // 7 items / limit 3 -> exact boundary: full page, full page, short tail.
      expect(pageSizes).toEqual([3, 3, 1]);
      expect(collected).toEqual(expected);
    });

    it('steps with limit 1', async () => {
      const expected = [...pilot].sort(byCreatedAtAsc).map((r) => r.id);
      const first = await listQuery(await tokenFor(adminA), tenantAId, {
        equipmentId: pilotEquipId,
        limit: '1',
      });
      expect(first.body.data.map((r) => r.id)).toEqual([expected[0]]);
      expect(first.body.meta.nextCursor).not.toBeNull();

      const second = await listQuery(await tokenFor(adminA), tenantAId, {
        equipmentId: pilotEquipId,
        limit: '1',
        cursor: first.body.meta.nextCursor as string,
      });
      expect(second.body.data.map((r) => r.id)).toEqual([expected[1]]);
    });

    it('orders descending deterministically', async () => {
      const expected = [...pilot]
        .sort(byCreatedAtAsc)
        .reverse()
        .map((r) => r.id);
      const collected = await walk({
        equipmentId: pilotEquipId,
        limit: '3',
        order: 'desc',
      });
      expect(collected.map((r) => r.id)).toEqual(expected);
    });

    it('supports sortBy=startAt with its own deterministic order', async () => {
      const expected = [...pilot]
        .sort(
          (a, b) =>
            Date.parse(a.startAt) - Date.parse(b.startAt) ||
            a.id.localeCompare(b.id),
        )
        .map((r) => r.id);
      const { body } = await listQuery(await tokenFor(adminA), tenantAId, {
        equipmentId: pilotEquipId,
        limit: '100',
        sortBy: 'startAt',
      });
      expect(body.data.map((r) => r.id)).toEqual(expected);
    });

    it('returns an empty page for filters matching nothing', async () => {
      const { body } = await listQuery(await tokenFor(adminA), tenantAId, {
        equipmentId: pilotEquipId,
        status: 'ACTIVE',
      });
      expect(body.data).toEqual([]);
      expect(body.meta.nextCursor).toBeNull();
    });

    it('filters by status', async () => {
      const { body } = await listQuery(await tokenFor(adminA), tenantAId, {
        equipmentId: pilotEquipId,
        status: 'CANCELLED',
      });
      expect(body.data.map((r) => r.id)).toEqual([pilot[6].id]);
    });

    it('filters by customerId', async () => {
      const { body } = await listQuery(await tokenFor(adminA), tenantAId, {
        customerId: customerA2Id,
      });
      expect(body.data.map((r) => r.id)).toEqual([pilot[5].id]);
    });

    it('foreign filter ids yield an empty page, never an existence oracle', async () => {
      const byCustomer = await listQuery(await tokenFor(adminA), tenantAId, {
        customerId: customerBId,
      });
      expect(byCustomer.res.status).toBe(200);
      expect(byCustomer.body.data).toEqual([]);

      const byEquipment = await listQuery(await tokenFor(adminA), tenantAId, {
        equipmentId: equipBId,
      });
      expect(byEquipment.res.status).toBe(200);
      expect(byEquipment.body.data).toEqual([]);
    });

    describe('from/to overlap semantics', () => {
      const idsFor = async (from: string, to: string) => {
        const { body } = await listQuery(await tokenFor(adminA), tenantAId, {
          equipmentId: pilotEquipId,
          from,
          to,
        });
        return body.data.map((r) => r.id).sort();
      };

      it('matches reservations intersecting [from, to)', async () => {
        // k0=[400,404) k1=[410,414): both intersect [403, 411).
        expect(await idsFor(iso(403), iso(411))).toEqual(
          [pilot[0].id, pilot[1].id].sort(),
        );
      });

      it('excludes at the touching lower edge (endAt == from)', async () => {
        // k0 ends exactly at 404; k1,k2 lie fully inside [404, 430).
        expect(await idsFor(iso(404), iso(430))).toEqual(
          [pilot[1].id, pilot[2].id].sort(),
        );
      });

      it('excludes at the touching upper edge (startAt == to)', async () => {
        // k1 starts exactly at 410; only k0 intersects [380, 410).
        expect(await idsFor(iso(380), iso(410))).toEqual([pilot[0].id]);
      });

      it('rejects from >= to with 400', async () => {
        const equal = await listQuery(await tokenFor(adminA), tenantAId, {
          from: iso(410),
          to: iso(410),
        });
        expect(equal.res.status).toBe(400);
        const reversed = await listQuery(await tokenFor(adminA), tenantAId, {
          from: iso(420),
          to: iso(410),
        });
        expect(reversed.res.status).toBe(400);
      });
    });

    it('combines filters', async () => {
      const cancelledOwner = await listQuery(
        await tokenFor(adminA),
        tenantAId,
        {
          status: 'CANCELLED',
          equipmentId: pilotEquipId,
          customerId: customerAId,
        },
      );
      expect(cancelledOwner.body.data.map((r) => r.id)).toEqual([pilot[6].id]);

      const cancelledSecondary = await listQuery(
        await tokenFor(adminA),
        tenantAId,
        { status: 'CANCELLED', customerId: customerA2Id },
      );
      expect(cancelledSecondary.body.data).toEqual([]);
    });

    describe('cursor abuse -> 400', () => {
      it('rejects malformed cursors', async () => {
        const garbage = await listQuery(await tokenFor(adminA), tenantAId, {
          cursor: '!!!not-base64url!!!',
        });
        expect(garbage.res.status).toBe(400);
        expect((garbage.body as ErrorBody).message).toContain(
          'Invalid pagination cursor',
        );

        const notJson = Buffer.from('plain text', 'utf8').toString('base64url');
        const badJson = await listQuery(await tokenFor(adminA), tenantAId, {
          cursor: notJson,
        });
        expect(badJson.res.status).toBe(400);
      });

      it('rejects an unknown cursor version', async () => {
        const forged = Buffer.from(
          JSON.stringify({
            v: 99,
            s: 'createdAt',
            d: 'asc',
            k: [1, 'x'],
            f: '00000000',
          }),
          'utf8',
        ).toString('base64url');
        const res = await listQuery(await tokenFor(adminA), tenantAId, {
          cursor: forged,
        });
        expect(res.res.status).toBe(400);
      });

      it('rejects a cursor reused with different filters', async () => {
        const first = await listQuery(await tokenFor(adminA), tenantAId, {
          equipmentId: pilotEquipId,
          limit: '3',
        });
        expect(first.body.meta.nextCursor).not.toBeNull();

        const reused = await listQuery(await tokenFor(adminA), tenantAId, {
          limit: '3',
          cursor: first.body.meta.nextCursor as string,
        });
        expect(reused.res.status).toBe(400);
      });

      it('rejects a cursor reused with a different sort', async () => {
        const first = await listQuery(await tokenFor(adminA), tenantAId, {
          equipmentId: pilotEquipId,
          limit: '3',
        });
        const reused = await listQuery(await tokenFor(adminA), tenantAId, {
          equipmentId: pilotEquipId,
          limit: '3',
          sortBy: 'startAt',
          cursor: first.body.meta.nextCursor as string,
        });
        expect(reused.res.status).toBe(400);
      });
    });

    it('rejects unknown query fields with 400', async () => {
      const res = await listQuery(await tokenFor(adminA), tenantAId, {
        bogus: '1',
      });
      expect(res.res.status).toBe(400);
    });

    it('validates limit bounds over HTTP', async () => {
      const tooBig = await listQuery(await tokenFor(adminA), tenantAId, {
        limit: '101',
      });
      expect(tooBig.res.status).toBe(400);

      const zero = await listQuery(await tokenFor(adminA), tenantAId, {
        limit: '0',
      });
      expect(zero.res.status).toBe(400);

      const nonNumeric = await listQuery(await tokenFor(adminA), tenantAId, {
        limit: 'many',
      });
      expect(nonNumeric.res.status).toBe(400);

      const max = await listQuery(await tokenFor(adminA), tenantAId, {
        limit: '100',
      });
      expect(max.res.status).toBe(200);
      expect(max.body.data.length).toBeLessThanOrEqual(100);
    });

    it('keeps tenant isolation across pages', async () => {
      const foreignIds = new Set([...pilot.map((r) => r.id), resvAId]);
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const q: Record<string, string> = { limit: '2' };
        if (cursor) {
          q.cursor = cursor;
        }
        const { body } = await listQuery(await tokenFor(adminB), tenantBId, q);
        for (const row of body.data) {
          expect(row.tenantId).toBe(tenantBId);
          expect(foreignIds.has(row.id)).toBe(false);
        }
        cursor = body.meta.nextCursor;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(20);
      } while (cursor);
    });
  });

  describe('response safety', () => {
    it('returns exactly the safe ReservationSummary projection', async () => {
      const res = await get(
        `/reservations/${resvBId}`,
        await tokenFor(adminB),
        tenantBId,
      );
      expect(res.status).toBe(200);
      expect(Object.keys(res.body as object).sort()).toEqual([
        'createdAt',
        'customerId',
        'endAt',
        'equipmentId',
        'id',
        'notes',
        'startAt',
        'status',
        'tenantId',
        'updatedAt',
      ]);
    });
  });
});
