import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEquipmentDto, UpdateEquipmentDto } from './equipment.dto';

describe('Equipment DTOs', () => {
  // Mirrors the controller ValidationPipe options so these unit tests verify
  // exactly what the HTTP layer enforces (whitelist + forbidNonWhitelisted).
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  const valid = {
    assetId: 'asset-1',
    type: 'CRANE',
  };

  describe('CreateEquipmentDto', () => {
    it('accepts a valid create payload', async () => {
      const errors = await validateLike(CreateEquipmentDto, valid);
      expect(errors).toHaveLength(0);
    });

    it('accepts optional identity fields', async () => {
      const errors = await validateLike(CreateEquipmentDto, {
        ...valid,
        manufacturer: 'Liebherr',
        model: 'LR 1300',
        serialNumber: 'SN-001',
        year: 2021,
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects a missing assetId', async () => {
      const errors = await validateLike(CreateEquipmentDto, {
        type: 'CRANE',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an empty assetId', async () => {
      const errors = await validateLike(CreateEquipmentDto, {
        ...valid,
        assetId: '',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an invalid equipment type', async () => {
      const errors = await validateLike(CreateEquipmentDto, {
        ...valid,
        type: 'BOBCAT',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a non-integer year', async () => {
      const errors = await validateLike(CreateEquipmentDto, {
        ...valid,
        year: 20.5,
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a year out of range', async () => {
      const errors = await validateLike(CreateEquipmentDto, {
        ...valid,
        year: 1800,
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied tenantId (forbidNonWhitelisted)', async () => {
      const errors = await validateLike(CreateEquipmentDto, {
        ...valid,
        tenantId: 'tenant-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects arbitrary unknown fields (roleId/permissionIds)', async () => {
      const errors = await validateLike(CreateEquipmentDto, {
        ...valid,
        roleId: 'role-9',
        permissionIds: ['perm-1'],
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('UpdateEquipmentDto', () => {
    it('accepts a partial update', async () => {
      const errors = await validateLike(UpdateEquipmentDto, {
        manufacturer: 'XCMG',
        year: 2019,
      });
      expect(errors).toHaveLength(0);
    });

    it('does not allow re-parenting via assetId (not whitelisted)', async () => {
      const errors = await validateLike(UpdateEquipmentDto, {
        assetId: 'asset-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an invalid type', async () => {
      const errors = await validateLike(UpdateEquipmentDto, {
        type: 'HELICOPTER',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied tenantId', async () => {
      const errors = await validateLike(UpdateEquipmentDto, {
        tenantId: 'tenant-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
