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
import { EquipmentService } from './equipment.service';
import type {
  CreateEquipmentDto,
  UpdateEquipmentDto,
} from './dto/equipment.dto';

describe('EquipmentService', () => {
  let service: EquipmentService;
  let tenantContext: TenantContextService;

  const mockFindMany = jest.fn();
  const mockFindUnique = jest.fn();
  const mockCreate = jest.fn();
  const mockUpdate = jest.fn();
  const mockDelete = jest.fn();
  const mockAssetFindUnique = jest.fn();

  const equipment = (overrides: Record<string, unknown> = {}) => ({
    id: 'equip-1',
    tenantId: 'tenant-1',
    assetId: 'asset-1',
    type: 'CRANE',
    manufacturer: null,
    model: null,
    serialNumber: null,
    year: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const p2002 = (target: string[]) =>
    new Prisma.PrismaClientKnownRequestError(
      `Unique constraint failed on: ${target.join(', ')}`,
      { code: 'P2002', clientVersion: 'test', meta: { target } },
    );

  beforeEach(async () => {
    jest.clearAllMocks();

    tenantContext = new TenantContextService();

    const moduleRef = await Test.createTestingModule({
      providers: [
        EquipmentService,
        {
          provide: PrismaService,
          useValue: {
            equipment: {
              findMany: mockFindMany,
              findUnique: mockFindUnique,
              create: mockCreate,
              update: mockUpdate,
              delete: mockDelete,
            },
            asset: { findUnique: mockAssetFindUnique },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();

    service = moduleRef.get(EquipmentService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  const createDto = (
    overrides: Partial<CreateEquipmentDto> = {},
  ): CreateEquipmentDto => ({
    assetId: 'asset-1',
    type: 'CRANE',
    ...overrides,
  });

  describe('listEquipment', () => {
    it('lists equipment in the current tenant context (envelope, default contract)', async () => {
      mockFindMany.mockResolvedValue([equipment(), equipment({ id: 'eq-2' })]);

      const result = await runInTenant(() => service.listEquipment({}));

      expect(result.data).toHaveLength(2);
      expect(result.meta.nextCursor).toBeNull();
      expect(result.data[0]).toEqual(
        expect.objectContaining({
          id: 'equip-1',
          tenantId: 'tenant-1',
          assetId: 'asset-1',
          type: 'CRANE',
        }),
      );
      expect(mockFindMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 21,
      });
    });

    it('composes the type filter and honors limit/order', async () => {
      mockFindMany.mockResolvedValue([]);

      await runInTenant(() =>
        service.listEquipment({ type: 'FORKLIFT', limit: 5, order: 'desc' }),
      );

      expect(mockFindMany).toHaveBeenCalledWith({
        where: { AND: [{ type: 'FORKLIFT' }] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 6,
      });
    });

    it('rejects an invalid cursor with 400 without querying', async () => {
      await expect(
        runInTenant(() => service.listEquipment({ cursor: 'garbage!!' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('fails closed outside a tenant context', async () => {
      await expect(service.listEquipment({})).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockFindMany).not.toHaveBeenCalled();
    });
  });

  describe('getEquipment', () => {
    it('returns an existing equipment record', async () => {
      mockFindUnique.mockResolvedValue(equipment());

      const result = await runInTenant(() => service.getEquipment('equip-1'));

      expect(result).toEqual(
        expect.objectContaining({ id: 'equip-1', tenantId: 'tenant-1' }),
      );
      expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 'equip-1' } });
    });

    it('returns 404 when the equipment does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.getEquipment('equip-missing')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('fails closed outside a tenant context', async () => {
      await expect(service.getEquipment('equip-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('createEquipment', () => {
    it('creates equipment deriving the tenant from context', async () => {
      mockAssetFindUnique.mockResolvedValue({ id: 'asset-1' });
      mockCreate.mockResolvedValue(equipment());

      const result = await runInTenant(() =>
        service.createEquipment(createDto()),
      );

      expect(result).toEqual(expect.objectContaining({ id: 'equip-1' }));
      expect(mockCreate).toHaveBeenCalledWith({
        data: { tenantId: 'tenant-1', assetId: 'asset-1', type: 'CRANE' },
      });
    });

    it('resolves the asset through a scoped lookup before writing', async () => {
      mockAssetFindUnique.mockResolvedValue({ id: 'asset-1' });
      mockCreate.mockResolvedValue(equipment());

      await runInTenant(() => service.createEquipment(createDto()));

      expect(mockAssetFindUnique).toHaveBeenCalledWith({
        where: { id: 'asset-1' },
        select: { id: true },
      });
    });

    it('rejects an unknown or cross-tenant asset with 404 before any write', async () => {
      // The tenant-scoping extension makes a foreign asset resolve to null.
      mockAssetFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() =>
          service.createEquipment(createDto({ assetId: 'asset-foreign' })),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('maps a duplicate asset attachment to 409', async () => {
      mockAssetFindUnique.mockResolvedValue({ id: 'asset-1' });
      mockCreate.mockRejectedValue(p2002(['assetId']));

      await expect(
        runInTenant(() => service.createEquipment(createDto())),
      ).rejects.toThrow(ConflictException);
    });

    it('maps a duplicate tenant-scoped serial number to 409', async () => {
      mockAssetFindUnique.mockResolvedValue({ id: 'asset-1' });
      mockCreate.mockRejectedValue(p2002(['tenantId', 'serialNumber']));

      await expect(
        runInTenant(() =>
          service.createEquipment(
            createDto({ assetId: 'asset-2', serialNumber: 'SN-1' }),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows non-unique Prisma errors', async () => {
      mockAssetFindUnique.mockResolvedValue({ id: 'asset-1' });
      mockCreate.mockRejectedValue(new Error('boom'));

      await expect(
        runInTenant(() => service.createEquipment(createDto())),
      ).rejects.toThrow('boom');
    });

    it('fails closed outside a tenant context', async () => {
      await expect(service.createEquipment(createDto())).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockAssetFindUnique).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('updateEquipment', () => {
    it('updates allowed fields only, never tenantId or the asset link', async () => {
      mockFindUnique.mockResolvedValue(equipment());
      mockUpdate.mockResolvedValue(equipment({ year: 2020 }));

      const dto = {
        type: 'EXCAVATOR',
        year: 2020,
        tenantId: 'tenant-9',
        assetId: 'asset-9',
      } as unknown as UpdateEquipmentDto;
      const result = await runInTenant(() =>
        service.updateEquipment('equip-1', dto),
      );

      expect(result.year).toBe(2020);
      const updateCalls = mockUpdate.mock.calls as unknown as Array<
        [{ where: Record<string, unknown>; data: Record<string, unknown> }]
      >;
      const callArgs = updateCalls[0][0];
      expect(callArgs.where).toEqual({ id: 'equip-1' });
      expect(callArgs.data).toEqual({ type: 'EXCAVATOR', year: 2020 });
      expect(callArgs.data).not.toHaveProperty('tenantId');
      expect(callArgs.data).not.toHaveProperty('assetId');
    });

    it('returns 404 when the equipment does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() =>
          service.updateEquipment('equip-missing', { year: 2020 }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('maps a duplicate serial number on update to 409', async () => {
      mockFindUnique.mockResolvedValue(equipment());
      mockUpdate.mockRejectedValue(p2002(['tenantId', 'serialNumber']));

      await expect(
        runInTenant(() =>
          service.updateEquipment('equip-1', { serialNumber: 'SN-DUP' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('fails closed outside a tenant context', async () => {
      await expect(
        service.updateEquipment('equip-1', { year: 2020 }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(mockFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('deleteEquipment', () => {
    it('deletes equipment deriving the tenant from context', async () => {
      mockFindUnique.mockResolvedValue(equipment());
      mockDelete.mockResolvedValue(equipment());

      const result = await runInTenant(() =>
        service.deleteEquipment('equip-1'),
      );

      expect(result).toEqual({ id: 'equip-1' });
      expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'equip-1' } });
    });

    it('returns 404 when the equipment does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.deleteEquipment('equip-missing')),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('fails closed outside a tenant context', async () => {
      await expect(service.deleteEquipment('equip-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockFindUnique).not.toHaveBeenCalled();
    });
  });
});
