import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreatePosDeviceDto,
  OpenPosSessionDto,
  PosDeviceListQueryDto,
  UpdatePosDeviceDto,
} from './pos.dto';

describe('POS DTOs', () => {
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  describe('CreatePosDeviceDto', () => {
    it('accepts valid storeId and name', async () => {
      expect(
        await validateLike(CreatePosDeviceDto, {
          storeId: 'store-1',
          name: 'Front counter',
        }),
      ).toHaveLength(0);
    });

    it('rejects missing storeId or name', async () => {
      expect(
        (await validateLike(CreatePosDeviceDto, { name: 'x' })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(CreatePosDeviceDto, { storeId: 's' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects empty strings', async () => {
      expect(
        (await validateLike(CreatePosDeviceDto, { storeId: '', name: 'x' }))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(CreatePosDeviceDto, { storeId: 's', name: '' }))
          .length,
      ).toBeGreaterThan(0);
    });

    it('rejects name exceeding max length', async () => {
      expect(
        (
          await validateLike(CreatePosDeviceDto, {
            storeId: 's',
            name: 'x'.repeat(201),
          })
        ).length,
      ).toBeGreaterThan(0);
    });

    it('rejects tenantId, status, credentialHash, id, timestamps, unknown fields', async () => {
      const injections = [
        { storeId: 's', name: 'x', tenantId: 't' },
        { storeId: 's', name: 'x', status: 'ACTIVE' },
        { storeId: 's', name: 'x', credentialHash: 'h' },
        { storeId: 's', name: 'x', credential: 'c' },
        { storeId: 's', name: 'x', id: 'd' },
        { storeId: 's', name: 'x', createdAt: new Date().toISOString() },
        { storeId: 's', name: 'x', bogus: true },
      ];
      for (const payload of injections) {
        expect(
          (await validateLike(CreatePosDeviceDto, payload)).length,
        ).toBeGreaterThan(0);
      }
    });
  });

  describe('UpdatePosDeviceDto', () => {
    it('accepts a name-only patch', async () => {
      expect(
        await validateLike(UpdatePosDeviceDto, { name: 'Renamed' }),
      ).toHaveLength(0);
    });

    it('accepts an empty patch', async () => {
      expect(await validateLike(UpdatePosDeviceDto, {})).toHaveLength(0);
    });

    it('rejects storeId (A5: permanent binding)', async () => {
      expect(
        (await validateLike(UpdatePosDeviceDto, { storeId: 'other' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects status (lifecycle endpoints only)', async () => {
      expect(
        (await validateLike(UpdatePosDeviceDto, { status: 'RETIRED' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects unknown fields', async () => {
      expect(
        (await validateLike(UpdatePosDeviceDto, { bogus: 1 })).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('PosDeviceListQueryDto', () => {
    it('accepts empty and valid status filter', async () => {
      expect(await validateLike(PosDeviceListQueryDto, {})).toHaveLength(0);
      expect(
        await validateLike(PosDeviceListQueryDto, { status: 'ACTIVE' }),
      ).toHaveLength(0);
    });

    it('rejects invalid status and unknown fields', async () => {
      expect(
        (await validateLike(PosDeviceListQueryDto, { status: 'BAD' })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(PosDeviceListQueryDto, { bogus: 1 })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects tenantId injection', async () => {
      expect(
        (await validateLike(PosDeviceListQueryDto, { tenantId: 't' })).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('OpenPosSessionDto', () => {
    it('accepts valid deviceId', async () => {
      expect(
        await validateLike(OpenPosSessionDto, { deviceId: 'd' }),
      ).toHaveLength(0);
    });

    it('rejects missing or empty deviceId', async () => {
      expect(
        (await validateLike(OpenPosSessionDto, {})).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(OpenPosSessionDto, { deviceId: '' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects storeId, tenantId, userId, status, timestamps, unknown fields', async () => {
      const injections = [
        { deviceId: 'd', storeId: 's' },
        { deviceId: 'd', tenantId: 't' },
        { deviceId: 'd', userId: 'u' },
        { deviceId: 'd', status: 'OPEN' },
        { deviceId: 'd', openedAt: new Date().toISOString() },
        { deviceId: 'd', bogus: true },
      ];
      for (const payload of injections) {
        expect(
          (await validateLike(OpenPosSessionDto, payload)).length,
        ).toBeGreaterThan(0);
      }
    });
  });
});
