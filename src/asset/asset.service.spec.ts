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
import { AssetService } from './asset.service';
import type { CreateAssetDto, UpdateAssetDto } from './dto/asset.dto';

describe('AssetService', () => {
  let service: AssetService;
  let tenantContext: TenantContextService;

  const mockFindMany = jest.fn();
  const mockFindUnique = jest.fn();
  const mockCreate = jest.fn();
  const mockUpdate = jest.fn();
  const mockDelete = jest.fn();
  const mockStoreFindUnique = jest.fn();

  const asset = (overrides: Record<string, unknown> = {}) => ({
    id: 'asset-1',
    tenantId: 'tenant-1',
    name: 'Tower Crane',
    code: 'crane-01',
    type: 'crane',
    description: null,
    status: 'ACTIVE',
    settings: null,
    storeId: null,
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
        AssetService,
        {
          provide: PrismaService,
          useValue: {
            asset: {
              findMany: mockFindMany,
              findUnique: mockFindUnique,
              create: mockCreate,
              update: mockUpdate,
              delete: mockDelete,
            },
            store: { findUnique: mockStoreFindUnique },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();

    service = moduleRef.get(AssetService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  const createDto = (
    overrides: Partial<CreateAssetDto> = {},
  ): CreateAssetDto => ({
    name: 'Tower Crane',
    code: 'crane-01',
    type: 'crane',
    ...overrides,
  });

  describe('listAssets', () => {
    it('lists assets in the current tenant context (envelope, default contract)', async () => {
      mockFindMany.mockResolvedValue([asset(), asset({ id: 'asset-2' })]);

      const result = await runInTenant(() => service.listAssets({}));

      expect(result.data).toHaveLength(2);
      expect(result.meta.nextCursor).toBeNull();
      expect(result.data[0]).toEqual(
        expect.objectContaining({
          id: 'asset-1',
          tenantId: 'tenant-1',
          name: 'Tower Crane',
          code: 'crane-01',
        }),
      );
      expect(mockFindMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 21,
      });
    });

    it('composes equality filters and honors limit/order', async () => {
      mockFindMany.mockResolvedValue([]);

      await runInTenant(() =>
        service.listAssets({
          type: 'crane',
          status: 'ACTIVE',
          storeId: 'store-1',
          limit: 5,
          order: 'desc',
        }),
      );

      expect(mockFindMany).toHaveBeenCalledWith({
        where: {
          AND: [{ type: 'crane', status: 'ACTIVE', storeId: 'store-1' }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 6,
      });
    });

    it('rejects an invalid cursor with 400 without querying', async () => {
      await expect(
        runInTenant(() => service.listAssets({ cursor: 'garbage!!' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('fails closed outside a tenant context', async () => {
      await expect(service.listAssets({})).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockFindMany).not.toHaveBeenCalled();
    });
  });

  describe('getAsset', () => {
    it('returns an existing asset', async () => {
      mockFindUnique.mockResolvedValue(asset());

      const result = await runInTenant(() => service.getAsset('asset-1'));

      expect(result).toEqual(
        expect.objectContaining({ id: 'asset-1', tenantId: 'tenant-1' }),
      );
      expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 'asset-1' } });
    });

    it('returns 404 when the asset does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.getAsset('asset-missing')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('fails closed outside a tenant context', async () => {
      await expect(service.getAsset('asset-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('createAsset', () => {
    it('creates an asset deriving the tenant from context', async () => {
      mockCreate.mockResolvedValue(asset());

      const result = await runInTenant(() => service.createAsset(createDto()));

      expect(result).toEqual(expect.objectContaining({ id: 'asset-1' }));
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          name: 'Tower Crane',
          code: 'crane-01',
          type: 'crane',
          storeId: null,
        },
      });
    });

    it('never trusts a client-supplied tenantId', async () => {
      mockCreate.mockResolvedValue(asset());

      const dto = createDto({
        tenantId: 'tenant-9',
      } as unknown as CreateAssetDto);
      const result = await runInTenant(() => service.createAsset(dto));

      // The tenant is context-derived, never the client value.
      expect(result.tenantId).toBe('tenant-1');
      expect(mockCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ tenantId: 'tenant-1' }),
      });
    });

    it('resolves a tenant-scoped storeId and rejects a foreign one (404)', async () => {
      mockStoreFindUnique.mockResolvedValue({ id: 'store-1' });
      mockCreate.mockResolvedValue(asset({ storeId: 'store-1' }));

      await runInTenant(() =>
        service.createAsset(createDto({ storeId: 'store-1' })),
      );

      expect(mockStoreFindUnique).toHaveBeenCalledWith({
        where: { id: 'store-1' },
        select: { id: true },
      });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ storeId: 'store-1' }),
        }),
      );
    });

    it('rejects a cross-tenant storeId with 404', async () => {
      mockStoreFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() =>
          service.createAsset(createDto({ storeId: 'store-foreign' })),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('maps a duplicate (tenantId, code) to 409', async () => {
      mockCreate.mockRejectedValue(p2002());

      await expect(
        runInTenant(() => service.createAsset(createDto({ code: 'dup' }))),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows non-unique Prisma errors', async () => {
      mockCreate.mockRejectedValue(new Error('boom'));

      await expect(
        runInTenant(() => service.createAsset(createDto())),
      ).rejects.toThrow('boom');
    });

    it('fails closed outside a tenant context', async () => {
      await expect(service.createAsset(createDto())).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('updateAsset', () => {
    it('updates allowed fields deriving the tenant from context', async () => {
      mockFindUnique.mockResolvedValue(asset());
      mockUpdate.mockResolvedValue(
        asset({ name: 'Renamed', type: 'vehicle', status: 'INACTIVE' }),
      );

      const result = await runInTenant(() =>
        service.updateAsset('asset-1', {
          name: 'Renamed',
          type: 'vehicle',
          status: 'INACTIVE',
        }),
      );

      expect(result).toEqual(
        expect.objectContaining({ name: 'Renamed', type: 'vehicle' }),
      );
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'asset-1' },
        data: { name: 'Renamed', type: 'vehicle', status: 'INACTIVE' },
      });
    });

    it('never writes tenantId or id into the update data', async () => {
      mockFindUnique.mockResolvedValue(asset());
      mockUpdate.mockResolvedValue(asset());

      const dto = {
        tenantId: 'tenant-9',
        id: 'asset-9',
        name: 'Keep Me',
      } as unknown as UpdateAssetDto;
      const result = await runInTenant(() =>
        service.updateAsset('asset-1', dto),
      );

      expect(result.tenantId).toBe('tenant-1');
      const updateCalls = mockUpdate.mock.calls as unknown as Array<
        [{ where: Record<string, unknown>; data: Record<string, unknown> }]
      >;
      const callArgs = updateCalls[0][0];
      expect(callArgs.where).toEqual({ id: 'asset-1' });
      expect(callArgs.data).toEqual({ name: 'Keep Me' });
      expect(callArgs.data).not.toHaveProperty('tenantId');
      expect(callArgs.data).not.toHaveProperty('id');
    });

    it('resolves a changed storeId within the same tenant', async () => {
      mockFindUnique.mockResolvedValue(asset());
      mockStoreFindUnique.mockResolvedValue({ id: 'store-2' });
      mockUpdate.mockResolvedValue(asset({ storeId: 'store-2' }));

      await runInTenant(() =>
        service.updateAsset('asset-1', { storeId: 'store-2' }),
      );

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'asset-1' },
        data: { storeId: 'store-2' },
      });
    });

    it('rejects moving an asset to a foreign store with 404', async () => {
      mockFindUnique.mockResolvedValue(asset());
      mockStoreFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() =>
          service.updateAsset('asset-1', { storeId: 'store-foreign' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('returns 404 when the asset does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.updateAsset('asset-missing', { name: 'X' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('maps a duplicate (tenantId, code) to 409 on update', async () => {
      mockFindUnique.mockResolvedValue(asset());
      mockUpdate.mockRejectedValue(p2002());

      await expect(
        runInTenant(() => service.updateAsset('asset-1', { code: 'dup' })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('fails closed outside a tenant context', async () => {
      await expect(
        service.updateAsset('asset-1', { name: 'X' }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(mockFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('deleteAsset', () => {
    it('deletes an asset deriving the tenant from context', async () => {
      mockFindUnique.mockResolvedValue(asset());
      mockDelete.mockResolvedValue(asset());

      const result = await runInTenant(() => service.deleteAsset('asset-1'));

      expect(result).toEqual({ id: 'asset-1' });
      expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'asset-1' } });
    });

    it('returns 404 when the asset does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.deleteAsset('asset-missing')),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('fails closed outside a tenant context', async () => {
      await expect(service.deleteAsset('asset-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockFindUnique).not.toHaveBeenCalled();
    });
  });
});
