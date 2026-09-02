import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateServiceDto,
  ServiceListQueryDto,
  UpdateServiceDto,
} from './service.dto';

describe('Service DTOs', () => {
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  describe('CreateServiceDto', () => {
    it('accepts a minimal valid payload', async () => {
      expect(
        await validateLike(CreateServiceDto, { name: 'Haircut' }),
      ).toHaveLength(0);
    });

    it('accepts name + description + a valid status', async () => {
      expect(
        await validateLike(CreateServiceDto, {
          name: 'Haircut',
          description: 'A standard haircut',
          status: 'ACTIVE',
        }),
      ).toHaveLength(0);
    });

    it('rejects a missing or empty name', async () => {
      expect((await validateLike(CreateServiceDto, {})).length).toBeGreaterThan(
        0,
      );
      expect(
        (await validateLike(CreateServiceDto, { name: '' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects a name exceeding max length', async () => {
      expect(
        (await validateLike(CreateServiceDto, { name: 'x'.repeat(201) }))
          .length,
      ).toBeGreaterThan(0);
    });

    it('rejects an invalid status value', async () => {
      expect(
        (await validateLike(CreateServiceDto, { name: 'x', status: 'OPEN' }))
          .length,
      ).toBeGreaterThan(0);
    });

    it('rejects ownership-field injections with 400', async () => {
      const injections = [
        { name: 'x', tenantId: 't' },
        { name: 'x', id: 'svc-1' },
        { name: 'x', createdAt: new Date().toISOString() },
        { name: 'x', updatedAt: new Date().toISOString() },
        { name: 'x', bogus: true },
      ];
      for (const payload of injections) {
        expect(
          (await validateLike(CreateServiceDto, payload)).length,
        ).toBeGreaterThan(0);
      }
    });

    it('rejects deferred-domain field injections (pricing/duration/booking)', async () => {
      const injections = [
        { name: 'x', price: 100 },
        { name: 'x', amountMinor: 1000 },
        { name: 'x', currency: 'USD' },
        { name: 'x', durationMinutes: 30 },
        { name: 'x', staffId: 's' },
        { name: 'x', resourceId: 'r' },
        { name: 'x', bookingId: 'b' },
        { name: 'x', scheduleId: 'sc' },
      ];
      for (const payload of injections) {
        expect(
          (await validateLike(CreateServiceDto, payload)).length,
        ).toBeGreaterThan(0);
      }
    });
  });

  describe('UpdateServiceDto', () => {
    it('accepts an empty patch (no-op) and partial fields', async () => {
      expect(await validateLike(UpdateServiceDto, {})).toHaveLength(0);
      expect(
        await validateLike(UpdateServiceDto, { description: 'd' }),
      ).toHaveLength(0);
      expect(
        await validateLike(UpdateServiceDto, { status: 'ARCHIVED' }),
      ).toHaveLength(0);
    });

    it('rejects an invalid status', async () => {
      expect(
        (await validateLike(UpdateServiceDto, { status: 'OPEN' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects ownership-field injections on update', async () => {
      const injections = [
        { tenantId: 't' },
        { id: 'svc-1' },
        { createdAt: new Date().toISOString() },
        { bogus: 1 },
      ];
      for (const payload of injections) {
        expect(
          (await validateLike(UpdateServiceDto, payload)).length,
        ).toBeGreaterThan(0);
      }
    });
  });

  describe('ServiceListQueryDto', () => {
    it('accepts an empty query and a valid status filter', async () => {
      expect(await validateLike(ServiceListQueryDto, {})).toHaveLength(0);
      expect(
        await validateLike(ServiceListQueryDto, { status: 'ACTIVE' }),
      ).toHaveLength(0);
    });

    it('rejects an invalid status and unknown fields', async () => {
      expect(
        (await validateLike(ServiceListQueryDto, { status: 'OPEN' })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(ServiceListQueryDto, { bogus: 1 })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects tenantId injection via query', async () => {
      expect(
        (await validateLike(ServiceListQueryDto, { tenantId: 't' })).length,
      ).toBeGreaterThan(0);
    });
  });
});
