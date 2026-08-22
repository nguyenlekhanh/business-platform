import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddCartItemDto, UpdateCartItemDto } from './cart.dto';

describe('Cart DTOs', () => {
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  describe('AddCartItemDto', () => {
    const valid = { variantId: 'var-1', quantity: 2 };

    it('accepts valid payload', async () => {
      expect(await validateLike(AddCartItemDto, valid)).toHaveLength(0);
    });

    it('rejects missing variantId or empty', async () => {
      expect(
        (await validateLike(AddCartItemDto, { quantity: 1 })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(AddCartItemDto, { variantId: '', quantity: 1 }))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(AddCartItemDto, { variantId: 12, quantity: 1 }))
          .length,
      ).toBeGreaterThan(0);
    });

    it('rejects missing quantity and invalid quantities', async () => {
      const { quantity: _q, ...noQty } = valid as Record<string, unknown>;
      void _q;
      expect(
        (await validateLike(AddCartItemDto, noQty as Record<string, unknown>))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(AddCartItemDto, { ...valid, quantity: 0 })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(AddCartItemDto, { ...valid, quantity: -1 })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(AddCartItemDto, { ...valid, quantity: 1.5 }))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(AddCartItemDto, { ...valid, quantity: '2' }))
          .length,
      ).toBeGreaterThan(0);
    });

    it('rejects unknown fields and tenantId injection', async () => {
      expect(
        await validateLike(AddCartItemDto, { ...valid, tenantId: 't' }),
      ).toHaveLength(1);
      expect(
        await validateLike(AddCartItemDto, { ...valid, bogus: 1 }),
      ).toHaveLength(1);
    });
  });

  describe('UpdateCartItemDto', () => {
    it('accepts valid quantity', async () => {
      expect(
        await validateLike(UpdateCartItemDto, { quantity: 3 }),
      ).toHaveLength(0);
    });

    it('rejects missing and invalid', async () => {
      expect(
        (await validateLike(UpdateCartItemDto, {})).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(UpdateCartItemDto, { quantity: 0 })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(UpdateCartItemDto, { quantity: '3' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects unknown fields', async () => {
      expect(
        await validateLike(UpdateCartItemDto, { quantity: 1, variantId: 'v' }),
      ).toHaveLength(1);
    });
  });
});
