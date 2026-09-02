import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { ServiceService } from './service.service';
import type { Service } from '@prisma/client';

/** Real known-request error so the isP2002 type-guard accepts the mock. */
const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

/** Typed accessor for create() call arguments. */
interface CreateArgs {
  data: {
    tenantId: string;
    name: string;
    description?: string;
    status?: Service['status'];
  };
}
/** Typed accessor for update() call arguments. */
interface UpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}
/** Typed accessor for findMany() call arguments. */
interface FindManyArgs {
  where: Record<string, unknown>;
  orderBy: Array<Record<string, string>>;
  take: number;
}

describe('ServiceService', () => {
  let service: ServiceService;
  let tenantContext: TenantContextService;

  const mockCreate = jest.fn();
  const mockFindUnique = jest.fn();
  const mockFindMany = jest.fn();
  const mockUpdate = jest.fn();

  const serviceRow = (overrides: Partial<Service> = {}): Service => ({
    id: 'svc-1',
    tenantId: 'tenant-1',
    name: 'Haircut',
    description: null,
    status: 'DRAFT',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    tenantContext = new TenantContextService();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ServiceService,
        {
          provide: PrismaService,
          useValue: {
            service: {
              create: mockCreate,
              findUnique: mockFindUnique,
              findMany: mockFindMany,
              update: mockUpdate,
            },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();
    service = moduleRef.get(ServiceService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  describe('fail-closed', () => {
    it('listServices fails closed without tenant context', async () => {
      await expect(service.listServices({})).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('getService fails closed without tenant context', async () => {
      await expect(service.getService('svc-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('createService fails closed without tenant context', async () => {
      await expect(service.createService({ name: 'x' })).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('updateService fails closed without tenant context', async () => {
      await expect(
        service.updateService('svc-1', { name: 'x' }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('listServices', () => {
    it('composes the status equality filter + keyset via the shared helpers', async () => {
      mockFindMany.mockResolvedValue([serviceRow({ status: 'ACTIVE' })]);
      const page = await runInTenant(() =>
        service.listServices({ status: 'ACTIVE' } as never),
      );
      expect(page.data).toHaveLength(1);
      const args = (mockFindMany.mock.calls[0] as unknown as [FindManyArgs])[0];
      expect(args.where.AND[0]).toEqual({ status: 'ACTIVE' });
      expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
      expect(args.take).toBe(21); // DEFAULT_PAGE_SIZE + 1 probe row
    });

    it('returns the shared envelope with a null nextCursor on the last page', async () => {
      mockFindMany.mockResolvedValue([serviceRow()]);
      const page = await runInTenant(() => service.listServices({}));
      expect(page.meta).toEqual({ nextCursor: null });
    });
  });

  describe('getService', () => {
    it('returns the safe projection for a found service', async () => {
      mockFindUnique.mockResolvedValue(serviceRow());
      const summary = await runInTenant(() => service.getService('svc-1'));
      expect(summary).toEqual({
        id: 'svc-1',
        tenantId: 'tenant-1',
        name: 'Haircut',
        description: null,
        status: 'DRAFT',
        createdAt: serviceRow().createdAt,
        updatedAt: serviceRow().updatedAt,
      });
    });

    it('throws NotFound for an unknown/foreign service (uniform 404)', async () => {
      mockFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.getService('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createService', () => {
    it('creates with the context-derived tenantId and DRAFT default', async () => {
      mockCreate.mockResolvedValue(serviceRow());
      const result = await runInTenant(() =>
        service.createService({ name: 'Haircut' }),
      );
      expect(result.status).toBe('DRAFT');
      const args = (mockCreate.mock.calls[0] as unknown as [CreateArgs])[0];
      expect(args.data.tenantId).toBe('tenant-1'); // server-derived
      expect(args.data.name).toBe('Haircut');
      expect(args.data.status).toBeUndefined(); // not passed -> DB default
    });

    it('forwards optional description and status', async () => {
      mockCreate.mockResolvedValue(
        serviceRow({ description: 'd', status: 'ACTIVE' }),
      );
      await runInTenant(() =>
        service.createService({
          name: 'Haircut',
          description: 'd',
          status: 'ACTIVE',
        }),
      );
      const args = (mockCreate.mock.calls[0] as unknown as [CreateArgs])[0];
      expect(args.data.description).toBe('d');
      expect(args.data.status).toBe('ACTIVE');
    });

    it('maps a duplicate (tenantId, name) to 409', async () => {
      mockCreate.mockRejectedValue(p2002());
      await expect(
        runInTenant(() => service.createService({ name: 'Haircut' })),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updateService', () => {
    it('patches name/description/status without ever writing tenantId', async () => {
      mockFindUnique.mockResolvedValue(serviceRow());
      mockUpdate.mockResolvedValue(
        serviceRow({ name: 'New', status: 'ARCHIVED', description: 'd' }),
      );
      const result = await runInTenant(() =>
        service.updateService('svc-1', {
          name: 'New',
          description: 'd',
          status: 'ARCHIVED',
        }),
      );
      expect(result.name).toBe('New');
      expect(result.status).toBe('ARCHIVED');
      const args = (mockUpdate.mock.calls[0] as unknown as [UpdateArgs])[0];
      expect(args.data).toEqual({
        name: 'New',
        description: 'd',
        status: 'ARCHIVED',
      }); // no tenantId key anywhere
      expect(args.where).toEqual({ id: 'svc-1' });
    });

    it('throws NotFound before any write for an unknown service', async () => {
      mockFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.updateService('nope', { name: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('maps a rename collision to 409', async () => {
      mockFindUnique.mockResolvedValue(serviceRow());
      mockUpdate.mockRejectedValue(p2002());
      await expect(
        runInTenant(() => service.updateService('svc-1', { name: 'Taken' })),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
