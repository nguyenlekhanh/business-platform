import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateReservationDto, UpdateReservationDto } from './reservation.dto';

describe('Reservation DTOs', () => {
  // Mirrors the controller ValidationPipe options so these unit tests verify
  // exactly what the HTTP layer enforces (whitelist + forbidNonWhitelisted).
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  const valid = {
    customerId: 'cust-1',
    equipmentId: 'equip-1',
    startAt: '2026-06-01T10:00:00.000Z',
    endAt: '2026-06-01T14:00:00.000Z',
  };

  describe('CreateReservationDto', () => {
    it('accepts a minimal valid create payload', async () => {
      const errors = await validateLike(CreateReservationDto, valid);
      expect(errors).toHaveLength(0);
    });

    it('accepts optional notes', async () => {
      const errors = await validateLike(CreateReservationDto, {
        ...valid,
        notes: 'Deliver by crane pad',
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects a missing customerId', async () => {
      const errors = await validateLike(CreateReservationDto, {
        equipmentId: 'equip-1',
        startAt: '2026-06-01T10:00:00.000Z',
        endAt: '2026-06-01T14:00:00.000Z',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a missing equipmentId', async () => {
      const errors = await validateLike(CreateReservationDto, {
        customerId: 'cust-1',
        startAt: '2026-06-01T10:00:00.000Z',
        endAt: '2026-06-01T14:00:00.000Z',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a non-ISO startAt', async () => {
      const errors = await validateLike(CreateReservationDto, {
        ...valid,
        startAt: 'tomorrow morning',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a non-ISO endAt', async () => {
      const errors = await validateLike(CreateReservationDto, {
        ...valid,
        endAt: '06/01/2026 2pm',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied status (server-controlled lifecycle)', async () => {
      const errors = await validateLike(CreateReservationDto, {
        ...valid,
        status: 'ACTIVE',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied tenantId', async () => {
      const errors = await validateLike(CreateReservationDto, {
        ...valid,
        tenantId: 'tenant-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied id', async () => {
      const errors = await validateLike(CreateReservationDto, {
        ...valid,
        id: 'resv-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects arbitrary internal fields (userId/roleId/storeId/assetId/code/type)', async () => {
      const errors = await validateLike(CreateReservationDto, {
        ...valid,
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
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('UpdateReservationDto', () => {
    it('accepts a partial time update', async () => {
      const errors = await validateLike(UpdateReservationDto, {
        endAt: '2026-06-01T16:00:00.000Z',
      });
      expect(errors).toHaveLength(0);
    });

    it('accepts a notes-only update', async () => {
      const errors = await validateLike(UpdateReservationDto, {
        notes: 'Updated note',
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects re-parenting via customerId (immutable link)', async () => {
      const errors = await validateLike(UpdateReservationDto, {
        customerId: 'cust-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects re-parenting via equipmentId (immutable link)', async () => {
      const errors = await validateLike(UpdateReservationDto, {
        equipmentId: 'equip-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects status manipulation', async () => {
      const errors = await validateLike(UpdateReservationDto, {
        status: 'CANCELLED',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied tenantId', async () => {
      const errors = await validateLike(UpdateReservationDto, {
        tenantId: 'tenant-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects timestamps fields (createdAt/updatedAt)', async () => {
      const errors = await validateLike(UpdateReservationDto, {
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
