import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { OrderService, OrderSummary } from './order.service';

describe('OrderService', () => {
  let service: OrderService;
  let tenantContext: TenantContextService;

  const mockVariantFindMany = jest.fn();
  const mockVariantFindUnique = jest.fn();
  const mockPriceFindMany = jest.fn();
  const mockProductFindMany = jest.fn();
  const mockInventoryUpdateMany = jest.fn();
  const mockInventoryFindUnique = jest.fn();
  const mockInventoryFindFirst = jest.fn();
  const mockInventoryCreate = jest.fn();
  const mockOrderCreate = jest.fn();
  const mockOrderFindUnique = jest.fn();
  const mockOrderFindMany = jest.fn();
  const mockOrderUpdateMany = jest.fn();
  const mockOrderItemCreate = jest.fn();
  const mockOrderItemFindMany = jest.fn();
  const mockCartFindFirst = jest.fn();
  const mockCartFindUnique = jest.fn();
  const mockCartItemFindMany = jest.fn();
  const mockCartUpdate = jest.fn();
  const mockCustomerFindUnique = jest.fn();
  const mockPosSaleFindUnique = jest.fn();

  interface MockTx {
    productVariant: {
      findMany: typeof mockVariantFindMany;
      findUnique: typeof mockVariantFindUnique;
    };
    price: { findMany: typeof mockPriceFindMany };
    product: { findMany: typeof mockProductFindMany };
    inventory: {
      updateMany: typeof mockInventoryUpdateMany;
      findUnique: typeof mockInventoryFindUnique;
      findFirst: typeof mockInventoryFindFirst;
      create: typeof mockInventoryCreate;
    };
    order: {
      create: typeof mockOrderCreate;
      findUnique: typeof mockOrderFindUnique;
      findMany: typeof mockOrderFindMany;
      updateMany: typeof mockOrderUpdateMany;
    };
    orderItem: {
      create: typeof mockOrderItemCreate;
      findMany: typeof mockOrderItemFindMany;
    };
    cart: {
      findFirst: typeof mockCartFindFirst;
      findUnique: typeof mockCartFindUnique;
      update: typeof mockCartUpdate;
    };
    cartItem: { findMany: typeof mockCartItemFindMany };
    customer: { findUnique: typeof mockCustomerFindUnique };
    posSale: { findUnique: typeof mockPosSaleFindUnique };
  }

  const mockTransaction = jest.fn(
    async (cb: (tx: MockTx) => Promise<OrderSummary>) => {
      const mockTx: MockTx = {
        productVariant: {
          findMany: mockVariantFindMany,
          findUnique: mockVariantFindUnique,
        },
        price: { findMany: mockPriceFindMany },
        product: { findMany: mockProductFindMany },
        inventory: {
          updateMany: mockInventoryUpdateMany,
          findUnique: mockInventoryFindUnique,
          findFirst: mockInventoryFindFirst,
          create: mockInventoryCreate,
        },
        order: {
          create: mockOrderCreate,
          findUnique: mockOrderFindUnique,
          findMany: mockOrderFindMany,
          updateMany: mockOrderUpdateMany,
        },
        orderItem: {
          create: mockOrderItemCreate,
          findMany: mockOrderItemFindMany,
        },
        cart: {
          findFirst: mockCartFindFirst,
          findUnique: mockCartFindUnique,
          update: mockCartUpdate,
        },
        cartItem: { findMany: mockCartItemFindMany },
        customer: { findUnique: mockCustomerFindUnique },
        posSale: { findUnique: mockPosSaleFindUnique },
      };
      return cb(mockTx);
    },
  );

  const variant = (overrides: Record<string, unknown> = {}) => ({
    id: 'var-1',
    tenantId: 'tenant-1',
    productId: 'prod-1',
    sku: 'SKU-1',
    name: 'Var',
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });
  const product = (overrides: Record<string, unknown> = {}) => ({
    id: 'prod-1',
    tenantId: 'tenant-1',
    name: 'Prod',
    code: 'CODE',
    description: null,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });
  const price = (overrides: Record<string, unknown> = {}) => ({
    id: 'price-1',
    tenantId: 'tenant-1',
    variantId: 'var-1',
    currency: 'USD',
    amountMinor: 1000n,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });
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
  const orderItem = (overrides: Record<string, unknown> = {}) => ({
    id: 'oi-1',
    tenantId: 'tenant-1',
    orderId: 'order-1',
    variantId: 'var-1',
    productName: 'Prod',
    variantName: 'Var',
    sku: 'SKU-1',
    quantity: 2,
    currency: 'USD',
    unitAmountMinor: 1000n,
    lineTotalMinor: 2000n,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    tenantContext = new TenantContextService();
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrderService,
        {
          provide: PrismaService,
          useValue: {
            productVariant: {
              findUnique: mockVariantFindUnique,
              findMany: mockVariantFindMany,
            },
            price: { findMany: mockPriceFindMany },
            product: { findMany: mockProductFindMany },
            inventory: {
              updateMany: mockInventoryUpdateMany,
              findUnique: mockInventoryFindUnique,
              create: mockInventoryCreate,
            },
            order: {
              create: mockOrderCreate,
              findUnique: mockOrderFindUnique,
              findMany: mockOrderFindMany,
              updateMany: mockOrderUpdateMany,
            },
            orderItem: {
              create: mockOrderItemCreate,
              findMany: mockOrderItemFindMany,
            },
            cart: {
              findFirst: mockCartFindFirst,
              findUnique: mockCartFindUnique,
              update: mockCartUpdate,
            },
            cartItem: { findMany: mockCartItemFindMany },
            customer: { findUnique: mockCustomerFindUnique },
            $transaction: mockTransaction,
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();
    service = moduleRef.get(OrderService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  describe('fail-closed', () => {
    it('createOrder fails closed without tenant', async () => {
      await expect(
        service.createOrder('user-1', {
          items: [{ variantId: 'var-1', quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('getOrder fails closed', async () => {
      await expect(service.getOrder('order-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('createOrder direct items', () => {
    it('creates order with snapshots and decrements stock', async () => {
      mockCustomerFindUnique.mockResolvedValue(null);
      mockVariantFindMany.mockResolvedValue([variant()]);
      mockPriceFindMany.mockResolvedValue([price()]);
      mockProductFindMany.mockResolvedValue([product()]);
      mockInventoryUpdateMany.mockResolvedValue({ count: 1 });
      mockOrderCreate.mockResolvedValue(order());
      mockOrderItemCreate.mockResolvedValue(orderItem());
      mockOrderItemFindMany.mockResolvedValue([orderItem()]);

      const result = await runInTenant(() =>
        service.createOrder('user-1', {
          items: [{ variantId: 'var-1', quantity: 2 }],
        }),
      );
      expect(result.currency).toBe('USD');
      expect(result.subtotalMinor).toBe('2000');
      expect(result.items[0].sku).toBe('SKU-1');
      expect(mockInventoryUpdateMany).toHaveBeenCalledWith({
        where: {
          variantId: 'var-1',
          storeId: null,
          quantityOnHand: { gte: 2 },
        },
        data: { quantityOnHand: { decrement: 2 } },
      });
    });

    it('throws NotFound for unknown variant', async () => {
      mockVariantFindMany.mockResolvedValue([]);
      await expect(
        runInTenant(() =>
          service.createOrder('user-1', {
            items: [{ variantId: 'nope', quantity: 1 }],
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws Conflict for inactive variant', async () => {
      mockVariantFindMany.mockResolvedValue([variant({ status: 'ARCHIVED' })]);
      await expect(
        runInTenant(() =>
          service.createOrder('user-1', {
            items: [{ variantId: 'var-1', quantity: 1 }],
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws Conflict for insufficient stock', async () => {
      mockVariantFindMany.mockResolvedValue([variant()]);
      mockPriceFindMany.mockResolvedValue([price()]);
      mockProductFindMany.mockResolvedValue([product()]);
      mockInventoryUpdateMany.mockResolvedValue({ count: 0 });
      await expect(
        runInTenant(() =>
          service.createOrder('user-1', {
            items: [{ variantId: 'var-1', quantity: 5 }],
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws Conflict for currency mismatch', async () => {
      mockVariantFindMany.mockResolvedValue([
        variant({ id: 'var-1' }),
        variant({ id: 'var-2' }),
      ]);
      mockPriceFindMany.mockResolvedValue([
        price({ variantId: 'var-1', currency: 'USD' }),
        price({ variantId: 'var-2', currency: 'EUR' }),
      ]);
      await expect(
        runInTenant(() =>
          service.createOrder('user-1', {
            items: [
              { variantId: 'var-1', quantity: 1 },
              { variantId: 'var-2', quantity: 1 },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('cancelOrder', () => {
    it('cancels a non-POS order and restocks the GLOBAL pool (PosSale absent)', async () => {
      mockOrderFindUnique.mockResolvedValueOnce(order({ status: 'PENDING' }));
      mockOrderUpdateMany.mockResolvedValue({ count: 1 });
      mockPosSaleFindUnique.mockResolvedValue(null); // not a POS order
      mockOrderItemFindMany.mockResolvedValue([orderItem({ quantity: 2 })]);
      mockInventoryFindFirst.mockResolvedValue({ quantityOnHand: 3 });
      mockInventoryUpdateMany.mockResolvedValue({ count: 1 });
      mockOrderFindUnique.mockResolvedValueOnce(
        order({ status: 'CANCELLED', cancelledAt: new Date() }),
      );
      mockOrderItemFindMany.mockResolvedValueOnce([orderItem()]);

      const result = await runInTenant(() => service.cancelOrder('order-1'));
      expect(result.status).toBe('CANCELLED');
      expect(mockInventoryUpdateMany).toHaveBeenCalledWith({
        where: { variantId: 'var-1', storeId: null },
        data: { quantityOnHand: { increment: 2 } },
      });
      // Restock-pool resolution consulted the PosSale provenance.
      expect(mockPosSaleFindUnique).toHaveBeenCalledWith({
        where: { orderId: 'order-1' },
        select: { storeId: true },
      });
    });

    it('cancels a POS order and restocks the POS sale store pool exactly once', async () => {
      mockOrderFindUnique.mockResolvedValueOnce(order({ status: 'PENDING' }));
      mockOrderUpdateMany.mockResolvedValue({ count: 1 });
      mockPosSaleFindUnique.mockResolvedValue({ storeId: 'store-1' });
      mockOrderItemFindMany.mockResolvedValue([orderItem({ quantity: 2 })]);
      mockInventoryFindFirst.mockResolvedValue({ quantityOnHand: 3 });
      mockInventoryUpdateMany.mockResolvedValue({ count: 1 });
      mockOrderFindUnique.mockResolvedValueOnce(
        order({ status: 'CANCELLED', cancelledAt: new Date() }),
      );
      mockOrderItemFindMany.mockResolvedValueOnce([orderItem()]);

      await runInTenant(() => service.cancelOrder('order-1'));
      expect(mockInventoryUpdateMany).toHaveBeenCalledWith({
        where: { variantId: 'var-1', storeId: 'store-1' },
        data: { quantityOnHand: { increment: 2 } },
      });
    });

    it('throws Conflict when not pending', async () => {
      mockOrderFindUnique.mockResolvedValue(order({ status: 'PAID' }));
      await expect(
        runInTenant(() => service.cancelOrder('order-1')),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
