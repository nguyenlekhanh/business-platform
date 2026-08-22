import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { CreateCategoryDto } from './dto/category.dto';
import { CategoryService } from './category.service';

describe('CategoryService', () => {
  let service: CategoryService;
  let tenantContext: TenantContextService;

  const mockFindMany = jest.fn();
  const mockFindUnique = jest.fn();
  const mockCreate = jest.fn();
  const mockUpdate = jest.fn();
  const mockDelete = jest.fn();

  const category = (overrides: Record<string, unknown> = {}) => ({
    id: 'cat-1',
    tenantId: 'tenant-1',
    name: 'Beverages',
    description: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (tenantId, name)',
      { code: 'P2002', clientVersion: 'test' },
    );

  beforeEach(async () => {
    jest.clearAllMocks();

    tenantContext = new TenantContextService();

    const moduleRef = await Test.createTestingModule({
      providers: [
        CategoryService,
        {
          provide: PrismaService,
          useValue: {
            category: {
              findMany: mockFindMany,
              findUnique: mockFindUnique,
              create: mockCreate,
              update: mockUpdate,
              delete: mockDelete,
            },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();

    service = moduleRef.get(CategoryService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  const createDto = (
    overrides: Record<string, unknown> = {},
  ): CreateCategoryDto => ({ name: 'Beverages', ...overrides });

  describe('fail-closed tenant context', () => {
    const cases: Record<string, () => Promise<unknown>> = {
      listCategories: () => service.listCategories({}),
      getCategory: () => service.getCategory('cat-1'),
      createCategory: () => service.createCategory(createDto()),
      updateCategory: () => service.updateCategory('cat-1', { name: 'X' }),
      deleteCategory: () => service.deleteCategory('cat-1'),
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

  describe('listCategories', () => {
    it('lists categories in the current tenant context (envelope)', async () => {
      mockFindMany.mockResolvedValue([category(), category({ id: 'cat-2' })]);

      const result = await runInTenant(() => service.listCategories({}));

      expect(result.data).toHaveLength(2);
      expect(result.meta.nextCursor).toBeNull();
      expect(result.data[0]).toEqual(
        expect.objectContaining({
          id: 'cat-1',
          tenantId: 'tenant-1',
          name: 'Beverages',
          description: null,
        }),
      );
      expect(mockFindMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 21,
      });
    });

    it('honors limit/order and composes the cursor keyset', async () => {
      mockFindMany.mockResolvedValue([]);

      await runInTenant(() =>
        service.listCategories({ limit: 5, order: 'desc' }),
      );

      expect(mockFindMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 6,
      });
    });
  });

  describe('getCategory', () => {
    it('returns the projected category', async () => {
      mockFindUnique.mockResolvedValue(category());

      const result = await runInTenant(() => service.getCategory('cat-1'));

      expect(result.id).toBe('cat-1');
      expect(result.tenantId).toBe('tenant-1');
      expect(result.name).toBe('Beverages');
      expect(result.description).toBeNull();
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { id: 'cat-1' },
      });
    });

    it('throws NotFound for an unknown or cross-tenant id', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.getCategory('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createCategory', () => {
    it('creates with the context-derived tenantId and optional description', async () => {
      mockCreate.mockResolvedValue(category({ description: 'd' }));

      const result = await runInTenant(() =>
        service.createCategory(createDto({ description: 'd' })),
      );

      expect(result.name).toBe('Beverages');
      expect(mockCreate).toHaveBeenCalledWith({
        data: { tenantId: 'tenant-1', name: 'Beverages', description: 'd' },
      });
    });

    it('omits an absent description', async () => {
      mockCreate.mockResolvedValue(category());

      await runInTenant(() => service.createCategory(createDto()));

      expect(mockCreate).toHaveBeenCalledWith({
        data: { tenantId: 'tenant-1', name: 'Beverages' },
      });
    });

    it('maps a duplicate name in the same tenant to 409', async () => {
      mockCreate.mockRejectedValue(p2002());

      await expect(
        runInTenant(() => service.createCategory(createDto())),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updateCategory', () => {
    it('patches only the provided fields', async () => {
      mockFindUnique.mockResolvedValue(category());
      mockUpdate.mockResolvedValue(category({ name: 'Updated' }));

      const result = await runInTenant(() =>
        service.updateCategory('cat-1', { name: 'Updated' }),
      );

      expect(result.name).toBe('Updated');
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'cat-1' },
        data: { name: 'Updated' },
      });
    });

    it('throws NotFound before writing for unknown/cross-tenant ids', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.updateCategory('nope', { name: 'X' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('maps a duplicate-name conflict to 409', async () => {
      mockFindUnique.mockResolvedValue(category());
      mockUpdate.mockRejectedValue(p2002());

      await expect(
        runInTenant(() => service.updateCategory('cat-1', { name: 'Dup' })),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('deleteCategory', () => {
    it('deletes and returns the id', async () => {
      mockFindUnique.mockResolvedValue(category());
      mockDelete.mockResolvedValue(category());

      const result = await runInTenant(() => service.deleteCategory('cat-1'));

      expect(result).toEqual({ id: 'cat-1' });
      expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'cat-1' } });
    });

    it('throws NotFound for unknown/cross-tenant ids without deleting', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.deleteCategory('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('maps a FK-restrict violation (products still linked) to 409', async () => {
      mockFindUnique.mockResolvedValue(category());
      mockDelete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          'Foreign key constraint violated on the constraint: Product_categoryId_fkey',
          { code: 'P2003', clientVersion: 'test' },
        ),
      );

      await expect(
        runInTenant(() => service.deleteCategory('cat-1')),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'cat-1' } });
    });
  });
});
