import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { OrderService, OrderSummary } from '../order/order.service';
import { PaymentService } from '../payment/payment.service';
import { PosSaleService } from './pos-sale.service';
import type { PosDevice, PosSession } from '@prisma/client';

/** Typed accessor for posSale.create() call arguments. */
interface CreateArgs {
  data: {
    tenantId: string;
    orderId: string;
    paymentId: string;
    sessionId: string;
    deviceId: string;
    storeId: string;
    userId: string;
  };
}

describe('PosSaleService', () => {
  let service: PosSaleService;
  let tenantContext: TenantContextService;

  const mockSessionFindUnique = jest.fn();
  const mockDeviceFindUnique = jest.fn();
  const mockSaleCreate = jest.fn();
  const mockSaleFindUnique = jest.fn();
  const mockSaleFindMany = jest.fn();
  const mockOrderCreate = jest.fn();
  const mockOrderGet = jest.fn();
  const mockPaymentCreate = jest.fn();
  const mockPaymentCapture = jest.fn();
  const mockPaymentGet = jest.fn();

  const device = (overrides: Partial<PosDevice> = {}): PosDevice => ({
    id: 'device-1',
    tenantId: 'tenant-1',
    storeId: 'store-1',
    name: 'Register 1',
    status: 'ACTIVE',
    credentialHash: 'a'.repeat(64),
    lastSeenAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const session = (overrides: Partial<PosSession> = {}): PosSession => ({
    id: 'session-1',
    tenantId: 'tenant-1',
    deviceId: 'device-1',
    storeId: 'store-1',
    userId: 'user-1',
    status: 'OPEN',
    openedAt: new Date('2026-01-01T00:00:00.000Z'),
    closedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const orderSummary = (): OrderSummary => ({
    id: 'order-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    customerId: null,
    status: 'PENDING',
    currency: 'USD',
    subtotalMinor: '2000',
    cancelledAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    items: [
      {
        id: 'oi-1',
        variantId: 'variant-1',
        productName: 'P',
        variantName: 'V',
        sku: 'SKU-1',
        quantity: 2,
        currency: 'USD',
        unitAmountMinor: '1000',
        lineTotalMinor: '2000',
      },
    ],
  });

  const paymentSummary = (status: 'PROCESSING' | 'CAPTURED') => ({
    id: 'payment-1',
    tenantId: 'tenant-1',
    orderId: 'order-1',
    status,
    method: 'CASH',
    amountMinor: '2000',
    currency: 'USD',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

  const saleRow = {
    id: 'sale-1',
    tenantId: 'tenant-1',
    orderId: 'order-1',
    paymentId: 'payment-1',
    sessionId: 'session-1',
    deviceId: 'device-1',
    storeId: 'store-1',
    userId: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const seedHappyPath = (method = 'CASH') => {
    mockSessionFindUnique.mockResolvedValue(session());
    mockDeviceFindUnique.mockResolvedValue(device());
    mockOrderCreate.mockResolvedValue(orderSummary());
    mockPaymentCreate.mockResolvedValue(paymentSummary('PROCESSING'));
    if (method === 'CASH') {
      // Post-capture re-read shows the Order PAID (T2 flipped it).
      mockPaymentCapture.mockResolvedValue(paymentSummary('CAPTURED'));
      mockOrderGet
        .mockResolvedValueOnce({ ...orderSummary(), status: 'PAID' })
        .mockResolvedValue(orderSummary()); // later getSale projections
    }
    mockSaleCreate.mockImplementation((args: CreateArgs) =>
      Promise.resolve({ ...saleRow, ...args.data }),
    );
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    tenantContext = new TenantContextService();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PosSaleService,
        {
          provide: PrismaService,
          useValue: {
            posSession: { findUnique: mockSessionFindUnique },
            posDevice: { findUnique: mockDeviceFindUnique },
            posSale: {
              create: mockSaleCreate,
              findUnique: mockSaleFindUnique,
              findMany: mockSaleFindMany,
            },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
        {
          provide: OrderService,
          useValue: { createOrder: mockOrderCreate, getOrder: mockOrderGet },
        },
        {
          provide: PaymentService,
          useValue: {
            createPayment: mockPaymentCreate,
            capturePayment: mockPaymentCapture,
            getPayment: mockPaymentGet,
          },
        },
      ],
    }).compile();
    service = moduleRef.get(PosSaleService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  const saleDto = {
    sessionId: 'session-1',
    items: [{ variantId: 'variant-1', quantity: 2 }],
  };

  describe('fail-closed', () => {
    it('createSale fails closed without tenant', async () => {
      await expect(
        service.createSale('user-1', saleDto),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('createSale — POS context validation', () => {
    it('throws NotFound for unknown session (uniform 404)', async () => {
      mockSessionFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.createSale('user-1', saleDto)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws Conflict for a CLOSED session', async () => {
      mockSessionFindUnique.mockResolvedValue(
        session({ status: 'CLOSED', closedAt: new Date() }),
      );
      await expect(
        runInTenant(() => service.createSale('user-1', saleDto)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws Conflict for a SUSPENDED device', async () => {
      mockSessionFindUnique.mockResolvedValue(session());
      mockDeviceFindUnique.mockResolvedValue(device({ status: 'SUSPENDED' }));
      await expect(
        runInTenant(() => service.createSale('user-1', saleDto)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws Conflict for a RETIRED device', async () => {
      mockSessionFindUnique.mockResolvedValue(session());
      mockDeviceFindUnique.mockResolvedValue(device({ status: 'RETIRED' }));
      await expect(
        runInTenant(() => service.createSale('user-1', saleDto)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a different member using the session (cashier binding)', async () => {
      mockSessionFindUnique.mockResolvedValue(session());
      mockDeviceFindUnique.mockResolvedValue(device());
      await expect(
        runInTenant(() => service.createSale('user-OTHER', saleDto)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockOrderCreate).not.toHaveBeenCalled();
    });
  });

  describe('createSale — orchestration (reuse, not duplication)', () => {
    it('CASH sale: existing T1 -> T5 -> T2; provenance derived from session', async () => {
      seedHappyPath('CASH');

      const result = await runInTenant(() =>
        service.createSale('user-1', saleDto),
      );

      // Order via the existing OrderService with the sale items AND the
      // store scope (P4-U3: the sale consumes the session's store pool).
      expect(mockOrderCreate).toHaveBeenCalledWith(
        'user-1',
        { items: [{ variantId: 'variant-1', quantity: 2 }] },
        { inventoryScope: { kind: 'store', storeId: 'store-1' } },
      );
      // Payment via the existing T5 with the created order id.
      expect(mockPaymentCreate).toHaveBeenCalledWith({
        orderId: 'order-1',
        method: 'CASH',
      });
      // CASH captures immediately via the existing T2.
      expect(mockPaymentCapture).toHaveBeenCalledWith('payment-1');
      // Provenance: store/device/cashier all from the SESSION, never the client.
      const args = (mockSaleCreate.mock.calls[0] as unknown as [CreateArgs])[0];
      expect(args.data).toEqual({
        tenantId: 'tenant-1',
        orderId: 'order-1',
        paymentId: 'payment-1',
        sessionId: 'session-1',
        deviceId: 'device-1',
        storeId: 'store-1',
        userId: 'user-1',
      });
      // Final state mirrors the existing state machines.
      expect(result.orderStatus).toBe('PAID');
      expect(result.paymentStatus).toBe('CAPTURED');
      expect(result.subtotalMinor).toBe('2000');
      expect(result.method).toBe('CASH');
    });

    it('CARD sale: T1 -> T5 only; payment stays PROCESSING for the existing capture endpoint', async () => {
      seedHappyPath('CARD');

      const result = await runInTenant(() =>
        service.createSale('user-1', { ...saleDto, method: 'CARD' }),
      );

      expect(mockPaymentCapture).not.toHaveBeenCalled();
      expect(result.orderStatus).toBe('PENDING');
      expect(result.paymentStatus).toBe('PROCESSING');
    });

    it('P4-U6: the offline boundary rejects a CARD method deterministically (D5 cash-only)', async () => {
      // No mocks needed: the boundary check runs BEFORE any Prisma call.
      await expect(
        runInTenant(() =>
          service.createSale(
            'user-1',
            { ...saleDto, method: 'CARD' },
            { allowClosedSession: true, offline: true },
          ),
        ),
      ).rejects.toThrow('Offline payment must be cash');
      // NOTHING ran: no session lookup beyond the boundary, no order,
      // no payment.
      expect(mockOrderCreate).not.toHaveBeenCalled();
      expect(mockPaymentCreate).not.toHaveBeenCalled();
      expect(mockPaymentCapture).not.toHaveBeenCalled();
    });

    it('P4-U6: the offline boundary ACCEPTS CASH (the sync path itself)', async () => {
      seedHappyPath();
      const result = await runInTenant(() =>
        service.createSale(
          'user-1',
          { ...saleDto, method: 'CASH' },
          { allowClosedSession: true, offline: true },
        ),
      );
      expect(result.paymentStatus).toBe('CAPTURED');
      expect(mockPaymentCreate).toHaveBeenCalledWith({
        orderId: 'order-1',
        method: 'CASH',
      });
    });

    it('forwards optional customerId to the existing order path (walk-in default: none)', async () => {
      seedHappyPath();
      await runInTenant(() =>
        service.createSale('user-1', { ...saleDto, customerId: 'cust-9' }),
      );
      expect(mockOrderCreate).toHaveBeenCalledWith(
        'user-1',
        {
          items: [{ variantId: 'variant-1', quantity: 2 }],
          customerId: 'cust-9',
        },
        { inventoryScope: { kind: 'store', storeId: 'store-1' } },
      );
    });

    it('surfaces upstream commerce failures (insufficient stock) unchanged', async () => {
      mockSessionFindUnique.mockResolvedValue(session());
      mockDeviceFindUnique.mockResolvedValue(device());
      mockOrderCreate.mockRejectedValue(
        new ConflictException('Insufficient stock'),
      );
      await expect(
        runInTenant(() => service.createSale('user-1', saleDto)),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockPaymentCreate).not.toHaveBeenCalled();
      expect(mockSaleCreate).not.toHaveBeenCalled();
    });
  });

  describe('getSale / listSessionSales', () => {
    it('projects an existing sale through the commerce summaries', async () => {
      mockSaleFindUnique.mockResolvedValue(saleRow);
      mockOrderGet.mockResolvedValue(orderSummary());
      mockPaymentGet.mockResolvedValue(paymentSummary('CAPTURED'));

      const result = await runInTenant(() => service.getSale('sale-1'));
      expect(result.id).toBe('sale-1');
      expect(result.orderId).toBe('order-1');
      expect(result.items[0].unitAmountMinor).toBe('1000');
    });

    it('throws NotFound for unknown sale', async () => {
      mockSaleFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.getSale('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lists a session sales ordered by createdAt', async () => {
      mockSessionFindUnique.mockResolvedValue(session());
      mockSaleFindMany.mockResolvedValue([saleRow]);
      mockOrderGet.mockResolvedValue(orderSummary());
      mockPaymentGet.mockResolvedValue(paymentSummary('CAPTURED'));
      const sales = await runInTenant(() =>
        service.listSessionSales('session-1'),
      );
      expect(sales).toHaveLength(1);
      expect(mockSaleFindMany).toHaveBeenCalledWith({
        where: { sessionId: 'session-1' },
        orderBy: { createdAt: 'asc' },
      });
    });
  });
});
