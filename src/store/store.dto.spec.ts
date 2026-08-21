import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateStoreDto, UpdateStoreDto } from './dto/store.dto';

describe('Store DTOs', () => {
  // Mirrors the controller ValidationPipe options so these unit tests verify
  // exactly what the HTTP layer enforces (whitelist + forbidNonWhitelisted).
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  describe('CreateStoreDto', () => {
    const valid = {
      name: 'Main Store',
      code: 'main',
      type: 'SHOP',
    };

    it('accepts a valid create payload', async () => {
      const errors = await validateLike(CreateStoreDto, valid);
      expect(errors).toHaveLength(0);
    });

    it('accepts optional status and settings', async () => {
      const errors = await validateLike(CreateStoreDto, {
        ...valid,
        status: 'INACTIVE',
        settings: { theme: 'dark' },
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects a missing name', async () => {
      const errors = await validateLike(CreateStoreDto, {
        code: 'main',
        type: 'SHOP',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an empty name', async () => {
      const errors = await validateLike(CreateStoreDto, {
        ...valid,
        name: '',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a missing code', async () => {
      const errors = await validateLike(CreateStoreDto, {
        name: 'Main Store',
        type: 'SHOP',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a missing type', async () => {
      const errors = await validateLike(CreateStoreDto, {
        name: 'Main Store',
        code: 'main',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an invalid type', async () => {
      const errors = await validateLike(CreateStoreDto, {
        ...valid,
        type: 'WAREHOUSE',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an invalid status', async () => {
      const errors = await validateLike(CreateStoreDto, {
        ...valid,
        status: 'ARCHIVED',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects non-object settings', async () => {
      const errors = await validateLike(CreateStoreDto, {
        ...valid,
        settings: 'not-an-object',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied tenantId', async () => {
      const errors = await validateLike(CreateStoreDto, {
        ...valid,
        tenantId: 'tenant-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied id', async () => {
      const errors = await validateLike(CreateStoreDto, {
        ...valid,
        id: 'store-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an unknown field', async () => {
      const errors = await validateLike(CreateStoreDto, {
        ...valid,
        rentalRates: { crane: 100 },
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('UpdateStoreDto', () => {
    const valid = {
      name: 'Renamed Store',
      code: 'renamed',
      type: 'CAFE',
      status: 'INACTIVE',
      settings: { theme: 'light' },
    };

    it('accepts a valid update payload', async () => {
      const errors = await validateLike(UpdateStoreDto, valid);
      expect(errors).toHaveLength(0);
    });

    it('accepts a partial update', async () => {
      const errors = await validateLike(UpdateStoreDto, { name: 'Renamed' });
      expect(errors).toHaveLength(0);
    });

    it('rejects an invalid type', async () => {
      const errors = await validateLike(UpdateStoreDto, {
        type: 'NOT_A_TYPE',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an invalid status', async () => {
      const errors = await validateLike(UpdateStoreDto, {
        status: 'NOT_A_STATUS',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied tenantId', async () => {
      const errors = await validateLike(UpdateStoreDto, {
        tenantId: 'tenant-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied id', async () => {
      const errors = await validateLike(UpdateStoreDto, { id: 'store-9' });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an unknown field', async () => {
      const errors = await validateLike(UpdateStoreDto, {
        isRentalUnit: true,
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects non-object settings', async () => {
      const errors = await validateLike(UpdateStoreDto, { settings: [1, 2] });
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
