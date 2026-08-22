import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { CreateProductDto, ProductListQueryDto } from './dto/product.dto';
import { ProductService } from './product.service';

describe('ProductService', () => {
  let service: ProductService;
  let tenantContext: TenantContextService;

  const mockFindMany = jest.fn();
  const mockFindUnique = jest.fn();
  const mockCategoryFindUnique = jest.fn();
  const mockCreate = jest.fn();
  const mockUpdate = jest.fn();
  const mockDelete = jest.fn();

  const product = (overrides: Record<string, unknown> = {}) => ({
    id: 'prod-1',
    tenantId: 'tenant-1',
    categoryId: null as string | null,
    name: 'Espresso Beans',
    code: 'ESP-1',
    description: null,
    status: 'DRAFT',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (tenantId, code)',
      { code: 'P2002', clientVersion: 'test' },
    );

  beforeEach(async () => {
    jest.clearAllMocks();

    tenantContext = new TenantContextService();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductService,
        {
          provide: PrismaService,
          useValue: {
            product: {
              findMany: mockFindMany,
              findUnique: mockFindUnique,
              create: mockCreate,
              update: mockUpdate,
              delete: mockDelete,
            },
            category: { findUnique: mockCategoryFindUnique },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();

    service = moduleRef.get(ProductService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  const createDto = (
    overrides: Record<string, unknown> = {},
  ): CreateProductDto => ({
    name: 'Espresso Beans',
    code: 'ESP-1',
    ...overrides,
  });

  describe('fail-closed tenant context', () => {
    const cases: Record<string, () => Promise<unknown>> = {
      listProducts: () => service.listProducts({}),
      getProduct: () => service.getProduct('prod-1'),
      createProduct: () => service.createProduct(createDto()),
      updateProduct: () => service.updateProduct('prod-1', { name: 'X' }),
      deleteProduct: () => service.deleteProduct('prod-1'),
    };
    for (const [name, fn] of Object.entries(cases)) {
      it(`${name} fails closed without a tenant context`, async () => {
        await expect(fn()).rejects.toBeInstanceOf(InternalServerErrorException);
        expect(mockFindMany).not.toHaveBeenCalled();
        expect(mockFindUnique).not.toHaveBeenCalled();
        expect(mockCreate).not.toHaveBeenCalled();
      });
    }
  });

  describe('listProducts', () => {
    it('lists products in the current tenant context (envelope)', async () => {
      mockFindMany.mockResolvedValue([product(), product({ id: 'prod-2' })]);

      const result = await runInTenant(() => service.listProducts({}));

      expect(result.data).toHaveLength(2);
      expect(result.meta.nextCursor).toBeNull();
      expect(result.data[0]).toEqual(
        expect.objectContaining({
          id: 'prod-1',
          tenantId: 'tenant-1',
          name: 'Espresso Beans',
          code: 'ESP-1',
          status: 'DRAFT',
          categoryId: null,
        }),
      );
      expect(mockFindMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 21,
      });
    });

    it('composes status+categoryId filters and honors limit/order', async () => {
      mockFindMany.mockResolvedValue([]);

      const query: ProductListQueryDto = {
        status: 'ACTIVE',
        categoryId: 'cat-9',
        limit: 5,
        order: 'desc',
      };
      await runInTenant(() => service.listProducts(query));

      expect(mockFindMany).toHaveBeenCalledWith({
        where: {
          AND: [{ status: 'ACTIVE', categoryId: 'cat-9' }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 6,
      });
    });

    it('uses the bare filter object when only one equality filter is present', async () => {
      mockFindMany.mockResolvedValue([]);

      await runInTenant(() => service.listProducts({ status: 'ARCHIVED' }));

      expect(mockFindMany).toHaveBeenCalledWith({
        where: { AND: [{ status: 'ARCHIVED' }] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 21,
      });
    });
  });

  describe('getProduct', () => {
    it('returns the projected product', async () => {
      mockFindUnique.mockResolvedValue(
        product({ categoryId: 'cat-1', status: 'ACTIVE' }),
      );

      const result = await runInTenant(() => service.getProduct('prod-1'));

      expect(result.id).toBe('prod-1');
      expect(result.categoryId).toBe('cat-1');
      expect(result.status).toBe('ACTIVE');
      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { id: 'prod-1' },
      });
    });

    it('throws NotFound for an unknown or cross-tenant id', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.getProduct('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createProduct', () => {
    it('creates with context-derived tenantId and defaults (DRAFT, no category)', async () => {
      mockCreate.mockResolvedValue(product());

      const result = await runInTenant(() =>
        service.createProduct(createDto()),
      );

      expect(result.status).toBe('DRAFT');
      expect(mockCreate).toHaveBeenCalledWith({
        data: { tenantId: 'tenant-1', name: 'Espresso Beans', code: 'ESP-1' },
      });
      expect(mockCategoryFindUnique).not.toHaveBeenCalled();
    });

    it('resolves an optional categoryId through a same-tenant lookup', async () => {
      mockCategoryFindUnique.mockResolvedValue({ id: 'cat-1' });
      mockCreate.mockResolvedValue(product({ categoryId: 'cat-1' }));

      await runInTenant(() =>
        service.createProduct(createDto({ categoryId: 'cat-1' })),
      );

      expect(mockCategoryFindUnique).toHaveBeenCalledWith({
        where: { id: 'cat-1' },
        select: { id: true },
      });
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          name: 'Espresso Beans',
          code: 'ESP-1',
          categoryId: 'cat-1',
        },
      });
    });

    it('rejects a cross-tenant or unknown categoryId with 404 before writing', async () => {
      mockCategoryFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() =>
          service.createProduct(createDto({ categoryId: 'foreign' })),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('maps a duplicate code in the same tenant to 409', async () => {
      mockCreate.mockRejectedValue(p2002());

      await expect(
        runInTenant(() => service.createProduct(createDto())),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updateProduct', () => {
    it('patches only the provided fields incl. archive flow', async () => {
      mockFindUnique.mockResolvedValue(product());
      mockUpdate.mockResolvedValue(product({ status: 'ACTIVE' }));

      const result = await runInTenant(() =>
        service.updateProduct('prod-1', { status: 'ACTIVE' }),
      );

      expect(result.status).toBe('ACTIVE');
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'prod-1' },
        data: { status: 'ACTIVE' },
      });
      expect(mockCategoryFindUnique).not.toHaveBeenCalled();
    });

    it('re-validates a changed categoryId against the active tenant', async () => {
      mockFindUnique.mockResolvedValue(product());
      mockCategoryFindUnique.mockResolvedValue({ id: 'cat-2' });
      mockUpdate.mockResolvedValue(product({ categoryId: 'cat-2' }));

      await runInTenant(() =>
        service.updateProduct('prod-1', { categoryId: 'cat-2' }),
      );

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'prod-1' },
        data: { categoryId: 'cat-2' },
      });
    });

    it('throws NotFound before writing for unknown/cross-tenant ids', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.updateProduct('nope', { name: 'X' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('throws NotFound for a cross-tenant categoryId without writing', async () => {
      mockFindUnique.mockResolvedValue(product());
      mockCategoryFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() =>
          service.updateProduct('prod-1', { categoryId: 'foreign' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('maps a duplicate-code conflict to 409', async () => {
      mockFindUnique.mockResolvedValue(product());
      mockUpdate.mockRejectedValue(p2002());

      await expect(
        runInTenant(() => service.updateProduct('prod-1', { code: 'DUP' })),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('deleteProduct', () => {
    it('deletes and returns the id', async () => {
      mockFindUnique.mockResolvedValue(product());
      mockDelete.mockResolvedValue(product());

      const result = await runInTenant(() => service.deleteProduct('prod-1'));

      expect(result).toEqual({ id: 'prod-1' });
      expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'prod-1' } });
    });

    it('throws NotFound for unknown/cross-tenant ids without deleting', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.deleteProduct('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });
});
