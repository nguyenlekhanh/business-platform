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
 * Phase 5 P5-U4 — Service-Catalog Booking integration suite.
 *
 * Real AppModule + supertest + real PostgreSQL. Covers: 401/403 gates,
 * the booking RBAC matrix (booking:read / booking:create / booking:manage;
 * manage-only-writes, create-only-writes, employee read-only, owner
 * semantic-all), CRUD happy path (BOOKED default -> PATCH status ->
 * CONFIRMED/ACTIVE/COMPLETED/CANCELLED/NO_SHOW), keyset pagination
 * envelope + cursor chaining + status/serviceId/customerId filters,
 * overlap 409 (EXCLUDE constraint), IDOR cross-tenant uniform 404,
 * ownership-field + deferred-domain-field injection 400, and concurrent
 * overlap creation (DB EXCLUDE arbitrates).
 */
describe('Service-Catalog Booking (integration)', () => {
  interface ErrorBody {
    message?: string | string[];
  }
  interface BookingBody {
    id: string;
    tenantId: string;
    serviceId: string;
    customerId: string | null;
    startAt: string;
    endAt: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let tenantContext: TenantContextService;

  const run = `bkg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const userIdsToDelete: string[] = [];
  const roleIdsToDelete: string[] = [];
  const membershipIdsToDelete: string[] = [];
  const tenantIdsToDelete: string[] = [];
  const serviceIdsToDelete: string[] = [];
  const customerIdsToDelete: string[] = [];

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
    method: 'get' | 'post' | 'patch',
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
      await prisma.booking
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.service
        .deleteMany({ where: { tenantId: { in: tenantIdsToDelete } } })
        .catch(() => undefined);
      await prisma.customer
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
  let adminA: Record<string, string>;
  let employeeA: Record<string, string>;
  let manageOnlyA: Record<string, string>;
  let createOnlyA: Record<string, string>;
  let ownerA: Record<string, string>;
  let adminB: Record<string, string>;

  let serviceAId: string;
  let serviceBId: string;
  let customerAId: string;
  let customerBId: string;

  let seq = 0;

  beforeEach(async () => {
    seq += 1;

    const tenantA = await createTenant('a');
    tenantAId = tenantA.id;
    const adminRole = await grantRole(tenantAId, `admin-a-${run}`, [
      PERMISSIONS.BOOKING_READ,
      PERMISSIONS.BOOKING_CREATE,
      PERMISSIONS.BOOKING_MANAGE,
    ]);
    const employeeRole = await grantRole(tenantAId, `employee-a-${run}`, [
      PERMISSIONS.BOOKING_READ,
    ]);
    const manageOnlyRole = await grantRole(tenantAId, `manageonly-a-${run}`, [
      PERMISSIONS.BOOKING_MANAGE,
    ]);
    const createOnlyRole = await grantRole(tenantAId, `createonly-a-${run}`, [
      PERMISSIONS.BOOKING_CREATE,
    ]);
    const ownerRole = await grantRole(tenantAId, SYSTEM_ROLE_KEYS.OWNER, []);

    const adminUser = await createUser(
      `admin-${run}-${seq}@a.test`,
      tenantAId,
      adminRole.id,
    );
    const employeeUser = await createUser(
      `employee-${run}-${seq}@a.test`,
      tenantAId,
      employeeRole.id,
    );
    const manageOnlyUser = await createUser(
      `manageonly-${run}-${seq}@a.test`,
      tenantAId,
      manageOnlyRole.id,
    );
    const createOnlyUser = await createUser(
      `createonly-${run}-${seq}@a.test`,
      tenantAId,
      createOnlyRole.id,
    );
    const ownerUser = await createUser(
      `owner-${run}-${seq}@a.test`,
      tenantAId,
      ownerRole.id,
    );

    const tenantB = await createTenant('b');
    tenantBId = tenantB.id;
    const adminRoleB = await grantRole(tenantBId, `admin-b-${run}`, [
      PERMISSIONS.BOOKING_READ,
      PERMISSIONS.BOOKING_CREATE,
      PERMISSIONS.BOOKING_MANAGE,
    ]);
    const adminBUser = await createUser(
      `admin-${run}-${seq}@b.test`,
      tenantBId,
      adminRoleB.id,
    );

    const outsider = await prisma.user.create({
      data: { email: `outsider-${run}-${seq}@x.test`, passwordHash: 'hash-x' },
    });
    userIdsToDelete.push(outsider.id);

    adminA = await loginAs(adminUser.id, tenantAId);
    employeeA = await loginAs(employeeUser.id, tenantAId);
    manageOnlyA = await loginAs(manageOnlyUser.id, tenantAId);
    createOnlyA = await loginAs(createOnlyUser.id, tenantAId);
    ownerA = await loginAs(ownerUser.id, tenantAId);
    adminB = await loginAs(adminBUser.id, tenantBId);

    // Create services and customers for tests
    // Service A in tenantA
    const svcA = await tenantContext.run(tenantAId, async () =>
      prisma.service.create({
        data: { name: `SvcA-${run}-${seq}`, status: 'ACTIVE' },
      }),
    );
    serviceAId = svcA.id;
    serviceIdsToDelete.push(svcA.id);

    // Service B in tenantA for "different services same time" test (same tenant)
    const svcB_A = await tenantContext.run(tenantAId, async () =>
      prisma.service.create({
        data: { name: `SvcB-${run}-${seq}`, status: 'ACTIVE' },
      }),
    );
    serviceBId = svcB_A.id;
    serviceIdsToDelete.push(svcB_A.id);

    // Service B in tenantB for cross-tenant tests
    const svcB_B = await tenantContext.run(tenantBId, async () =>
      prisma.service.create({
        data: { name: `SvcB-${run}-${seq}`, status: 'ACTIVE' },
      }),
    );
    serviceB_B_Id = svcB_B.id;
    serviceIdsToDelete.push(svcB_B.id);

    const custA = await tenantContext.run(tenantAId, async () =>
      prisma.customer.create({
        data: { name: `CustA-${run}-${seq}`, code: `CA-${run}-${seq}` },
      }),
    );
    customerAId = custA.id;
    customerIdsToDelete.push(custA.id);

    const custB = await tenantContext.run(tenantBId, async () =>
      prisma.customer.create({
        data: { name: `CustB-${run}-${seq}`, code: `CB-${run}-${seq}` },
      }),
    );
    customerBId = custB.id;
    customerIdsToDelete.push(custB.id);
  });

  const createBooking = async (
    headers: Record<string, string>,
    data: { serviceId: string; customerId?: string; startAt: string; endAt: string; status?: string },
  ) => call('post', '/bookings', headers, data);

  const baseTime = new Date('2026-09-02T10:00:00.000Z');

  describe('authentication and authorization gates', () => {
    it('rejects unauthenticated with 401 on every route', async () => {
      expect((await call('get', '/bookings', {})).status).toBe(401);
      expect((await call('get', '/bookings/x', {})).status).toBe(401);
      expect(
        (
          await call('post', '/bookings', {}, {
            serviceId: serviceAId,
            startAt: baseTime.toISOString(),
            endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await call('patch', '/bookings/x', {}, { status: 'CONFIRMED' })
        ).status,
      ).toBe(401);
    });

    it('rejects an outsider without membership with 403', async () => {
      const outsiderUser = await prisma.user.findUniqueOrThrow({
        where: { email: `outsider-${run}-${seq}@x.test` },
      });
      const headers = await loginAs(outsiderUser.id, tenantAId);
      expect((await call('get', '/bookings', headers)).status).toBe(403);
      expect(
        (
          await call('post', '/bookings', headers, {
            serviceId: serviceAId,
            startAt: baseTime.toISOString(),
            endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
          })
        ).status,
      ).toBe(403);
    });

    it('rejects a member without booking:read with 403 on GET', async () => {
      const noReadRole = await grantRole(tenantAId, `noread-${run}`, [
        PERMISSIONS.BOOKING_CREATE,
      ]);
      const noReadUser = await createUser(
        `noread-${run}-${seq}@a.test`,
        tenantAId,
        noReadRole.id,
      );
      const headers = await loginAs(noReadUser.id, tenantAId);
      expect((await call('get', '/bookings', headers)).status).toBe(403);
      expect((await call('get', '/bookings/x', headers)).status).toBe(403);
    });

    it('rejects a member without booking:create with 403 on POST', async () => {
      const employeeUser = await prisma.user.findUniqueOrThrow({
        where: { email: `employee-${run}-${seq}@a.test` },
      });
      const headers = await loginAs(employeeUser.id, tenantAId);
      expect(
        (
          await call('post', '/bookings', headers, {
            serviceId: serviceAId,
            startAt: baseTime.toISOString(),
            endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
          })
        ).status,
      ).toBe(403);
    });

    it('rejects a member without booking:manage with 403 on PATCH', async () => {
      const created = await createBooking(adminA, {
        serviceId: serviceAId,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
      });
      const bookingId = (created.body as BookingBody).id;
      expect(
        (
          await call('patch', `/bookings/${bookingId}`, employeeA, {
            status: 'CONFIRMED',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call('patch', `/bookings/${bookingId}`, createOnlyA, {
            status: 'CONFIRMED',
          })
        ).status,
      ).toBe(403);
    });

    it('manage-only can create and patch but cannot read', async () => {
      const created = await createBooking(manageOnlyA, {
        serviceId: serviceAId,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
      });
      expect(created.status).toBe(201);
      const bookingId = (created.body as BookingBody).id;
      const patched = await call('patch', `/bookings/${bookingId}`, manageOnlyA, {
        status: 'CONFIRMED',
      });
      expect(patched.status).toBe(200);
      expect((await call('get', '/bookings', manageOnlyA)).status).toBe(403);
      expect(
        (await call('get', `/bookings/${bookingId}`, manageOnlyA)).status,
      ).toBe(403);
    });

    it('create-only can create but cannot read or patch', async () => {
      const created = await createBooking(createOnlyA, {
        serviceId: serviceAId,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
      });
      expect(created.status).toBe(201);
      const bookingId = (created.body as BookingBody).id;
      expect((await call('get', '/bookings', createOnlyA)).status).toBe(403);
      expect(
        (
          await call('patch', `/bookings/${bookingId}`, createOnlyA, {
            status: 'CONFIRMED',
          })
        ).status,
      ).toBe(403);
    });

    it('owner semantic-all works without explicit grants', async () => {
      const created = await createBooking(ownerA, {
        serviceId: serviceAId,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
      });
      expect(created.status).toBe(201);
      expect((await call('get', '/bookings', ownerA)).status).toBe(200);
      const bookingId = (created.body as BookingBody).id;
      const patched = await call('patch', `/bookings/${bookingId}`, ownerA, {
        status: 'CONFIRMED',
      });
      expect(patched.status).toBe(200);
    });
  });

  describe('CRUD happy path and lifecycle', () => {
    it('creates with BOOKED default, patches through lifecycle, cancels', async () => {
      const created = await createBooking(adminA, {
        serviceId: serviceAId,
        customerId: customerAId,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
      });
      expect(created.status).toBe(201);
      let body = created.body as BookingBody;
      expect(body.status).toBe('BOOKED');
      expect(body.tenantId).toBe(tenantAId);
      expect(body.serviceId).toBe(serviceAId);
      expect(body.customerId).toBe(customerAId);

      // CONFIRMED
      const confirmed = await call('patch', `/bookings/${body.id}`, adminA, {
        status: 'CONFIRMED',
      });
      expect(confirmed.status).toBe(200);
      body = confirmed.body as BookingBody;
      expect(body.status).toBe('CONFIRMED');

      // ACTIVE
      const active = await call('patch', `/bookings/${body.id}`, adminA, {
        status: 'ACTIVE',
      });
      expect(active.status).toBe(200);
      body = active.body as BookingBody;
      expect(body.status).toBe('ACTIVE');

      // COMPLETED
      const completed = await call('patch', `/bookings/${body.id}`, adminA, {
        status: 'COMPLETED',
      });
      expect(completed.status).toBe(200);
      body = completed.body as BookingBody;
      expect(body.status).toBe('COMPLETED');

      // CANCELLED (soft retirement)
      const cancelled = await call('patch', `/bookings/${body.id}`, adminA, {
        status: 'CANCELLED',
      });
      expect(cancelled.status).toBe(200);
      expect((cancelled.body as BookingBody).status).toBe('CANCELLED');

      // NO_SHOW
      const noShow = await createBooking(adminA, {
        serviceId: serviceAId,
        startAt: new Date(baseTime.getTime() + 7200000).toISOString(),
        endAt: new Date(baseTime.getTime() + 10800000).toISOString(),
      });
      const ns = await call('patch', `/bookings/${(noShow.body as BookingBody).id}`, adminA, {
        status: 'NO_SHOW',
      });
      expect((ns.body as BookingBody).status).toBe('NO_SHOW');
    });

    it('create with explicit CONFIRMED status is honored', async () => {
      const created = await createBooking(adminA, {
        serviceId: serviceAId,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
        status: 'CONFIRMED',
      });
      expect((created.body as BookingBody).status).toBe('CONFIRMED');
    });

    it('create with optional customerId (walk-in) works', async () => {
      const created = await createBooking(adminA, {
        serviceId: serviceAId,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
      });
      expect(created.status).toBe(201);
      expect((created.body as BookingBody).customerId).toBeNull();
    });

    it('returns the canonical 404 for an unknown booking', async () => {
      const res = await call('get', '/bookings/no-such-booking', adminA);
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).message).toBe('Booking not found');
    });
  });

  describe('overlap protection (EXCLUDE constraint)', () => {
    it('rejects an overlapping booking for the same service with 409', async () => {
      const start = baseTime.toISOString();
      const end = new Date(baseTime.getTime() + 3600000).toISOString();
      await createBooking(adminA, { serviceId: serviceAId, startAt: start, endAt: end });
      const overlap = await createBooking(adminA, {
        serviceId: serviceAId,
        startAt: start,
        endAt: end,
      });
      expect(overlap.status).toBe(409);
      expect((overlap.body as ErrorBody).message).toBe(
        'Another booking for this service overlaps the requested time',
      );
      // Exactly one row exists.
      const count = await tenantContext.run(tenantAId, async () =>
        prisma.booking.count({ where: { tenantId: tenantAId, serviceId: serviceAId } }),
      );
      expect(count).toBe(1);
    });

    it('allows back-to-back bookings (half-open interval)', async () => {
      const t1 = baseTime.toISOString();
      const t2 = new Date(baseTime.getTime() + 3600000).toISOString();
      const t3 = new Date(baseTime.getTime() + 7200000).toISOString();
      const b1 = await createBooking(adminA, { serviceId: serviceAId, startAt: t1, endAt: t2 });
      expect(b1.status).toBe(201);
      const b2 = await createBooking(adminA, { serviceId: serviceAId, startAt: t2, endAt: t3 });
      expect(b2.status).toBe(201);
    });

    it('allows same time for different services', async () => {
      const start = baseTime.toISOString();
      const end = new Date(baseTime.getTime() + 3600000).toISOString();
      await createBooking(adminA, { serviceId: serviceAId, startAt: start, endAt: end });
      const b2 = await createBooking(adminA, { serviceId: serviceBId, startAt: start, endAt: end });
      expect(b2.status).toBe(201);
    });

    it('allows same service at same time in different tenants', async () => {
      const start = baseTime.toISOString();
      const end = new Date(baseTime.getTime() + 3600000).toISOString();
      await createBooking(adminA, { serviceId: serviceAId, startAt: start, endAt: end });
      const b2 = await createBooking(adminB, { serviceId: serviceB_B_Id, startAt: start, endAt: end });
      expect(b2.status).toBe(201);
    });

    it('rejects overlap on update (rename time)', async () => {
      const t1 = baseTime.toISOString();
      const t2 = new Date(baseTime.getTime() + 3600000).toISOString();
      const t3 = new Date(baseTime.getTime() + 7200000).toISOString();
      const b1 = await createBooking(adminA, { serviceId: serviceAId, startAt: t1, endAt: t2 });
      const b2 = await createBooking(adminA, { serviceId: serviceAId, startAt: t2, endAt: t3 });
      expect(b1.status).toBe(201);
      expect(b2.status).toBe(201);
      const res = await call('patch', `/bookings/${(b2.body as BookingBody).id}`, adminA, {
        startAt: t1,
        endAt: t3,
      });
      expect(res.status).toBe(409);
    });

    it('concurrent overlapping creation: DB EXCLUDE arbitrates (exactly one row)', async () => {
      const start = baseTime.toISOString();
      const end = new Date(baseTime.getTime() + 3600000).toISOString();
      const [a, b] = await Promise.all([
        createBooking(adminA, { serviceId: serviceAId, startAt: start, endAt: end }),
        createBooking(adminA, { serviceId: serviceAId, startAt: start, endAt: end }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      const count = await tenantContext.run(tenantAId, async () =>
        prisma.booking.count({ where: { tenantId: tenantAId, serviceId: serviceAId } }),
      );
      expect(count).toBe(1);
    });
  });

  describe('tenant isolation / IDOR', () => {
    it('hides a foreign booking with the uniform 404 (GET and PATCH)', async () => {
      const createdB = await createBooking(adminB, {
        serviceId: serviceB_B_Id,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
      });
      const bId = (createdB.body as BookingBody).id;

      expect((await call('get', `/bookings/${bId}`, adminA)).status).toBe(404);
      expect(
        (
          await call('patch', `/bookings/${bId}`, adminA, { status: 'CONFIRMED' })
        ).status,
      ).toBe(404);
      // The foreign row is untouched.
      const row = await tenantContext.run(tenantBId, async () =>
        prisma.booking.findUniqueOrThrow({ where: { id: bId } }),
      );
      expect(row.status).toBe('BOOKED');

      // Reverse direction: B cannot see A's booking either.
      const createdA = await createBooking(adminA, {
        serviceId: serviceAId,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
      });
      expect(
        (
          await call(
            'get',
            `/bookings/${(createdA.body as BookingBody).id}`,
            adminB,
          )
        ).status,
      ).toBe(404);
    });

    it('lists are isolated per X-Tenant-ID', async () => {
      await createBooking(adminA, {
        serviceId: serviceAId,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
      });
      await createBooking(adminB, {
        serviceId: serviceB_B_Id,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
      });
      const listA = await call('get', '/bookings', adminA);
      const listB = await call('get', '/bookings', adminB);
      const idsA = ((listA.body as { data: BookingBody[] }).data || []).map((s) => s.id);
      const idsB = ((listB.body as { data: BookingBody[] }).data || []).map((s) => s.id);
      expect(idsA.length).toBeGreaterThan(0);
      expect(idsB.length).toBeGreaterThan(0);
      expect(idsA.some((id) => idsB.includes(id))).toBe(false);
    });

    it('direct prisma reads are scoped by the ambient tenant context', async () => {
      const created = await createBooking(adminA, {
        serviceId: serviceAId,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
      });
      const bId = (created.body as BookingBody).id;
      const inA = await tenantContext.run(tenantAId, async () =>
        prisma.booking.findUnique({ where: { id: bId } }),
      );
      expect(inA?.id).toBe(bId);
      const inB = await tenantContext.run(tenantBId, async () =>
        prisma.booking.findUnique({ where: { id: bId } }),
      );
      expect(inB).toBeNull();
    });
  });

  describe('validation contract', () => {
    it('rejects missing/invalid required fields with 400', async () => {
      const cases: Array<Record<string, unknown>> = [
        {},
        { serviceId: 'not-a-uuid' },
        { serviceId: serviceAId, startAt: 'not-a-date' },
        { serviceId: serviceAId, startAt: baseTime.toISOString(), endAt: 'not-a-date' },
        { serviceId: serviceAId, startAt: baseTime.toISOString(), endAt: baseTime.toISOString() }, // end not > start (DB CHECK)
      ];
      for (const payload of cases) {
        expect(
          (
            await call('post', '/bookings', adminA, payload)
          ).status,
        ).toBe(400);
      }
    });

    it('rejects ownership-field injections on create with 400', async () => {
      const base = {
        serviceId: serviceAId,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
      };
      const injections = [
        { ...base, tenantId: tenantBId },
        { ...base, id: 'bkg-1' },
        { ...base, createdAt: new Date().toISOString() },
        { ...base, updatedAt: new Date().toISOString() },
        { ...base, bogus: true },
      ];
      for (const payload of injections) {
        const res = await call('post', '/bookings', adminA, payload);
        expect(res.status).toBe(400);
      }
      const rows = await tenantContext.run(tenantAId, async () =>
        prisma.booking.count({ where: { tenantId: tenantAId } }),
      );
      expect(rows).toBe(0);
    });

    it('rejects deferred-domain field injections (staff/resource/schedule/pricing) with 400', async () => {
      const base = {
        serviceId: serviceAId,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
      };
      const injections = [
        { ...base, staffId: 's' },
        { ...base, resourceId: 'r' },
        { ...base, scheduleId: 'sc' },
        { ...base, price: 100 },
        { ...base, amountMinor: 1000 },
        { ...base, currency: 'USD' },
      ];
      for (const payload of injections) {
        const res = await call('post', '/bookings', adminA, payload);
        expect(res.status).toBe(400);
      }
    });

    it('rejects ownership-field injections on update with 400', async () => {
      const created = await createBooking(adminA, {
        serviceId: serviceAId,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
      });
      const bId = (created.body as BookingBody).id;
      const injections = [
        { tenantId: tenantBId },
        { id: 'bkg-9' },
        { createdAt: new Date().toISOString() },
        { bogus: 1 },
      ];
      for (const payload of injections) {
        const res = await call('patch', `/bookings/${bId}`, adminA, payload);
        expect(res.status).toBe(400);
      }
      // The row is unchanged after the rejected patches.
      const row = await tenantContext.run(tenantAId, async () =>
        prisma.booking.findUniqueOrThrow({ where: { id: bId } }),
      );
      expect(row.status).toBe('BOOKED');
    });

    it('rejects invalid status enum', async () => {
      const res = await createBooking(adminA, {
        serviceId: serviceAId,
        startAt: baseTime.toISOString(),
        endAt: new Date(baseTime.getTime() + 3600000).toISOString(),
        status: 'INVALID',
      });
      expect(res.status).toBe(400);
    });

    it('rejects endAt <= startAt (DB CHECK)', async () => {
      const start = baseTime.toISOString();
      const res = await createBooking(adminA, {
        serviceId: serviceAId,
        startAt: start,
        endAt: start,
      });
      expect(res.status).toBe(400);
    });
  });

  describe('pagination (keyset envelope parity)', () => {
    it('returns the envelope, chains cursors, and filters by status/serviceId/customerId', async () => {
      // Create 4 bookings: 3 BOOKED + 1 CANCELLED.
      for (let i = 0; i < 3; i++) {
        const start = new Date(baseTime.getTime() + i * 3600000).toISOString();
        const end = new Date(baseTime.getTime() + (i + 1) * 3600000).toISOString();
        await createBooking(adminA, {
          serviceId: serviceAId,
          startAt: start,
          endAt: end,
        });
      }
      const cancelled = await createBooking(adminA, {
        serviceId: serviceAId,
        startAt: new Date(baseTime.getTime() + 10800000).toISOString(),
        endAt: new Date(baseTime.getTime() + 14400000).toISOString(),
        status: 'CANCELLED',
      });
      expect(cancelled.status).toBe(201);

      const page1 = await call('get', '/bookings?limit=2', adminA);
      expect(page1.status).toBe(200);
      const body1 = page1.body as {
        data: BookingBody[];
        meta: { nextCursor: string | null };
      };
      expect(body1.data.length).toBe(2);
      expect(body1.meta.nextCursor).not.toBeNull();

      const page2 = await call(
        'get',
        `/bookings?limit=2&cursor=${encodeURIComponent(body1.meta.nextCursor!)}`,
        adminA,
      );
      const body2 = page2.body as {
        data: BookingBody[];
        meta: { nextCursor: string | null };
      };
      const ids1 = body1.data.map((s) => s.id);
      const ids2 = body2.data.map((s) => s.id);
      expect(ids1.some((id) => ids2.includes(id))).toBe(false);

      // Status filter.
      const bookedOnly = await call('get', '/bookings?status=BOOKED', adminA);
      const bookedBody = bookedOnly.body as { data: BookingBody[] };
      expect(bookedBody.data.every((s) => s.status === 'BOOKED')).toBe(true);
      expect(bookedBody.data.length).toBeGreaterThanOrEqual(3);

      // ServiceId filter.
      const svcFilter = await call('get', `/bookings?serviceId=${serviceAId}`, adminA);
      const svcBody = svcFilter.body as { data: BookingBody[] };
      expect(svcBody.data.every((s) => s.serviceId === serviceAId)).toBe(true);

      // CustomerId filter.
      const custFilter = await call('get', `/bookings?customerId=${customerAId}`, adminA);
      const custBody = custFilter.body as { data: BookingBody[] };
      expect(custBody.data.every((s) => s.customerId === customerAId)).toBe(true);

      const badStatus = await call('get', '/bookings?status=INVALID', adminA);
      expect(badStatus.status).toBe(400);

      const badCursor = await call('get', '/bookings?cursor=garbage', adminA);
      expect(badCursor.status).toBe(400);
    });
  });
});