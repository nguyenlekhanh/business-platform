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
  const mockInvFindUnique = jest.fn();
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
            inventory: {
              findUnique: mockInvFindUnique,
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
      mockInvFindUnique.mockResolvedValue(null);
      const result = await runInTenant(() => service.getInventory('var-1'));
      expect(result.quantityOnHand).toBe(0);
      expect(result.id).toBeNull();
      expect(result.variantId).toBe('var-1');
      expect(result.tenantId).toBe('tenant-1');
    });

    it('returns stored quantity when row exists', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockInvFindUnique.mockResolvedValue(inventory({ quantityOnHand: 7 }));
      const result = await runInTenant(() => service.getInventory('var-1'));
      expect(result.quantityOnHand).toBe(7);
      expect(result.id).toBe('inv-1');
    });

    it('throws NotFound for unknown/cross-tenant variant', async () => {
      mockVariantFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.getInventory('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockInvFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('adjust', () => {
    it('creates row on first positive delta when no row exists', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockInvUpdateMany.mockResolvedValue({ count: 0 });
      mockInvFindUnique
        .mockResolvedValueOnce(null) // check after updateMany 0
        .mockResolvedValueOnce(null); // not needed?
      mockInvCreate.mockResolvedValue(inventory({ quantityOnHand: 5 }));

      const result = await runInTenant(() =>
        service.adjust({ variantId: 'var-1', delta: 5 }),
      );
      expect(result.quantityOnHand).toBe(5);
      expect(mockInvCreate).toHaveBeenCalledWith({
        data: { tenantId: 'tenant-1', variantId: 'var-1', quantityOnHand: 5 },
      });
    });

    it('throws insufficient stock when decrementing missing row', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockInvUpdateMany.mockResolvedValue({ count: 0 });
      mockInvFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.adjust({ variantId: 'var-1', delta: -1 })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockInvCreate).not.toHaveBeenCalled();
    });

    it('applies guarded updateMany for positive delta on existing row', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockInvUpdateMany.mockResolvedValue({ count: 1 });
      mockInvFindUnique.mockResolvedValue(inventory({ quantityOnHand: 15 }));

      const result = await runInTenant(() =>
        service.adjust({ variantId: 'var-1', delta: 5 }),
      );
      expect(result.quantityOnHand).toBe(15);
      expect(mockInvUpdateMany).toHaveBeenCalledWith({
        where: { variantId: 'var-1', quantityOnHand: { gte: -5 } },
        data: { quantityOnHand: { increment: 5 } },
      });
      expect(mockInvCreate).not.toHaveBeenCalled();
    });

    it('throws insufficient stock when guarded update fails on existing row', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockInvUpdateMany.mockResolvedValue({ count: 0 });
      mockInvFindUnique.mockResolvedValue(inventory({ quantityOnHand: 2 }));

      await expect(
        runInTenant(() => service.adjust({ variantId: 'var-1', delta: -5 })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('falls back to retry after P2002 race on lazy create', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockInvUpdateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      mockInvFindUnique.mockResolvedValueOnce(null); // first check missing
      mockInvCreate.mockRejectedValue(p2002());
      // after fallback, findUnique returns row
      mockInvFindUnique.mockResolvedValueOnce(inventory({ quantityOnHand: 5 })); // retry fetch

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
});
