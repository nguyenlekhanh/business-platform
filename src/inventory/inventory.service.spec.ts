import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { InventoryService } from './inventory.service';

describe('InventoryService', () => {
  let service: InventoryService;
  let tenantContext: TenantContextService;

  const mockVariantFindUnique = jest.fn();
  const mockInvFindFirst = jest.fn();
  const mockStoreFindUnique = jest.fn();
  const mockInvUpdateMany = jest.fn();
  const mockInvCreate = jest.fn();

  const variant = (overrides: Record<string, unknown> = {}) => ({
    id: 'var-1',
    tenantId: 'tenant-1',
    productId: 'prod-1',
    sku: 'SKU-1',
    name: null,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const inventory = (overrides: Record<string, unknown> = {}) => ({
    id: 'inv-1',
    tenantId: 'tenant-1',
    variantId: 'var-1',
    storeId: null,
    quantityOnHand: 10,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });

  beforeEach(async () => {
    jest.clearAllMocks();
    tenantContext = new TenantContextService();
    const moduleRef = await Test.createTestingModule({
      providers: [
        InventoryService,
        {
          provide: PrismaService,
          useValue: {
            productVariant: { findUnique: mockVariantFindUnique },
            store: { findUnique: mockStoreFindUnique },
            inventory: {
              findFirst: mockInvFindFirst,
              updateMany: mockInvUpdateMany,
              create: mockInvCreate,
            },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();
    service = moduleRef.get(InventoryService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  describe('fail-closed', () => {
    it('getInventory fails closed without tenant context', async () => {
      await expect(service.getInventory('var-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockVariantFindUnique).not.toHaveBeenCalled();
    });
    it('adjust fails closed without tenant context', async () => {
      await expect(
        service.adjust({ variantId: 'var-1', delta: 1 }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(mockVariantFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('getInventory', () => {
    it('returns zero summary when no row exists', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockInvFindFirst.mockResolvedValue(null);
      const result = await runInTenant(() => service.getInventory('var-1'));
      expect(result.quantityOnHand).toBe(0);
      expect(result.id).toBeNull();
      expect(result.variantId).toBe('var-1');
      expect(result.tenantId).toBe('tenant-1');
    });

    it('returns stored quantity when row exists', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockInvFindFirst.mockResolvedValue(inventory({ quantityOnHand: 7 }));
      const result = await runInTenant(() => service.getInventory('var-1'));
      expect(result.quantityOnHand).toBe(7);
      expect(result.id).toBe('inv-1');
    });

    it('throws NotFound for unknown/cross-tenant variant', async () => {
      mockVariantFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.getInventory('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockInvFindFirst).not.toHaveBeenCalled();
    });
  });

  describe('adjust', () => {
    it('creates row on first positive delta when no row exists', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockInvUpdateMany.mockResolvedValue({ count: 0 });
      mockInvFindFirst
        .mockResolvedValueOnce(null) // check after updateMany 0
        .mockResolvedValueOnce(null); // not needed?
      mockInvCreate.mockResolvedValue(inventory({ quantityOnHand: 5 }));

      const result = await runInTenant(() =>
        service.adjust({ variantId: 'var-1', delta: 5 }),
      );
      expect(result.quantityOnHand).toBe(5);
      expect(mockInvCreate).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          variantId: 'var-1',
          storeId: null,
          quantityOnHand: 5,
        },
      });
    });

    it('throws insufficient stock when decrementing missing row', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockInvUpdateMany.mockResolvedValue({ count: 0 });
      mockInvFindFirst.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.adjust({ variantId: 'var-1', delta: -1 })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockInvCreate).not.toHaveBeenCalled();
    });

    it('applies guarded updateMany for positive delta on existing row', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockInvUpdateMany.mockResolvedValue({ count: 1 });
      mockInvFindFirst.mockResolvedValue(inventory({ quantityOnHand: 15 }));

      const result = await runInTenant(() =>
        service.adjust({ variantId: 'var-1', delta: 5 }),
      );
      expect(result.quantityOnHand).toBe(15);
      expect(mockInvUpdateMany).toHaveBeenCalledWith({
        where: {
          variantId: 'var-1',
          storeId: null,
          quantityOnHand: { gte: -5 },
        },
        data: { quantityOnHand: { increment: 5 } },
      });
      expect(mockInvCreate).not.toHaveBeenCalled();
    });

    it('throws insufficient stock when guarded update fails on existing row', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockInvUpdateMany.mockResolvedValue({ count: 0 });
      mockInvFindFirst.mockResolvedValue(inventory({ quantityOnHand: 2 }));

      await expect(
        runInTenant(() => service.adjust({ variantId: 'var-1', delta: -5 })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('falls back to retry after P2002 race on lazy create', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockInvUpdateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      mockInvFindFirst.mockResolvedValueOnce(null); // first check missing
      mockInvCreate.mockRejectedValue(p2002());
      // after fallback, findUnique returns row
      mockInvFindFirst.mockResolvedValueOnce(inventory({ quantityOnHand: 5 })); // retry fetch

      const result = await runInTenant(() =>
        service.adjust({ variantId: 'var-1', delta: 5 }),
      );
      expect(result.quantityOnHand).toBe(5);
      expect(mockInvUpdateMany).toHaveBeenCalledTimes(2);
    });

    it('throws NotFound for unknown variant without touching inventory', async () => {
      mockVariantFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.adjust({ variantId: 'nope', delta: 1 })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockInvUpdateMany).not.toHaveBeenCalled();
      expect(mockInvCreate).not.toHaveBeenCalled();
    });
  });

  describe('store-scoped pools (P4-U3, D2 Option A)', () => {
    it('getScopedInventory returns zero summary when no store row exists', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockStoreFindUnique.mockResolvedValue({ id: 'store-1' });
      mockInvFindFirst.mockResolvedValue(null);

      const result = await runInTenant(() =>
        service.getScopedInventory(
          { kind: 'store', storeId: 'store-1' },
          'var-1',
        ),
      );
      expect(result.quantityOnHand).toBe(0);
      expect(result.storeId).toBe('store-1');
      expect(result.id).toBeNull();
    });

    it('getScopedInventory reads only the store pool (global untouched)', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockStoreFindUnique.mockResolvedValue({ id: 'store-1' });
      mockInvFindFirst.mockResolvedValue(
        inventory({ storeId: 'store-1', quantityOnHand: 7 }),
      );

      const result = await runInTenant(() =>
        service.getScopedInventory(
          { kind: 'store', storeId: 'store-1' },
          'var-1',
        ),
      );
      expect(result.quantityOnHand).toBe(7);
      expect(mockInvFindFirst).toHaveBeenCalledWith({
        where: { variantId: 'var-1', storeId: 'store-1' },
      });
    });

    it('adjustScoped throws uniform 404 for a foreign/unknown store', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockStoreFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() =>
          service.adjustScoped(
            { kind: 'store', storeId: 'nope' },
            { variantId: 'var-1', delta: 1 },
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockInvUpdateMany).not.toHaveBeenCalled();
    });

    it('adjustScoped decrements only the store pool with a guarded update', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockStoreFindUnique.mockResolvedValue({ id: 'store-1' });
      mockInvUpdateMany.mockResolvedValue({ count: 1 });
      mockInvFindFirst.mockResolvedValue(
        inventory({ storeId: 'store-1', quantityOnHand: 3 }),
      );

      const result = await runInTenant(() =>
        service.adjustScoped(
          { kind: 'store', storeId: 'store-1' },
          { variantId: 'var-1', delta: -3 },
        ),
      );
      expect(result.quantityOnHand).toBe(3);
      expect(mockInvUpdateMany).toHaveBeenCalledWith({
        where: {
          variantId: 'var-1',
          storeId: 'store-1',
          quantityOnHand: { gte: 3 },
        },
        data: { quantityOnHand: { increment: -3 } },
      });
    });

    it('adjustScoped insufficient store stock leaves the pool untouched (409)', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockStoreFindUnique.mockResolvedValue({ id: 'store-1' });
      mockInvUpdateMany.mockResolvedValue({ count: 0 });
      mockInvFindFirst.mockResolvedValue(
        inventory({ storeId: 'store-1', quantityOnHand: 1 }),
      );

      await expect(
        runInTenant(() =>
          service.adjustScoped(
            { kind: 'store', storeId: 'store-1' },
            { variantId: 'var-1', delta: -5 },
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('adjustScoped lazy-creates the store pool row on first positive delta', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockStoreFindUnique.mockResolvedValue({ id: 'store-1' });
      mockInvUpdateMany.mockResolvedValue({ count: 0 });
      mockInvFindFirst.mockResolvedValueOnce(null);
      mockInvCreate.mockResolvedValue(
        inventory({ storeId: 'store-1', quantityOnHand: 5 }),
      );

      const result = await runInTenant(() =>
        service.adjustScoped(
          { kind: 'store', storeId: 'store-1' },
          { variantId: 'var-1', delta: 5 },
        ),
      );
      expect(result.quantityOnHand).toBe(5);
      expect(mockInvCreate).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          variantId: 'var-1',
          storeId: 'store-1',
          quantityOnHand: 5,
        },
      });
    });

    it('global and store pools are fully independent rows (no cross-decrement)', async () => {
      // Global adjust targets storeId: null; store adjust targets its own
      // store — the guarded where clauses can never overlap.
      mockVariantFindUnique.mockResolvedValue(variant());
      mockStoreFindUnique.mockResolvedValue({ id: 'store-1' });
      mockInvUpdateMany.mockResolvedValue({ count: 1 });
      mockInvFindFirst.mockResolvedValue(inventory({ quantityOnHand: 10 }));

      await runInTenant(() =>
        service.adjust({ variantId: 'var-1', delta: -2 }),
      );
      expect(mockInvUpdateMany).toHaveBeenLastCalledWith({
        where: {
          variantId: 'var-1',
          storeId: null,
          quantityOnHand: { gte: 2 },
        },
        data: { quantityOnHand: { increment: -2 } },
      });

      await runInTenant(() =>
        service.adjustScoped(
          { kind: 'store', storeId: 'store-1' },
          { variantId: 'var-1', delta: -2 },
        ),
      );
      expect(mockInvUpdateMany).toHaveBeenLastCalledWith({
        where: {
          variantId: 'var-1',
          storeId: 'store-1',
          quantityOnHand: { gte: 2 },
        },
        data: { quantityOnHand: { increment: -2 } },
      });
    });
  });
});
