import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AssetStatus } from '@prisma/client';
import { CreateAssetDto, UpdateAssetDto } from './asset.dto';

describe('Asset DTOs', () => {
  // Mirrors the controller ValidationPipe options so these unit tests verify
  // exactly what the HTTP layer enforces (whitelist + forbidNonWhitelisted).
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  const valid = {
    name: 'Tower Crane',
    code: 'crane-01',
    type: 'crane',
  };

  describe('CreateAssetDto', () => {
    it('accepts a valid create payload', async () => {
      const errors = await validateLike(CreateAssetDto, valid);
      expect(errors).toHaveLength(0);
    });

    it('accepts optional description, status, storeId and settings', async () => {
      const errors = await validateLike(CreateAssetDto, {
        ...valid,
        description: 'Site crane',
        status: AssetStatus.INACTIVE,
        storeId: 'store-1',
        settings: { unit: 'tonnes' },
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects a missing name', async () => {
      const errors = await validateLike(CreateAssetDto, {
        code: 'crane-01',
        type: 'crane',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an empty name', async () => {
      const errors = await validateLike(CreateAssetDto, { ...valid, name: '' });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an oversized name', async () => {
      const errors = await validateLike(CreateAssetDto, {
        ...valid,
        name: 'n'.repeat(201),
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a missing code', async () => {
      const errors = await validateLike(CreateAssetDto, {
        name: 'X',
        type: 'crane',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a missing type', async () => {
      const errors = await validateLike(CreateAssetDto, {
        name: 'X',
        code: 'c1',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a missing/invalid type', async () => {
      const errors = await validateLike(CreateAssetDto, { ...valid, type: '' });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an invalid status', async () => {
      const errors = await validateLike(CreateAssetDto, {
        ...valid,
        status: 'ARCHIVED',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects non-object settings', async () => {
      const errors = await validateLike(CreateAssetDto, {
        ...valid,
        settings: 'not-an-object',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied tenantId', async () => {
      const errors = await validateLike(CreateAssetDto, {
        ...valid,
        tenantId: 'tenant-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied id', async () => {
      const errors = await validateLike(CreateAssetDto, {
        ...valid,
        id: 'asset-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied createdAt', async () => {
      const errors = await validateLike(CreateAssetDto, {
        ...valid,
        createdAt: new Date().toISOString(),
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an unknown field', async () => {
      const errors = await validateLike(CreateAssetDto, {
        ...valid,
        rentalPrice: 100,
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('UpdateAssetDto', () => {
    const validUpdate = { name: 'Renamed', code: 'renamed', type: 'vehicle' };

    it('accepts a valid full update payload', async () => {
      const errors = await validateLike(UpdateAssetDto, {
        ...validUpdate,
        description: 'Updated',
        status: AssetStatus.INACTIVE,
        storeId: 'store-1',
        settings: { theme: 'light' },
      });
      expect(errors).toHaveLength(0);
    });

    it('accepts a partial update', async () => {
      const errors = await validateLike(UpdateAssetDto, { name: 'Renamed' });
      expect(errors).toHaveLength(0);
    });

    it('rejects an invalid status', async () => {
      const errors = await validateLike(UpdateAssetDto, {
        status: 'NOT_A_STATUS',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a non-string storeId on update', async () => {
      const errors = await validateLike(UpdateAssetDto, {
        storeId: 12345,
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied tenantId', async () => {
      const errors = await validateLike(UpdateAssetDto, {
        tenantId: 'tenant-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied id', async () => {
      const errors = await validateLike(UpdateAssetDto, { id: 'asset-9' });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied createdAt', async () => {
      const errors = await validateLike(UpdateAssetDto, {
        createdAt: new Date().toISOString(),
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an unknown field', async () => {
      const errors = await validateLike(UpdateAssetDto, {
        isRentalUnit: true,
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects non-object settings', async () => {
      const errors = await validateLike(UpdateAssetDto, { settings: [1, 2] });
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
