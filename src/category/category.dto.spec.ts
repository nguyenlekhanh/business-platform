import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CategoryListQueryDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './dto/category.dto';

describe('Category DTOs', () => {
  // Mirrors the controller ValidationPipe options so these unit tests verify
  // exactly what the HTTP layer enforces (whitelist + forbidNonWhitelisted).
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  describe('CreateCategoryDto', () => {
    const valid = { name: 'Beverages' };

    it('accepts a valid create payload', async () => {
      const errors = await validateLike(CreateCategoryDto, valid);
      expect(errors).toHaveLength(0);
    });

    it('accepts an optional description', async () => {
      const errors = await validateLike(CreateCategoryDto, {
        ...valid,
        description: 'Drinks and similar',
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects a missing name', async () => {
      const errors = await validateLike(CreateCategoryDto, {});
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an empty name', async () => {
      const errors = await validateLike(CreateCategoryDto, { name: '' });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a non-string name', async () => {
      const errors = await validateLike(CreateCategoryDto, { name: 42 });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a too-long name', async () => {
      const errors = await validateLike(CreateCategoryDto, {
        name: 'x'.repeat(201),
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a non-string description', async () => {
      const errors = await validateLike(CreateCategoryDto, {
        ...valid,
        description: { text: 'nope' },
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client tenantId (forbidden non-whitelisted)', async () => {
      const errors = await validateLike(CreateCategoryDto, {
        ...valid,
        tenantId: 'tenant-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects unknown fields (forbidden non-whitelisted)', async () => {
      const errors = await validateLike(CreateCategoryDto, {
        ...valid,
        bogus: true,
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('UpdateCategoryDto', () => {
    it('accepts an empty update (no-op patch)', async () => {
      const errors = await validateLike(UpdateCategoryDto, {});
      expect(errors).toHaveLength(0);
    });

    it('accepts name-only and description-only patches', async () => {
      expect(
        await validateLike(UpdateCategoryDto, { name: 'New Name' }),
      ).toHaveLength(0);
      expect(
        await validateLike(UpdateCategoryDto, { description: 'd' }),
      ).toHaveLength(0);
    });

    it('rejects an empty-string name (IsNotEmpty on optional field when present)', async () => {
      const errors = await validateLike(UpdateCategoryDto, { name: '' });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a body id/tenantId (forbidden non-whitelisted)', async () => {
      expect(
        await validateLike(UpdateCategoryDto, { id: 'cat-1' }),
      ).toHaveLength(1);
      expect(
        await validateLike(UpdateCategoryDto, { tenantId: 'tenant-9' }),
      ).toHaveLength(1);
    });
  });

  describe('CategoryListQueryDto', () => {
    it('accepts empty query and valid limit/cursor/order', async () => {
      expect(await validateLike(CategoryListQueryDto, {})).toHaveLength(0);
      expect(
        await validateLike(CategoryListQueryDto, {
          limit: '5',
          cursor: 'abc',
          order: 'desc',
        }),
      ).toHaveLength(0);
    });

    it('rejects limit above the hard maximum', async () => {
      const errors = await validateLike(CategoryListQueryDto, {
        limit: '101',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects unknown query fields incl. tenantId', async () => {
      expect(
        await validateLike(CategoryListQueryDto, { status: 'ACTIVE' }),
      ).toHaveLength(1);
      expect(
        await validateLike(CategoryListQueryDto, { tenantId: 'tenant-9' }),
      ).toHaveLength(1);
    });
  });
});
