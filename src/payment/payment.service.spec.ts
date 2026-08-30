import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PaymentService, PaymentSummary } from './payment.service';

describe('PaymentService', () => {
  let service: PaymentService;
  let tenantContext: TenantContextService;

  const mockOrderFindUnique = jest.fn();
  const mockPaymentFindFirst = jest.fn();
  const mockPaymentCreate = jest.fn();

  interface MockTx {
    order: { findUnique: typeof mockOrderFindUnique };
    payment: {
      findFirst: typeof mockPaymentFindFirst;
      create: typeof mockPaymentCreate;
    };
  }

  const mockTransaction = jest.fn(
    async (cb: (tx: MockTx) => Promise<PaymentSummary>) => {
      const tx: MockTx = {
        order: { findUnique: mockOrderFindUnique },
        payment: { findFirst: mockPaymentFindFirst, create: mockPaymentCreate },
      };
      return cb(tx);
    },
  );

  const order = (overrides: Record<string, unknown> = {}) => ({
    id: 'order-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    customerId: null,
    status: 'PENDING',
    currency: 'USD',
    subtotalMinor: 2000n,
    cancelledAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const payment = (overrides: Record<string, unknown> = {}) => ({
    id: 'payment-1',
    tenantId: 'tenant-1',
    orderId: 'order-1',
    status: 'PROCESSING',
    method: 'CARD',
    amountMinor: 2000n,
    currency: 'USD',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    tenantContext = new TenantContextService();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentService,
        {
          provide: PrismaService,
          useValue: {
            order: { findUnique: mockOrderFindUnique },
            payment: {
              findFirst: mockPaymentFindFirst,
              create: mockPaymentCreate,
            },
            $transaction: mockTransaction,
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();
    service = moduleRef.get(PaymentService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  describe('fail-closed', () => {
    it('createPayment fails closed without tenant', async () => {
      await expect(
        service.createPayment({ orderId: 'order-1', method: 'CARD' }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('createPayment', () => {
    it('creates PROCESSING payment with amount/currency from order', async () => {
      mockOrderFindUnique.mockResolvedValue(order());
      mockPaymentFindFirst.mockResolvedValue(null);
      mockPaymentCreate.mockResolvedValue(payment());

      const result = await runInTenant(() =>
        service.createPayment({ orderId: 'order-1', method: 'CARD' }),
      );
      expect(result.status).toBe('PROCESSING');
      expect(result.amountMinor).toBe('2000');
      expect(result.currency).toBe('USD');
      expect(result.method).toBe('CARD');
      expect(mockPaymentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({
            tenantId: 'tenant-1',
            orderId: 'order-1',
            status: 'PROCESSING',
            method: 'CARD',
            amountMinor: 2000n,
            currency: 'USD',
          }),
        }),
      );
    });

    it('throws NotFound for unknown order', async () => {
      mockOrderFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() =>
          service.createPayment({ orderId: 'nope', method: 'CARD' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws Conflict for non-PENDING order', async () => {
      mockOrderFindUnique.mockResolvedValue(order({ status: 'PAID' }));
      await expect(
        runInTenant(() =>
          service.createPayment({ orderId: 'order-1', method: 'CARD' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws Conflict if CAPTURED payment already exists', async () => {
      mockOrderFindUnique.mockResolvedValue(order());
      mockPaymentFindFirst.mockResolvedValue(payment({ status: 'CAPTURED' }));
      await expect(
        runInTenant(() =>
          service.createPayment({ orderId: 'order-1', method: 'CARD' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows creation if existing payment is PROCESSING (not CAPTURED)', async () => {
      mockOrderFindUnique.mockResolvedValue(order());
      // findFirst for CAPTURED should return null (no captured payment)
      mockPaymentFindFirst.mockResolvedValue(null);
      mockPaymentCreate.mockResolvedValue(payment());

      const result = await runInTenant(() =>
        service.createPayment({ orderId: 'order-1', method: 'CARD' }),
      );
      expect(result.status).toBe('PROCESSING');
    });

    it('allows creation if existing payment is FAILED (not CAPTURED)', async () => {
      mockOrderFindUnique.mockResolvedValue(order());
      // findFirst for CAPTURED should return null (no captured payment)
      mockPaymentFindFirst.mockResolvedValue(null);
      mockPaymentCreate.mockResolvedValue(payment());

      const result = await runInTenant(() =>
        service.createPayment({ orderId: 'order-1', method: 'CARD' }),
      );
      expect(result.status).toBe('PROCESSING');
    });

    it('derives amountMinor from order, ignores any client-provided amount', async () => {
      mockOrderFindUnique.mockResolvedValue(order({ subtotalMinor: 5000n }));
      mockPaymentFindFirst.mockResolvedValue(null);

      mockPaymentCreate.mockResolvedValue(payment({ amountMinor: 5000n }));

      const result = await runInTenant(() =>
        service.createPayment({ orderId: 'order-1', method: 'CARD' }),
      );
      expect(result.amountMinor).toBe('5000');
      expect(mockPaymentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({ amountMinor: 5000n }),
        }),
      );
    });

    it('derives currency from order, ignores any client-provided currency', async () => {
      mockOrderFindUnique.mockResolvedValue(order({ currency: 'EUR' }));
      mockPaymentFindFirst.mockResolvedValue(null);

      mockPaymentCreate.mockResolvedValue(payment({ currency: 'EUR' }));

      const result = await runInTenant(() =>
        service.createPayment({ orderId: 'order-1', method: 'CARD' }),
      );
      expect(result.currency).toBe('EUR');
      expect(mockPaymentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({ currency: 'EUR' }),
        }),
      );
    });

    it('always sets status to PROCESSING', async () => {
      mockOrderFindUnique.mockResolvedValue(order());
      mockPaymentFindFirst.mockResolvedValue(null);

      mockPaymentCreate.mockResolvedValue(payment());

      const result = await runInTenant(() =>
        service.createPayment({ orderId: 'order-1', method: 'CARD' }),
      );
      expect(result.status).toBe('PROCESSING');
      expect(mockPaymentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({ status: 'PROCESSING' }),
        }),
      );
    });

    it('sets tenantId from order (not from client)', async () => {
      mockOrderFindUnique.mockResolvedValue(order());
      mockPaymentFindFirst.mockResolvedValue(null);

      mockPaymentCreate.mockResolvedValue(payment());

      await runInTenant(() =>
        service.createPayment({ orderId: 'order-1', method: 'CARD' }),
      );
      expect(mockPaymentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({ tenantId: 'tenant-1' }),
        }),
      );
    });

    it('uses method from DTO', async () => {
      mockOrderFindUnique.mockResolvedValue(order());
      mockPaymentFindFirst.mockResolvedValue(null);

      mockPaymentCreate.mockResolvedValue(payment({ method: 'CASH' }));

      const result = await runInTenant(() =>
        service.createPayment({ orderId: 'order-1', method: 'CASH' }),
      );
      expect(result.method).toBe('CASH');
    });
  });
});
