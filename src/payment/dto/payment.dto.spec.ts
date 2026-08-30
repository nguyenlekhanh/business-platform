import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePaymentDto } from './payment.dto';

describe('Payment DTOs', () => {
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  describe('CreatePaymentDto', () => {
    it('accepts valid orderId and method', async () => {
      const errors = await validateLike(CreatePaymentDto, {
        orderId: 'order-123',
        method: 'CARD',
      });
      expect(errors).toHaveLength(0);
    });

    it('accepts valid orderId with CASH method', async () => {
      const errors = await validateLike(CreatePaymentDto, {
        orderId: 'order-123',
        method: 'CASH',
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects missing orderId', async () => {
      const errors = await validateLike(CreatePaymentDto, { method: 'CARD' });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects missing method', async () => {
      const errors = await validateLike(CreatePaymentDto, {
        orderId: 'order-123',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects empty method', async () => {
      const errors = await validateLike(CreatePaymentDto, {
        orderId: 'order-123',
        method: '',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects method exceeding max length', async () => {
      const errors = await validateLike(CreatePaymentDto, {
        orderId: 'order-123',
        method: 'x'.repeat(51),
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects tenantId injection', async () => {
      const errors = await validateLike(CreatePaymentDto, {
        orderId: 'order-123',
        method: 'CARD',
        tenantId: 'tenant-other',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects amountMinor injection', async () => {
      const errors = await validateLike(CreatePaymentDto, {
        orderId: 'order-123',
        method: 'CARD',
        amountMinor: 1000,
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects currency injection', async () => {
      const errors = await validateLike(CreatePaymentDto, {
        orderId: 'order-123',
        method: 'CARD',
        currency: 'USD',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects status injection', async () => {
      const errors = await validateLike(CreatePaymentDto, {
        orderId: 'order-123',
        method: 'CARD',
        status: 'CAPTURED',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects id injection', async () => {
      const errors = await validateLike(CreatePaymentDto, {
        orderId: 'order-123',
        method: 'CARD',
        id: 'payment-123',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects timestamp injection', async () => {
      const errors = await validateLike(CreatePaymentDto, {
        orderId: 'order-123',
        method: 'CARD',
        createdAt: new Date().toISOString(),
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects unknown fields', async () => {
      const errors = await validateLike(CreatePaymentDto, {
        orderId: 'order-123',
        method: 'CARD',
        bogus: true,
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
