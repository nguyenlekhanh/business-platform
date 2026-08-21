import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { CreateStoreDto } from './dto/store.dto';
import { StoreService } from './store.service';

describe('StoreService', () => {
  let service: StoreService;
  let tenantContext: TenantContextService;

  const mockFindMany = jest.fn();
  const mockFindUnique = jest.fn();
  const mockCreate = jest.fn();
  const mockUpdate = jest.fn();
  const mockDelete = jest.fn();

  const store = (overrides: Record<string, unknown> = {}) => ({
    id: 'store-1',
    tenantId: 'tenant-1',
    name: 'Main Store',
    code: 'main',
    type: 'SHOP',
    status: 'ACTIVE',
    settings: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
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
        StoreService,
        {
          provide: PrismaService,
          useValue: {
            store: {
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

    service = moduleRef.get(StoreService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  const createDto = (overrides: Record<string, unknown> = {}): CreateStoreDto =>
    ({ name: 'Main Store', code: 'main', type: 'SHOP', ...overrides }) as never;

  describe('listStores', () => {
    it('lists stores in the current tenant context (envelope, default contract)', async () => {
      mockFindMany.mockResolvedValue([store(), store({ id: 'store-2' })]);

      const result = await runInTenant(() => service.listStores({}));

      expect(result.data).toHaveLength(2);
      expect(result.meta.nextCursor).toBeNull();
      expect(result.data[0]).toEqual(
        expect.objectContaining({
          id: 'store-1',
          tenantId: 'tenant-1',
          name: 'Main Store',
          code: 'main',
          type: 'SHOP',
          status: 'ACTIVE',
          settings: null,
        }),
      );
      expect(mockFindMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 21,
      });
    });

    it('composes status+type filters and honors limit/order', async () => {
      mockFindMany.mockResolvedValue([]);

      await runInTenant(() =>
        service.listStores({
          status: 'INACTIVE',
          type: 'CAFE',
          limit: 5,
          order: 'desc',
        }),
      );

      expect(mockFindMany).toHaveBeenCalledWith({
        where: { AND: [{ status: 'INACTIVE', type: 'CAFE' }] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 6,
      });
    });

    it('rejects an invalid cursor with 400 without querying', async () => {
      await expect(
        runInTenant(() => service.listStores({ cursor: 'garbage!!' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('fails closed outside a tenant context', async () => {
      await expect(service.listStores({})).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockFindMany).not.toHaveBeenCalled();
    });
  });

  describe('getStore', () => {
    it('returns an existing store', async () => {
      mockFindUnique.mockResolvedValue(store());

      const result = await runInTenant(() => service.getStore('store-1'));

      expect(result).toEqual(
        expect.objectContaining({ id: 'store-1', tenantId: 'tenant-1' }),
      );
      expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 'store-1' } });
    });

    it('returns 404 when the store does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.getStore('store-missing')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('fails closed outside a tenant context', async () => {
      await expect(service.getStore('store-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('createStore', () => {
    it('creates a store deriving the tenant from context', async () => {
      mockCreate.mockResolvedValue(store());

      const result = await runInTenant(() => service.createStore(createDto()));

      expect(result).toEqual(expect.objectContaining({ id: 'store-1' }));
      // The tenant is derived from the TenantContext, never from the caller.
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          name: 'Main Store',
          code: 'main',
          type: 'SHOP',
        },
      });
    });

    it('never trusts a client-supplied tenantId', async () => {
      mockCreate.mockResolvedValue(store());

      const dto = createDto({ tenantId: 'tenant-9' });
      const result = await runInTenant(() => service.createStore(dto));

      expect(result.tenantId).toBe('tenant-1');
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          name: 'Main Store',
          code: 'main',
          type: 'SHOP',
        },
      });
    });

    it('passes optional status and settings through', async () => {
      mockCreate.mockResolvedValue(
        store({ status: 'INACTIVE', settings: { theme: 'dark' } }),
      );

      const result = await runInTenant(() =>
        service.createStore(
          createDto({ status: 'INACTIVE', settings: { theme: 'dark' } }),
        ),
      );

      expect(result).toEqual(
        expect.objectContaining({
          status: 'INACTIVE',
          settings: { theme: 'dark' },
        }),
      );
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          name: 'Main Store',
          code: 'main',
          type: 'SHOP',
          status: 'INACTIVE',
          settings: { theme: 'dark' },
        },
      });
    });

    it('maps a duplicate (tenantId, code) to 409', async () => {
      mockCreate.mockRejectedValue(p2002());

      await expect(
        runInTenant(() => service.createStore(createDto({ code: 'dup' }))),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows non-unique Prisma errors', async () => {
      mockCreate.mockRejectedValue(new Error('boom'));

      await expect(
        runInTenant(() => service.createStore(createDto())),
      ).rejects.toThrow('boom');
    });

    it('fails closed outside a tenant context', async () => {
      await expect(service.createStore(createDto())).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('updateStore', () => {
    it('updates allowed fields deriving the tenant from context', async () => {
      mockFindUnique.mockResolvedValue(store());
      mockUpdate.mockResolvedValue(
        store({ name: 'Renamed', type: 'CAFE', status: 'INACTIVE' }),
      );

      const result = await runInTenant(() =>
        service.updateStore('store-1', {
          name: 'Renamed',
          type: 'CAFE',
          status: 'INACTIVE',
        }),
      );

      expect(result).toEqual(
        expect.objectContaining({
          name: 'Renamed',
          type: 'CAFE',
          status: 'INACTIVE',
        }),
      );
      // The tenant is scoped by the extension into `where`; it is never written
      // into `data`, and client-controlled tenantId/id are never persisted.
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'store-1' },
        data: { name: 'Renamed', type: 'CAFE', status: 'INACTIVE' },
      });
    });

    it('never writes tenantId or id into the update data', async () => {
      mockFindUnique.mockResolvedValue(store());
      mockUpdate.mockResolvedValue(store());

      const dto = {
        tenantId: 'tenant-9',
        id: 'store-9',
        name: 'Keep Me',
      } as never;
      const result = await runInTenant(() =>
        service.updateStore('store-1', dto),
      );

      expect(result.tenantId).toBe('tenant-1');
      const updateCalls = mockUpdate.mock.calls as unknown as Array<
        [
          {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          },
        ]
      >;
      const callArgs = updateCalls[0][0];
      // Scope target stays the requested id; tenantId is never a client value.
      expect(callArgs.where).toEqual({ id: 'store-1' });
      // data contains only the whitelisted fields from the DTO.
      expect(callArgs.data).toEqual({ name: 'Keep Me' });
      expect(callArgs.data).not.toHaveProperty('tenantId');
      expect(callArgs.data).not.toHaveProperty('id');
      expect(callArgs.data).not.toHaveProperty('status');
      expect(callArgs.data).not.toHaveProperty('type');
    });

    it('passes settings through on update', async () => {
      mockFindUnique.mockResolvedValue(store());
      mockUpdate.mockResolvedValue(store({ settings: { theme: 'light' } }));

      await runInTenant(() =>
        service.updateStore('store-1', { settings: { theme: 'light' } }),
      );

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'store-1' },
        data: { settings: { theme: 'light' } },
      });
    });

    it('omits fields not present in the payload', async () => {
      mockFindUnique.mockResolvedValue(store());
      mockUpdate.mockResolvedValue(store({ name: 'Only Name' }));

      await runInTenant(() =>
        service.updateStore('store-1', { name: 'Only Name' }),
      );

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'store-1' },
        data: { name: 'Only Name' },
      });
    });

    it('never trusts a client-supplied tenantId', async () => {
      mockFindUnique.mockResolvedValue(store());
      mockUpdate.mockResolvedValue(store());

      const dto = { tenantId: 'tenant-9', name: 'X' } as never;
      const result = await runInTenant(() =>
        service.updateStore('store-1', dto),
      );

      expect(result.tenantId).toBe('tenant-1');
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'store-1' },
        data: { name: 'X' },
      });
    });

    it('returns 404 when the store does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.updateStore('store-missing', { name: 'X' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('maps a duplicate (tenantId, code) to 409', async () => {
      mockFindUnique.mockResolvedValue(store());
      mockUpdate.mockRejectedValue(p2002());

      await expect(
        runInTenant(() => service.updateStore('store-1', { code: 'dup' })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('fails closed outside a tenant context', async () => {
      await expect(
        service.updateStore('store-1', { name: 'X' }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(mockFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('deleteStore', () => {
    it('deletes a store deriving the tenant from context', async () => {
      mockFindUnique.mockResolvedValue(store());
      mockDelete.mockResolvedValue(store());

      const result = await runInTenant(() => service.deleteStore('store-1'));

      expect(result).toEqual({ id: 'store-1' });
      // The delete targets only the id; tenantId is injected by the extension
      // into the where clause, never supplied (and never overridable) by client.
      expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'store-1' } });
    });

    it('never trusts a client-supplied tenantId on delete', async () => {
      mockFindUnique.mockResolvedValue(store());
      mockDelete.mockResolvedValue(store());

      const result = await runInTenant(() => service.deleteStore('store-1'));

      expect(result).toEqual({ id: 'store-1' });
      const deleteCalls = mockDelete.mock.calls as unknown as Array<
        [
          {
            where: Record<string, unknown>;
          },
        ]
      >;
      const callArgs = deleteCalls[0][0];
      expect(callArgs.where).toEqual({ id: 'store-1' });
      expect(callArgs.where).not.toHaveProperty('tenantId');
    });

    it('returns 404 when the store does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.deleteStore('store-missing')),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('fails closed outside a tenant context', async () => {
      await expect(service.deleteStore('store-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockFindUnique).not.toHaveBeenCalled();
    });
  });
});
