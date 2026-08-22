import {
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { encodeCursor, filterFingerprint } from '../common/pagination/cursor';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  CreateProductVariantDto,
  PutPriceDto,
} from './dto/product-variant.dto';
import { ProductVariantService } from './product-variant.service';

describe('ProductVariantService', () => {
  let service: ProductVariantService;
  let tenantContext: TenantContextService;

  const mockVariantFindMany = jest.fn();
  const mockVariantFindUnique = jest.fn();
  const mockVariantCreate = jest.fn();
  const mockVariantUpdate = jest.fn();
  const mockVariantDelete = jest.fn();
  const mockProductFindUnique = jest.fn();
  const mockPriceFindMany = jest.fn();
  const mockPriceFindUnique = jest.fn();
  const mockPriceCreate = jest.fn();
  const mockPriceUpdate = jest.fn();

  const variant = (overrides: Record<string, unknown> = {}) => ({
    id: 'var-1',
    tenantId: 'tenant-1',
    productId: 'prod-1',
    sku: 'ESP-1-250G',
    name: null,
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
    amountMinor: 1250n,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (tenantId, sku)',
      { code: 'P2002', clientVersion: 'test' },
    );

  beforeEach(async () => {
    jest.clearAllMocks();

    tenantContext = new TenantContextService();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductVariantService,
        {
          provide: PrismaService,
          useValue: {
            productVariant: {
              findMany: mockVariantFindMany,
              findUnique: mockVariantFindUnique,
              create: mockVariantCreate,
              update: mockVariantUpdate,
              delete: mockVariantDelete,
            },
            product: { findUnique: mockProductFindUnique },
            price: {
              findMany: mockPriceFindMany,
              findUnique: mockPriceFindUnique,
              create: mockPriceCreate,
              update: mockPriceUpdate,
            },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();

    service = moduleRef.get(ProductVariantService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  const createDto = (
    overrides: Record<string, unknown> = {},
  ): CreateProductVariantDto => ({ sku: 'ESP-1-250G', ...overrides });

  describe('fail-closed tenant context', () => {
    const cases: Record<string, () => Promise<unknown>> = {
      listVariants: () => service.listVariants('prod-1', {}),
      createVariant: () => service.createVariant('prod-1', createDto()),
      updateVariant: () => service.updateVariant('var-1', { name: 'X' }),
      deleteVariant: () => service.deleteVariant('var-1'),
      putPrice: () =>
        service.putPrice('var-1', {
          currency: 'USD',
          amountMinor: 100,
        }),
    };
    for (const [name, fn] of Object.entries(cases)) {
      it(`${name} fails closed without a tenant context`, async () => {
        await expect(fn()).rejects.toBeInstanceOf(InternalServerErrorException);
        expect(mockProductFindUnique).not.toHaveBeenCalled();
        expect(mockVariantFindUnique).not.toHaveBeenCalled();
        expect(mockVariantCreate).not.toHaveBeenCalled();
        expect(mockPriceCreate).not.toHaveBeenCalled();
      });
    }
  });

  describe('listVariants', () => {
    it('resolves the parent product first and returns an envelope with embedded prices', async () => {
      mockProductFindUnique.mockResolvedValue({ id: 'prod-1' });
      mockVariantFindMany.mockResolvedValue([
        variant(),
        variant({ id: 'var-2' }),
      ]);
      mockPriceFindMany.mockResolvedValue([
        price(),
        price({
          id: 'price-2',
          variantId: 'var-1',
          currency: 'EUR',
          amountMinor: 999n,
        }),
      ]);

      const result = await runInTenant(() =>
        service.listVariants('prod-1', {}),
      );

      expect(mockProductFindUnique).toHaveBeenCalledWith({
        where: { id: 'prod-1' },
      });
      expect(result.data).toHaveLength(2);
      expect(result.meta.nextCursor).toBeNull();

      const first = result.data[0];
      expect(first).toEqual(
        expect.objectContaining({
          id: 'var-1',
          productId: 'prod-1',
          status: 'ACTIVE',
        }),
      );
      // BigInt amounts are serialized as strings (approved convention).
      expect(first.prices).toEqual([
        { currency: 'USD', amountMinor: '1250' },
        { currency: 'EUR', amountMinor: '999' },
      ]);
      expect(result.data[1].prices).toEqual([]);

      expect(mockVariantFindMany).toHaveBeenCalledWith({
        where: { AND: [{ productId: 'prod-1' }] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 21,
      });
      expect(mockPriceFindMany).toHaveBeenCalledWith({
        where: { variantId: { in: ['var-1', 'var-2'] } },
      });
    });

    it('throws NotFound for an unknown or cross-tenant product without querying variants', async () => {
      mockProductFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.listVariants('foreign', {})),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockVariantFindMany).not.toHaveBeenCalled();
    });

    it('composes the keyset predicate after equality on cursor pages', async () => {
      mockProductFindUnique.mockResolvedValue({ id: 'prod-1' });
      mockVariantFindMany.mockResolvedValue([]);
      mockPriceFindMany.mockResolvedValue([]);
      const cursor = encodeCursor(
        'createdAt',
        'asc',
        new Date(2020, 0, 1).getTime(),
        'var-9',
        filterFingerprint({ productId: 'prod-1' }),
      );

      await runInTenant(() => service.listVariants('prod-1', { cursor }));

      const call = (
        mockVariantFindMany.mock.calls as unknown as Array<
          [{ where: { AND: Array<Record<string, unknown>> } }]
        >
      )[0][0];
      // Cursor page: keyset predicate composed AFTER the equality filter.
      expect(call.where.AND).toHaveLength(2);
      expect(call.where.AND[0]).toEqual({ productId: 'prod-1' });
      expect(call.where.AND[1]).toEqual({
        OR: [
          { createdAt: { gt: new Date(2020, 0, 1) } },
          { createdAt: { equals: new Date(2020, 0, 1) }, id: { gt: 'var-9' } },
        ],
      });
    });

    it('rejects an invalid cursor with 400 without querying', async () => {
      mockProductFindUnique.mockResolvedValue({ id: 'prod-1' });

      await expect(
        runInTenant(() =>
          service.listVariants('prod-1', { cursor: 'garbage!!' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockVariantFindMany).not.toHaveBeenCalled();
    });
  });

  describe('createVariant', () => {
    it('creates under the resolved same-tenant product and defaults to ACTIVE with no prices', async () => {
      mockProductFindUnique.mockResolvedValue({ id: 'prod-1' });
      mockVariantCreate.mockResolvedValue(variant());

      const result = await runInTenant(() =>
        service.createVariant('prod-1', createDto()),
      );

      expect(result.status).toBe('ACTIVE');
      expect(result.prices).toEqual([]);
      expect(mockVariantCreate).toHaveBeenCalledWith({
        data: { tenantId: 'tenant-1', productId: 'prod-1', sku: 'ESP-1-250G' },
      });
    });

    it('throws NotFound before writing for a foreign/unknown product', async () => {
      mockProductFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.createVariant('foreign', createDto())),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockVariantCreate).not.toHaveBeenCalled();
    });

    it('maps a duplicate SKU within the tenant to 409', async () => {
      mockProductFindUnique.mockResolvedValue({ id: 'prod-1' });
      mockVariantCreate.mockRejectedValue(p2002());

      await expect(
        runInTenant(() => service.createVariant('prod-1', createDto())),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updateVariant', () => {
    it('patches only provided fields incl. the archive flow, returning embedded prices', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockVariantUpdate.mockResolvedValue(
        variant({ status: 'ARCHIVED', name: 'Bag' }),
      );
      mockPriceFindMany.mockResolvedValue([price()]);

      const result = await runInTenant(() =>
        service.updateVariant('var-1', { status: 'ARCHIVED', name: 'Bag' }),
      );

      expect(result.status).toBe('ARCHIVED');
      expect(result.prices).toEqual([{ currency: 'USD', amountMinor: '1250' }]);
      expect(mockVariantUpdate).toHaveBeenCalledWith({
        where: { id: 'var-1' },
        data: { name: 'Bag', status: 'ARCHIVED' },
      });
    });

    it('throws NotFound for unknown/cross-tenant ids without writing', async () => {
      mockVariantFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.updateVariant('nope', { name: 'X' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockVariantUpdate).not.toHaveBeenCalled();
    });

    it('maps a duplicate SKU to 409', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockVariantUpdate.mockRejectedValue(p2002());

      await expect(
        runInTenant(() => service.updateVariant('var-1', { sku: 'DUP' })),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('deleteVariant', () => {
    it('deletes and returns the id', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockVariantDelete.mockResolvedValue(variant());

      const result = await runInTenant(() => service.deleteVariant('var-1'));

      expect(result).toEqual({ id: 'var-1' });
      expect(mockVariantDelete).toHaveBeenCalledWith({
        where: { id: 'var-1' },
      });
    });

    it('throws NotFound for unknown/cross-tenant ids without deleting', async () => {
      mockVariantFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.deleteVariant('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockVariantDelete).not.toHaveBeenCalled();
    });
  });

  describe('putPrice', () => {
    const dto: PutPriceDto = { currency: 'USD', amountMinor: 1500 };

    it('creates a price when the pair is missing (amount as exact BigInt)', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockPriceFindUnique.mockResolvedValue(null);
      mockPriceCreate.mockResolvedValue(price({ amountMinor: 1500n }));

      const result = await runInTenant(() => service.putPrice('var-1', dto));

      expect(result.amountMinor).toBe('1500');
      expect(mockPriceCreate).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          variantId: 'var-1',
          currency: 'USD',
          amountMinor: 1500n,
        },
      });
      expect(mockPriceUpdate).not.toHaveBeenCalled();
    });

    it('overwrites the existing pair row without creating history', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockPriceFindUnique.mockResolvedValue(price());
      mockPriceUpdate.mockResolvedValue(price({ amountMinor: 2000n }));

      const result = await runInTenant(() => service.putPrice('var-1', dto));

      expect(result.amountMinor).toBe('2000');
      expect(mockPriceUpdate).toHaveBeenCalledWith({
        where: { variantId_currency: { variantId: 'var-1', currency: 'USD' } },
        data: { amountMinor: 1500n },
      });
      expect(mockPriceCreate).not.toHaveBeenCalled();
    });

    it('falls back to update when a concurrent first insert wins the race', async () => {
      mockVariantFindUnique.mockResolvedValue(variant());
      mockPriceFindUnique.mockResolvedValue(null);
      mockPriceCreate.mockRejectedValue(p2002());
      mockPriceUpdate.mockResolvedValue(price());

      const result = await runInTenant(() => service.putPrice('var-1', dto));

      expect(result.amountMinor).toBe('1250');
      expect(mockPriceUpdate).toHaveBeenCalledWith({
        where: { variantId_currency: { variantId: 'var-1', currency: 'USD' } },
        data: { amountMinor: 1500n },
      });
    });

    it('throws NotFound for unknown/cross-tenant variants without touching prices', async () => {
      mockVariantFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.putPrice('nope', dto)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPriceFindUnique).not.toHaveBeenCalled();
      expect(mockPriceCreate).not.toHaveBeenCalled();
    });
  });
});
