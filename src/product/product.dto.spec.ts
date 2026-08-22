import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateProductDto,
  ProductListQueryDto,
  UpdateProductDto,
} from './dto/product.dto';

describe('Product DTOs', () => {
  // Mirrors the controller ValidationPipe options so these unit tests verify
  // exactly what the HTTP layer enforces (whitelist + forbidNonWhitelisted).
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  describe('CreateProductDto', () => {
    const valid = { name: 'Espresso Beans', code: 'ESP-1' };

    it('accepts a valid create payload', async () => {
      const errors = await validateLike(CreateProductDto, valid);
      expect(errors).toHaveLength(0);
    });

    it('accepts optional categoryId/description/status', async () => {
      const errors = await validateLike(CreateProductDto, {
        ...valid,
        categoryId: 'cat-1',
        description: 'Dark roast',
        status: 'ACTIVE',
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects a missing name', async () => {
      const errors = await validateLike(CreateProductDto, { code: 'ESP-1' });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an empty or non-string name', async () => {
      expect(
        (await validateLike(CreateProductDto, { ...valid, name: '' })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(CreateProductDto, { ...valid, name: 7 })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects a missing code', async () => {
      const errors = await validateLike(CreateProductDto, {
        name: 'Espresso Beans',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a too-long code', async () => {
      const errors = await validateLike(CreateProductDto, {
        ...valid,
        code: 'x'.repeat(101),
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an invalid status', async () => {
      const errors = await validateLike(CreateProductDto, {
        ...valid,
        status: 'PUBLISHED',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a non-string categoryId', async () => {
      const errors = await validateLike(CreateProductDto, {
        ...valid,
        categoryId: { id: 'cat-1' },
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client tenantId (forbidden non-whitelisted)', async () => {
      const errors = await validateLike(CreateProductDto, {
        ...valid,
        tenantId: 'tenant-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects unknown fields (forbidden non-whitelisted)', async () => {
      const errors = await validateLike(CreateProductDto, {
        ...valid,
        bogus: true,
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('UpdateProductDto', () => {
    it('accepts an empty update (no-op patch)', async () => {
      const errors = await validateLike(UpdateProductDto, {});
      expect(errors).toHaveLength(0);
    });

    it('accepts each field individually incl. archive via status', async () => {
      expect(
        await validateLike(UpdateProductDto, { name: 'New Name' }),
      ).toHaveLength(0);
      expect(
        await validateLike(UpdateProductDto, { code: 'NEW-CODE' }),
      ).toHaveLength(0);
      expect(
        await validateLike(UpdateProductDto, { status: 'ARCHIVED' }),
      ).toHaveLength(0);
      expect(
        await validateLike(UpdateProductDto, { categoryId: 'cat-1' }),
      ).toHaveLength(0);
    });

    it('rejects empty-string name/code when present', async () => {
      expect(
        (await validateLike(UpdateProductDto, { name: '' })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(UpdateProductDto, { code: '' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects body id/tenantId (forbidden non-whitelisted)', async () => {
      expect(
        await validateLike(UpdateProductDto, { id: 'prod-1' }),
      ).toHaveLength(1);
      expect(
        await validateLike(UpdateProductDto, { tenantId: 'tenant-9' }),
      ).toHaveLength(1);
    });
  });

  describe('ProductListQueryDto', () => {
    it('accepts empty query and valid limit/cursor/order/status/categoryId', async () => {
      expect(await validateLike(ProductListQueryDto, {})).toHaveLength(0);
      expect(
        await validateLike(ProductListQueryDto, {
          limit: '5',
          cursor: 'abc',
          order: 'desc',
          status: 'DRAFT',
          categoryId: 'cat-1',
        }),
      ).toHaveLength(0);
    });

    it('rejects limit above the hard maximum and invalid order', async () => {
      expect(
        (await validateLike(ProductListQueryDto, { limit: '101' })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(ProductListQueryDto, { order: 'up' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects unknown query fields incl. tenantId', async () => {
      expect(
        await validateLike(ProductListQueryDto, { code: 'ESP-1' }),
      ).toHaveLength(1);
      expect(
        await validateLike(ProductListQueryDto, { tenantId: 'tenant-9' }),
      ).toHaveLength(1);
    });
  });
});
