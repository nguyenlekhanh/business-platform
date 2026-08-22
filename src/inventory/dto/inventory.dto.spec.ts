import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdjustInventoryDto } from './inventory.dto';

describe('Inventory DTOs', () => {
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  describe('AdjustInventoryDto', () => {
    const valid = { variantId: 'var-1', delta: 5 };

    it('accepts minimal valid payload', async () => {
      expect(await validateLike(AdjustInventoryDto, valid)).toHaveLength(0);
    });

    it('accepts negative delta and optional reason', async () => {
      expect(
        await validateLike(AdjustInventoryDto, {
          ...valid,
          delta: -3,
          reason: 'restock after cancel',
        }),
      ).toHaveLength(0);
    });

    it('rejects missing variantId or empty/non-string variantId', async () => {
      expect(
        (await validateLike(AdjustInventoryDto, { delta: 1 })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(AdjustInventoryDto, { variantId: '', delta: 1 }))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(AdjustInventoryDto, { variantId: 12, delta: 1 }))
          .length,
      ).toBeGreaterThan(0);
    });

    it('rejects missing delta, zero, fractional, and non-int delta', async () => {
      const { delta: _delta, ...noDelta } = valid as Record<string, unknown>;
      void _delta;
      expect(
        (
          await validateLike(
            AdjustInventoryDto,
            noDelta as Record<string, unknown>,
          )
        ).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(AdjustInventoryDto, { ...valid, delta: 0 })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(AdjustInventoryDto, { ...valid, delta: 1.5 }))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(AdjustInventoryDto, { ...valid, delta: '5' }))
          .length,
      ).toBeGreaterThan(0);
    });

    it('rejects reason that is non-string or too long', async () => {
      expect(
        (await validateLike(AdjustInventoryDto, { ...valid, reason: 12 }))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (
          await validateLike(AdjustInventoryDto, {
            ...valid,
            reason: 'x'.repeat(501),
          })
        ).length,
      ).toBeGreaterThan(0);
    });

    it('rejects unknown fields and tenantId injection', async () => {
      expect(
        await validateLike(AdjustInventoryDto, { ...valid, tenantId: 't' }),
      ).toHaveLength(1);
      expect(
        await validateLike(AdjustInventoryDto, { ...valid, bogus: 1 }),
      ).toHaveLength(1);
    });
  });
});
