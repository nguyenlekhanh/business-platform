import {
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { CartService } from './cart.service';

describe('CartService', () => {
  let service: CartService;
  let tenantContext: TenantContextService;

  const mockCartFindFirst = jest.fn();
  const mockCartFindUnique = jest.fn();
  const mockCartCreate = jest.fn();
  const mockCartDelete = jest.fn();
  const mockCartItemFindMany = jest.fn();
  const mockCartItemFindFirst = jest.fn();
  const mockCartItemFindUnique = jest.fn();
  const mockCartItemCreate = jest.fn();
  const mockCartItemUpdate = jest.fn();
  const mockCartItemDelete = jest.fn();
  const mockVariantFindUnique = jest.fn();
  const mockPriceFindMany = jest.fn();
  const mockVariantFindMany = jest.fn();

  const cart = (overrides: Record<string, unknown> = {}) => ({
    id: 'cart-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    status: 'OPEN',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const cartItem = (overrides: Record<string, unknown> = {}) => ({
    id: 'item-1',
    tenantId: 'tenant-1',
    cartId: 'cart-1',
    variantId: 'var-1',
    quantity: 2,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const variant = (overrides: Record<string, unknown> = {}) => ({
    id: 'var-1',
    tenantId: 'tenant-1',
    productId: 'prod-1',
    sku: 'SKU-1',
    name: 'Var 1',
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

  const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: 'test',
    });

  beforeEach(async () => {
    jest.clearAllMocks();
    tenantContext = new TenantContextService();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CartService,
        {
          provide: PrismaService,
          useValue: {
            cart: {
              findFirst: mockCartFindFirst,
              findUnique: mockCartFindUnique,
              create: mockCartCreate,
              delete: mockCartDelete,
            },
            cartItem: {
              findMany: mockCartItemFindMany,
              findFirst: mockCartItemFindFirst,
              findUnique: mockCartItemFindUnique,
              create: mockCartItemCreate,
              update: mockCartItemUpdate,
              delete: mockCartItemDelete,
            },
            productVariant: {
              findUnique: mockVariantFindUnique,
              findMany: mockVariantFindMany,
            },
            price: { findMany: mockPriceFindMany },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();
    service = moduleRef.get(CartService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  describe('fail-closed', () => {
    it('getCart fails closed', async () => {
      await expect(service.getCart('user-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('addItem fails closed', async () => {
      await expect(
        service.addItem('user-1', {
          variantId: 'var-1',
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('getCart', () => {
    it('returns empty cart when no items and creates if missing', async () => {
      mockCartFindFirst.mockResolvedValue(null);
      mockCartCreate.mockResolvedValue(cart());
      mockCartItemFindMany.mockResolvedValue([]);

      const result = await runInTenant(() => service.getCart('user-1'));
      expect(result.id).toBe('cart-1');
      expect(result.items).toEqual([]);
      expect(result.totals).toEqual([]);
      expect(mockCartCreate).toHaveBeenCalledWith({
        data: { tenantId: 'tenant-1', userId: 'user-1', status: 'OPEN' },
      });
    });

    it('enriches with variant and price and totals', async () => {
      mockCartFindFirst.mockResolvedValue(cart());
      mockCartItemFindMany.mockResolvedValue([cartItem({ quantity: 2 })]);
      mockVariantFindMany.mockResolvedValue([variant()]);
      mockPriceFindMany.mockResolvedValue([price({ amountMinor: 1500n })]);

      const result = await runInTenant(() => service.getCart('user-1'));
      expect(result.items).toHaveLength(1);
      expect(result.items[0].quantity).toBe(2);
      expect(result.items[0].prices).toEqual([
        { currency: 'USD', amountMinor: '1500' },
      ]);
      expect(result.items[0].lineTotals).toEqual([
        { currency: 'USD', totalMinor: '3000' },
      ]);
      expect(result.totals).toEqual([{ currency: 'USD', totalMinor: '3000' }]);
    });

    it('returns existing cart when found', async () => {
      mockCartFindFirst.mockResolvedValue(cart());
      mockCartItemFindMany.mockResolvedValue([]);
      const result = await runInTenant(() => service.getCart('user-1'));
      expect(mockCartCreate).not.toHaveBeenCalled();
      expect(result.id).toBe('cart-1');
    });
  });

  describe('addItem', () => {
    it('creates new item when not exists', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockCartFindFirst.mockResolvedValue(cart());
      mockCartItemFindFirst.mockResolvedValue(null);
      mockCartItemCreate.mockResolvedValue(cartItem());
      mockCartFindUnique.mockResolvedValue(cart());
      mockCartItemFindMany.mockResolvedValue([cartItem()]);
      mockVariantFindMany.mockResolvedValue([variant()]);
      mockPriceFindMany.mockResolvedValue([price()]);

      const result = await runInTenant(() =>
        service.addItem('user-1', { variantId: 'var-1', quantity: 2 }),
      );
      expect(result.items).toHaveLength(1);
      expect(mockCartItemCreate).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          cartId: 'cart-1',
          variantId: 'var-1',
          quantity: 2,
        },
      });
    });

    it('merges quantity when item exists', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockCartFindFirst.mockResolvedValue(cart());
      mockCartItemFindFirst.mockResolvedValue(cartItem({ quantity: 2 }));
      mockCartItemUpdate.mockResolvedValue(cartItem({ quantity: 5 }));
      mockCartFindUnique.mockResolvedValue(cart());
      mockCartItemFindMany.mockResolvedValue([cartItem({ quantity: 5 })]);
      mockVariantFindMany.mockResolvedValue([variant()]);
      mockPriceFindMany.mockResolvedValue([price()]);

      const result = await runInTenant(() =>
        service.addItem('user-1', { variantId: 'var-1', quantity: 3 }),
      );
      expect(mockCartItemUpdate).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { quantity: { increment: 3 } },
      });
      expect(result.items[0].quantity).toBe(5);
    });

    it('throws NotFound for unknown variant', async () => {
      mockVariantFindUnique.mockResolvedValue(null);
      mockCartFindFirst.mockResolvedValue(cart());
      await expect(
        runInTenant(() =>
          service.addItem('user-1', { variantId: 'nope', quantity: 1 }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockCartItemCreate).not.toHaveBeenCalled();
    });

    it('handles P2002 race on create', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockCartFindFirst.mockResolvedValue(cart());
      mockCartItemFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(cartItem({ quantity: 2 }));
      mockCartItemCreate.mockRejectedValue(p2002());
      mockCartItemUpdate.mockResolvedValue(cartItem({ quantity: 5 }));
      mockCartFindUnique.mockResolvedValue(cart());
      mockCartItemFindMany.mockResolvedValue([cartItem({ quantity: 5 })]);
      mockVariantFindMany.mockResolvedValue([variant()]);
      mockPriceFindMany.mockResolvedValue([price()]);

      const result = await runInTenant(() =>
        service.addItem('user-1', { variantId: 'var-1', quantity: 3 }),
      );
      expect(mockCartItemUpdate).toHaveBeenCalled();
      expect(result.items[0].quantity).toBe(5);
    });
  });

  describe('updateItem / removeItem / discard', () => {
    it('updateItem sets quantity', async () => {
      mockCartFindFirst.mockResolvedValue(cart());
      mockCartItemFindUnique.mockResolvedValue(cartItem());
      mockCartItemUpdate.mockResolvedValue(cartItem({ quantity: 10 }));
      mockCartFindUnique.mockResolvedValue(cart());
      mockCartItemFindMany.mockResolvedValue([cartItem({ quantity: 10 })]);
      mockVariantFindMany.mockResolvedValue([variant()]);
      mockPriceFindMany.mockResolvedValue([]);

      const result = await runInTenant(() =>
        service.updateItem('user-1', 'item-1', { quantity: 10 }),
      );
      expect(mockCartItemUpdate).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { quantity: 10 },
      });
      expect(result.items[0].quantity).toBe(10);
    });

    it('updateItem 404 when not owned', async () => {
      mockCartFindFirst.mockResolvedValue(
        cart({ id: 'cart-1', userId: 'user-1' }),
      );
      mockCartItemFindUnique.mockResolvedValue(
        cartItem({ cartId: 'other-cart' }),
      );
      await expect(
        runInTenant(() =>
          service.updateItem('user-1', 'item-1', { quantity: 5 }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('removeItem deletes owned item', async () => {
      mockCartFindFirst.mockResolvedValue(cart());
      mockCartItemFindUnique.mockResolvedValue(cartItem());
      mockCartItemDelete.mockResolvedValue(cartItem());
      mockCartFindUnique.mockResolvedValue(cart());
      mockCartItemFindMany.mockResolvedValue([]);
      mockVariantFindMany.mockResolvedValue([]);
      mockPriceFindMany.mockResolvedValue([]);

      const result = await runInTenant(() =>
        service.removeItem('user-1', 'item-1'),
      );
      expect(mockCartItemDelete).toHaveBeenCalledWith({
        where: { id: 'item-1' },
      });
      expect(result.items).toHaveLength(0);
    });

    it('discard deletes open cart', async () => {
      mockCartFindFirst.mockResolvedValue(cart());
      mockCartDelete.mockResolvedValue(cart());
      await runInTenant(() => service.discardCart('user-1'));
      expect(mockCartDelete).toHaveBeenCalledWith({ where: { id: 'cart-1' } });
    });

    it('discard 404 when no cart', async () => {
      mockCartFindFirst.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.discardCart('user-1')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
