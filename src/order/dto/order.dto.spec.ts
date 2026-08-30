import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOrderDto, OrderListQueryDto } from './order.dto';

describe('Order DTOs', () => {
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  describe('CreateOrderDto', () => {
    it('accepts empty body (cart checkout)', async () => {
      expect(await validateLike(CreateOrderDto, {})).toHaveLength(0);
    });
    it('accepts items with customerId', async () => {
      expect(
        await validateLike(CreateOrderDto, {
          items: [{ variantId: 'v1', quantity: 2 }],
          customerId: 'c1',
        }),
      ).toHaveLength(0);
    });
    it('rejects quantity 0 and fractional', async () => {
      expect(
        (
          await validateLike(CreateOrderDto, {
            items: [{ variantId: 'v1', quantity: 0 }],
          })
        ).length,
      ).toBeGreaterThan(0);
      expect(
        (
          await validateLike(CreateOrderDto, {
            items: [{ variantId: 'v1', quantity: 1.5 }],
          })
        ).length,
      ).toBeGreaterThan(0);
    });
    it('rejects unknown fields and tenantId', async () => {
      expect(
        await validateLike(CreateOrderDto, {
          items: [{ variantId: 'v1', quantity: 1 }],
          tenantId: 't',
        }),
      ).toHaveLength(1);
      expect(
        await validateLike(CreateOrderDto, { status: 'PENDING' }),
      ).toHaveLength(1);
    });
  });

  describe('OrderListQueryDto', () => {
    it('accepts empty and status filter', async () => {
      expect(await validateLike(OrderListQueryDto, {})).toHaveLength(0);
      expect(
        await validateLike(OrderListQueryDto, { status: 'PENDING' }),
      ).toHaveLength(0);
    });
    it('rejects invalid status and unknown field', async () => {
      expect(
        (await validateLike(OrderListQueryDto, { status: 'UNKNOWN' })).length,
      ).toBeGreaterThan(0);
      expect(await validateLike(OrderListQueryDto, { bogus: 1 })).toHaveLength(
        1,
      );
    });
  });
});
