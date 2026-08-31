import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PosSessionService } from './pos-session.service';
import type { PosDevice, PosSession } from '@prisma/client';

const p2002Error = () =>
  new Prisma.PrismaClientKnownRequestError('unique constraint violated', {
    code: 'P2002',
    clientVersion: '6.19.3',
  });

/** Typed accessor for create() call arguments. */
interface CreateArgs {
  data: {
    tenantId: string;
    deviceId: string;
    storeId: string;
    userId: string;
    status: string;
    openedAt: Date;
  };
}
/** Typed accessor for updateMany() call arguments. */
interface UpdateManyArgs {
  where: { id: string; status: string };
  data: { status: string; closedAt: Date };
}

describe('PosSessionService', () => {
  let service: PosSessionService;
  let tenantContext: TenantContextService;

  const mockDeviceFindUnique = jest.fn();
  const mockSessionCreate = jest.fn();
  const mockSessionFindUnique = jest.fn();
  const mockSessionUpdateMany = jest.fn();

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

  const session = (overrides: Partial<PosSession> = {}): PosSession => ({
    id: 'session-1',
    tenantId: 'tenant-1',
    deviceId: 'device-1',
    storeId: 'store-1',
    userId: 'user-1',
    status: 'OPEN',
    openedAt: new Date('2026-01-01T00:00:00.000Z'),
    closedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    tenantContext = new TenantContextService();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PosSessionService,
        {
          provide: PrismaService,
          useValue: {
            posDevice: { findUnique: mockDeviceFindUnique },
            posSession: {
              create: mockSessionCreate,
              findUnique: mockSessionFindUnique,
              updateMany: mockSessionUpdateMany,
            },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();
    service = moduleRef.get(PosSessionService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  describe('fail-closed', () => {
    it('openSession fails closed without tenant', async () => {
      await expect(
        service.openSession('user-1', { deviceId: 'device-1' }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('openSession', () => {
    it('derives store from the device, never from the client', async () => {
      mockDeviceFindUnique.mockResolvedValue(device());
      mockSessionCreate.mockImplementation((args: CreateArgs) =>
        Promise.resolve(session({ storeId: args.data.storeId })),
      );

      const result = await runInTenant(() =>
        service.openSession('user-1', { deviceId: 'device-1' }),
      );

      expect(result.storeId).toBe('store-1'); // the DEVICE's store
      const createData = (
        mockSessionCreate.mock.calls[0] as unknown as [CreateArgs]
      )[0].data;
      expect(createData.storeId).toBe('store-1');
      expect(createData.userId).toBe('user-1');
      expect(createData.status).toBe('OPEN');
      expect(createData.tenantId).toBe('tenant-1');
      expect(createData.deviceId).toBe('device-1');
    });

    it('throws NotFound for unknown device', async () => {
      mockDeviceFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.openSession('user-1', { deviceId: 'nope' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws Conflict for a SUSPENDED device', async () => {
      mockDeviceFindUnique.mockResolvedValue(device({ status: 'SUSPENDED' }));
      await expect(
        runInTenant(() =>
          service.openSession('user-1', { deviceId: 'device-1' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws Conflict for a RETIRED device', async () => {
      mockDeviceFindUnique.mockResolvedValue(device({ status: 'RETIRED' }));
      await expect(
        runInTenant(() =>
          service.openSession('user-1', { deviceId: 'device-1' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps the one-open-per-device race (P2002) to 409', async () => {
      mockDeviceFindUnique.mockResolvedValue(device());
      mockSessionCreate.mockRejectedValue(p2002Error());
      await expect(
        runInTenant(() =>
          service.openSession('user-1', { deviceId: 'device-1' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('getSession', () => {
    it('returns the session summary', async () => {
      mockSessionFindUnique.mockResolvedValue(session());
      const result = await runInTenant(() => service.getSession('session-1'));
      expect(result.status).toBe('OPEN');
      expect(result.closedAt).toBeNull();
    });

    it('throws NotFound for unknown session', async () => {
      mockSessionFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.getSession('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('closeSession', () => {
    it('closes an OPEN session with a guarded update', async () => {
      mockSessionUpdateMany.mockResolvedValue({ count: 1 });
      mockSessionFindUnique.mockResolvedValue(
        session({ status: 'CLOSED', closedAt: new Date() }),
      );

      const result = await runInTenant(() => service.closeSession('session-1'));

      expect(result.status).toBe('CLOSED');
      expect(result.closedAt).not.toBeNull();
      const args = (
        mockSessionUpdateMany.mock.calls[0] as unknown as [UpdateManyArgs]
      )[0];
      expect(args.where).toEqual({ id: 'session-1', status: 'OPEN' });
      expect(args.data.status).toBe('CLOSED');
      expect(args.data.closedAt).toBeInstanceOf(Date);
    });

    it('already-closed session -> 409 (never idempotent-close)', async () => {
      mockSessionUpdateMany.mockResolvedValue({ count: 0 });
      mockSessionFindUnique.mockResolvedValue(
        session({ status: 'CLOSED', closedAt: new Date() }),
      );
      await expect(
        runInTenant(() => service.closeSession('session-1')),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('unknown session -> 404', async () => {
      mockSessionUpdateMany.mockResolvedValue({ count: 0 });
      mockSessionFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.closeSession('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
