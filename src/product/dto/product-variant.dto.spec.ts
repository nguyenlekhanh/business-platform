import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateProductVariantDto,
  ProductVariantListQueryDto,
  PutPriceDto,
  UpdateProductVariantDto,
} from './product-variant.dto';

describe('ProductVariant DTOs', () => {
  // Mirrors the controller ValidationPipe options so these unit tests verify
  // exactly what the HTTP layer enforces (whitelist + forbidNonWhitelisted).
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  describe('CreateProductVariantDto', () => {
    const valid = { sku: 'ESP-1-250G' };

    it('accepts a minimal create payload (sku only)', async () => {
      expect(await validateLike(CreateProductVariantDto, valid)).toHaveLength(
        0,
      );
    });

    it('accepts optional name/status', async () => {
      const errors = await validateLike(CreateProductVariantDto, {
        ...valid,
        name: '250g bag',
        status: 'ARCHIVED',
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects a missing or empty sku', async () => {
      expect(
        (await validateLike(CreateProductVariantDto, {})).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(CreateProductVariantDto, { sku: '' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects an invalid status and a too-long sku', async () => {
      expect(
        (
          await validateLike(CreateProductVariantDto, {
            ...valid,
            status: 'PUBLISHED',
          })
        ).length,
      ).toBeGreaterThan(0);
      expect(
        (
          await validateLike(CreateProductVariantDto, {
            ...valid,
            sku: 'x'.repeat(101),
          })
        ).length,
      ).toBeGreaterThan(0);
    });

    it('rejects client tenantId/id and unknown fields', async () => {
      expect(
        await validateLike(CreateProductVariantDto, {
          ...valid,
          tenantId: 't9',
        }),
      ).toHaveLength(1);
      expect(
        await validateLike(CreateProductVariantDto, { ...valid, id: 'v1' }),
      ).toHaveLength(1);
      expect(
        await validateLike(CreateProductVariantDto, { ...valid, bogus: 1 }),
      ).toHaveLength(1);
    });
  });

  describe('UpdateProductVariantDto', () => {
    it('accepts an empty update and each field individually', async () => {
      expect(await validateLike(UpdateProductVariantDto, {})).toHaveLength(0);
      expect(
        await validateLike(UpdateProductVariantDto, { sku: 'NEW-SKU' }),
      ).toHaveLength(0);
      expect(
        await validateLike(UpdateProductVariantDto, { name: 'X' }),
      ).toHaveLength(0);
      expect(
        await validateLike(UpdateProductVariantDto, { status: 'ACTIVE' }),
      ).toHaveLength(0);
    });

    it('rejects empty-string sku when present', async () => {
      expect(
        (await validateLike(UpdateProductVariantDto, { sku: '' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects client tenantId/productId (injection attempts)', async () => {
      expect(
        await validateLike(UpdateProductVariantDto, { tenantId: 't9' }),
      ).toHaveLength(1);
      expect(
        await validateLike(UpdateProductVariantDto, { productId: 'p9' }),
      ).toHaveLength(1);
    });
  });

  describe('ProductVariantListQueryDto', () => {
    it('accepts empty query and valid limit/cursor/order', async () => {
      expect(await validateLike(ProductVariantListQueryDto, {})).toHaveLength(
        0,
      );
      expect(
        await validateLike(ProductVariantListQueryDto, {
          limit: '3',
          cursor: 'abc',
          order: 'desc',
        }),
      ).toHaveLength(0);
    });

    it('rejects limit above the maximum, invalid order, and unknown fields', async () => {
      expect(
        (await validateLike(ProductVariantListQueryDto, { limit: '101' }))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(ProductVariantListQueryDto, { order: 'up' }))
          .length,
      ).toBeGreaterThan(0);
      expect(
        await validateLike(ProductVariantListQueryDto, { status: 'ACTIVE' }),
      ).toHaveLength(1);
    });
  });

  describe('PutPriceDto', () => {
    const valid = { currency: 'USD', amountMinor: 1250 };

    it('accepts a valid upsert payload', async () => {
      expect(await validateLike(PutPriceDto, valid)).toHaveLength(0);
    });

    it('accepts amountMinor 0 (free items are representable)', async () => {
      expect(
        await validateLike(PutPriceDto, { currency: 'EUR', amountMinor: 0 }),
      ).toHaveLength(0);
    });

    it('rejects non-uppercase or wrong-length currency codes', async () => {
      expect(
        (await validateLike(PutPriceDto, { ...valid, currency: 'usd' })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(PutPriceDto, { ...valid, currency: 'USDX' }))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(PutPriceDto, { ...valid, currency: 'US' })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(PutPriceDto, { ...valid, currency: 12 })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects negative, fractional, missing, and oversized amounts', async () => {
      expect(
        (await validateLike(PutPriceDto, { ...valid, amountMinor: -1 })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(PutPriceDto, { ...valid, amountMinor: 12.5 }))
          .length,
      ).toBeGreaterThan(0);
      const { amountMinor: _amountMinor, ...noAmount } = valid;
      void _amountMinor;
      expect(
        (await validateLike(PutPriceDto, noAmount)).length,
      ).toBeGreaterThan(0);
      expect(
        (
          await validateLike(PutPriceDto, {
            ...valid,
            amountMinor: Number.MAX_SAFE_INTEGER + 1,
          })
        ).length,
      ).toBeGreaterThan(0);
    });

    it('rejects string amounts and unknown fields (strict JSON-number contract)', async () => {
      expect(
        (await validateLike(PutPriceDto, { ...valid, amountMinor: '1250' }))
          .length,
      ).toBeGreaterThan(0);
      expect(
        await validateLike(PutPriceDto, { ...valid, variantId: 'v9' }),
      ).toHaveLength(1);
    });
  });
});
