import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PosDeviceService } from './pos-device.service';
import type { PosDevice, Store } from '@prisma/client';

/** Real known-request error so the isP2002 type-guard accepts the mock. */
const p2002Error = () =>
  new Prisma.PrismaClientKnownRequestError('unique constraint violated', {
    code: 'P2002',
    clientVersion: '6.19.3',
  });

/** Typed accessor for create() call arguments. */
interface CreateArgs {
  data: {
    tenantId: string;
    storeId: string;
    name: string;
    status: string;
    credentialHash: string;
  };
}
/** Typed accessor for updateMany() call arguments. */
interface UpdateManyArgs {
  where: { id: string; status: string | { in: string[] } };
  data: { status?: string; credentialHash?: string };
}
/** Typed accessor for findMany() call arguments. */
interface FindManyArgs {
  where: { AND: Array<Record<string, unknown>> };
  orderBy: Array<Record<string, string>>;
  take: number;
}

describe('PosDeviceService', () => {
  let service: PosDeviceService;
  let tenantContext: TenantContextService;

  const mockStoreFindUnique = jest.fn();
  const mockDeviceCreate = jest.fn();
  const mockDeviceFindUnique = jest.fn();
  const mockDeviceFindMany = jest.fn();
  const mockDeviceUpdate = jest.fn();
  const mockDeviceUpdateMany = jest.fn();

  const store = (overrides: Partial<Store> = {}): Store => ({
    id: 'store-1',
    tenantId: 'tenant-1',
    name: 'Main Street',
    code: 'MAIN',
    type: 'POS',
    status: 'ACTIVE',
    settings: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const device = (overrides: Partial<PosDevice> = {}): PosDevice => ({
    id: 'device-1',
    tenantId: 'tenant-1',
    storeId: 'store-1',
    name: 'Register 1',
    status: 'ACTIVE',
    credentialHash: 'a'.repeat(64),
    lastSeenAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    tenantContext = new TenantContextService();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PosDeviceService,
        {
          provide: PrismaService,
          useValue: {
            store: { findUnique: mockStoreFindUnique },
            posDevice: {
              create: mockDeviceCreate,
              findUnique: mockDeviceFindUnique,
              findMany: mockDeviceFindMany,
              update: mockDeviceUpdate,
              updateMany: mockDeviceUpdateMany,
            },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();
    service = moduleRef.get(PosDeviceService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  describe('fail-closed', () => {
    it('registerDevice fails closed without tenant', async () => {
      await expect(
        service.registerDevice({ storeId: 'store-1', name: 'R1' }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('getDevice fails closed without tenant', async () => {
      await expect(service.getDevice('device-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('registerDevice', () => {
    it('creates an ACTIVE device and returns the credential exactly once', async () => {
      mockStoreFindUnique.mockResolvedValue(store());
      mockDeviceCreate.mockImplementation((args: CreateArgs) =>
        Promise.resolve(device({ credentialHash: args.data.credentialHash })),
      );

      const result = await runInTenant(() =>
        service.registerDevice({ storeId: 'store-1', name: 'Register 1' }),
      );

      const reg = result;
      expect(reg.status).toBe('ACTIVE');
      expect(typeof reg.credential).toBe('string');
      expect(reg.credential.length).toBeGreaterThan(20);

      // Hash-only persistence: the created row's hash equals sha256(secret)
      // and NEVER the plaintext.
      const createdData = (
        mockDeviceCreate.mock.calls[0] as unknown as [CreateArgs]
      )[0].data;
      expect(createdData.credentialHash).toBe(
        createHash('sha256').update(reg.credential, 'utf8').digest('hex'),
      );
      expect(createdData.credentialHash).not.toBe(reg.credential);
      // The registration summary carries no credentialHash field.
      expect(
        (reg as unknown as Record<string, unknown>).credentialHash,
      ).toBeUndefined();

      // Two registrations issue distinct credentials.
      const second = await runInTenant(() =>
        service.registerDevice({ storeId: 'store-1', name: 'Register 2' }),
      );
      expect(second.credential).not.toBe(reg.credential);
    });

    it('throws NotFound for unknown store', async () => {
      mockStoreFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() =>
          service.registerDevice({ storeId: 'nope', name: 'R1' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps duplicate device name to 409', async () => {
      mockStoreFindUnique.mockResolvedValue(store());
      mockDeviceCreate.mockRejectedValue(p2002Error());
      await expect(
        runInTenant(() =>
          service.registerDevice({ storeId: 'store-1', name: 'Register 1' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('getDevice', () => {
    it('returns a summary without credential material', async () => {
      mockDeviceFindUnique.mockResolvedValue(device());
      const summary = await runInTenant(() => service.getDevice('device-1'));
      const keys = Object.keys(summary);
      expect(keys).not.toContain('credentialHash');
      expect(keys).not.toContain('credential');
      expect(summary.status).toBe('ACTIVE');
    });

    it('throws NotFound for unknown device', async () => {
      mockDeviceFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.getDevice('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('lifecycle transitions (A6)', () => {
    it('suspends an ACTIVE device', async () => {
      mockDeviceFindUnique
        .mockResolvedValueOnce(device({ status: 'ACTIVE' }))
        .mockResolvedValueOnce(device({ status: 'SUSPENDED' }));
      mockDeviceUpdateMany.mockResolvedValue({ count: 1 });
      const result = await runInTenant(() =>
        service.transition('device-1', 'suspend'),
      );
      expect(result.status).toBe('SUSPENDED');
      const args = (
        mockDeviceUpdateMany.mock.calls[0] as unknown as [UpdateManyArgs]
      )[0];
      expect(args.where).toEqual({ id: 'device-1', status: 'ACTIVE' });
      expect(args.data).toEqual({ status: 'SUSPENDED' });
    });

    it('resumes a SUSPENDED device', async () => {
      mockDeviceFindUnique
        .mockResolvedValueOnce(device({ status: 'SUSPENDED' }))
        .mockResolvedValueOnce(device({ status: 'ACTIVE' }));
      mockDeviceUpdateMany.mockResolvedValue({ count: 1 });
      const result = await runInTenant(() =>
        service.transition('device-1', 'resume'),
      );
      expect(result.status).toBe('ACTIVE');
      const args = (
        mockDeviceUpdateMany.mock.calls[0] as unknown as [UpdateManyArgs]
      )[0];
      expect(args.where).toEqual({ id: 'device-1', status: 'SUSPENDED' });
      expect(args.data).toEqual({ status: 'ACTIVE' });
    });

    it('retire: guarded update from ACTIVE|SUSPENDED; terminal after', async () => {
      // Pre-check lookup sees a LIVE device; the post-update lookup sees
      // the retired row the guarded updateMany just wrote.
      mockDeviceFindUnique
        .mockResolvedValueOnce(device({ status: 'ACTIVE' }))
        .mockResolvedValueOnce(device({ status: 'RETIRED' }));
      mockDeviceUpdateMany.mockResolvedValue({ count: 1 });
      const result = await runInTenant(() =>
        service.transition('device-1', 'retire'),
      );
      expect(result.status).toBe('RETIRED');
      const args = (
        mockDeviceUpdateMany.mock.calls[0] as unknown as [UpdateManyArgs]
      )[0];
      expect(args.where).toEqual({
        id: 'device-1',
        status: { in: ['ACTIVE', 'SUSPENDED'] },
      });
      expect(args.data).toEqual({ status: 'RETIRED' });
    });

    it('retire on an already-retired device -> 409, no write', async () => {
      mockDeviceFindUnique.mockResolvedValue(device({ status: 'RETIRED' }));
      await expect(
        runInTenant(() => service.transition('device-1', 'retire')),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockDeviceUpdateMany).not.toHaveBeenCalled();
    });

    it('suspend/resume on a retired device -> 409 (terminal checked first)', async () => {
      mockDeviceFindUnique.mockResolvedValue(device({ status: 'RETIRED' }));
      await expect(
        runInTenant(() => service.transition('device-1', 'suspend')),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        runInTenant(() => service.transition('device-1', 'resume')),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockDeviceUpdateMany).not.toHaveBeenCalled();
    });

    it('suspend on a SUSPENDED (non-retired) device -> 409', async () => {
      mockDeviceUpdateMany.mockResolvedValue({ count: 0 });
      mockDeviceFindUnique.mockResolvedValue(device({ status: 'SUSPENDED' }));
      await expect(
        runInTenant(() => service.transition('device-1', 'suspend')),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('resume on an ACTIVE (non-retired) device -> 409', async () => {
      mockDeviceUpdateMany.mockResolvedValue({ count: 0 });
      mockDeviceFindUnique.mockResolvedValue(device({ status: 'ACTIVE' }));
      await expect(
        runInTenant(() => service.transition('device-1', 'resume')),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('suspend/resume on unknown device -> 404', async () => {
      mockDeviceFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.transition('nope', 'suspend')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('rotateCredential', () => {
    it('replaces the hash and returns the new secret once', async () => {
      const oldHash = 'b'.repeat(64);
      mockDeviceFindUnique
        .mockResolvedValueOnce(device({ credentialHash: oldHash }))
        .mockResolvedValueOnce(device({ credentialHash: 'c'.repeat(64) }));
      mockDeviceUpdateMany.mockResolvedValue({ count: 1 });

      const result = await runInTenant(() =>
        service.rotateCredential('device-1'),
      );

      expect(result.credential).toBeDefined();
      const args = (
        mockDeviceUpdateMany.mock.calls[0] as unknown as [UpdateManyArgs]
      )[0];
      expect(args.data.credentialHash).not.toBe(oldHash);
      expect(args.data.credentialHash).toBe(
        createHash('sha256').update(result.credential, 'utf8').digest('hex'),
      );
      expect(args.where.status).toEqual({ in: ['ACTIVE', 'SUSPENDED'] });
    });

    it('forbidden for retired devices -> 409, no write', async () => {
      mockDeviceFindUnique.mockResolvedValue(device({ status: 'RETIRED' }));
      await expect(
        runInTenant(() => service.rotateCredential('device-1')),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockDeviceUpdateMany).not.toHaveBeenCalled();
    });

    it('concurrent retire racing rotation loses -> 409', async () => {
      mockDeviceFindUnique
        .mockResolvedValueOnce(device({ status: 'ACTIVE' }))
        .mockResolvedValueOnce(device({ status: 'RETIRED' }));
      mockDeviceUpdateMany.mockResolvedValue({ count: 0 });
      await expect(
        runInTenant(() => service.rotateCredential('device-1')),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('verifyCredential (A2: constant-time, P4-U5 consumer)', () => {
    it('accepts the matching secret and rejects everything else', () => {
      const secret = 'abcdef123456';
      const hash = createHash('sha256').update(secret, 'utf8').digest('hex');
      const dev = device({ credentialHash: hash });
      expect(service.verifyCredential(dev, secret)).toBe(true);
      expect(service.verifyCredential(dev, 'wrong')).toBe(false);
      expect(service.verifyCredential(dev, '')).toBe(false);
    });
  });

  describe('listDevices', () => {
    it('composes status filter + keyset via the shared helpers', async () => {
      mockDeviceFindMany.mockResolvedValue([device()]);
      const page = await runInTenant(() =>
        service.listDevices({ status: 'ACTIVE' } as never),
      );
      expect(page.data).toHaveLength(1);
      const args = (
        mockDeviceFindMany.mock.calls[0] as unknown as [FindManyArgs]
      )[0];
      expect(args.where.AND[0]).toEqual({ status: 'ACTIVE' });
      expect(args.take).toBe(21); // DEFAULT_PAGE_SIZE + 1 probe row
      expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    });
  });
});
