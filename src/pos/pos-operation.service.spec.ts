import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  OfflineOperationSummary,
  PosOperationService,
} from './pos-operation.service';
import type { PosDevice, PosOperation, PosSession } from '@prisma/client';

/** Typed accessor for posOperation.create() call arguments. */
interface CreateArgs {
  data: {
    tenantId: string;
    deviceId: string;
    sessionId: string;
    storeId: string;
    userId: string;
    clientUuid: string;
    seq: number;
    type: string;
    status: string;
    customerId?: string;
  };
}
/** Typed accessor for posOperationItem.create() call arguments. */
interface ItemCreateArgs {
  data: {
    tenantId: string;
    operationId: string;
    variantId: string;
    quantity: number;
    currency: string;
    observedUnitAmountMinor: bigint;
  };
}

/** Real known-request error so the isP2002 type-guard accepts the mock. */
const p2002Error = (target: string[]) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });

describe('PosOperationService', () => {
  let service: PosOperationService;
  let tenantContext: TenantContextService;

  const mockSessionFindUnique = jest.fn();
  const mockDeviceFindUnique = jest.fn();
  const mockOpCreate = jest.fn();
  const mockOpFindUnique = jest.fn();
  const mockOpFindFirst = jest.fn();
  const mockOpFindMany = jest.fn();
  const mockItemCreate = jest.fn();
  const mockTransaction = jest.fn();

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

  const operation = (
    overrides: Partial<PosOperation> = {},
  ): PosOperation & {
    items: Array<{
      id: string;
      tenantId: string;
      operationId: string;
      variantId: string;
      quantity: number;
      currency: string;
      observedUnitAmountMinor: bigint;
      createdAt: Date;
      updatedAt: Date;
    }>;
  } => ({
    id: 'op-1',
    tenantId: 'tenant-1',
    deviceId: 'device-1',
    sessionId: 'session-1',
    storeId: 'store-1',
    userId: 'user-1',
    clientUuid: '11111111-111-4111-8111-111111111111',
    seq: 1,
    type: 'SALE_INTENT',
    status: 'PENDING',
    resultCode: null,
    resultOrderId: null,
    resultPaymentId: null,
    customerId: null,
    processedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    items: [
      {
        id: 'item-1',
        tenantId: 'tenant-1',
        operationId: 'op-1',
        variantId: 'variant-1',
        quantity: 2,
        currency: 'USD',
        observedUnitAmountMinor: 1250n,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    ...overrides,
  });

  const intentDto = {
    sessionId: 'session-1',
    clientUuid: '11111111-111-4111-8111-111111111111',
    seq: 1,
    items: [
      {
        variantId: 'variant-1',
        quantity: 2,
        currency: 'USD',
        observedUnitAmountMinor: 1250,
      },
    ],
  };

  /** tx client shape used inside $transaction. */
  const mkTx = () => ({
    posOperation: {
      create: mockOpCreate,
      findUniqueOrThrow: jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { id: string } }): Promise<unknown> =>
            mockOpFindUnique({ where }),
        ),
      findUnique: mockOpFindUnique,
      findFirst: mockOpFindFirst,
      findMany: mockOpFindMany,
    },
    posOperationItem: { create: mockItemCreate },
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    tenantContext = new TenantContextService();
    mockTransaction.mockImplementation(
      async (cb: (tx: ReturnType<typeof mkTx>) => Promise<unknown>) =>
        cb(mkTx()),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        PosOperationService,
        {
          provide: PrismaService,
          useValue: {
            posSession: { findUnique: mockSessionFindUnique },
            posDevice: { findUnique: mockDeviceFindUnique },
            posOperation: {
              findUnique: mockOpFindUnique,
              findFirst: mockOpFindFirst,
              findMany: mockOpFindMany,
            },
            $transaction: mockTransaction,
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();
    service = moduleRef.get(PosOperationService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  describe('fail-closed', () => {
    it('recordOfflineSaleIntent fails closed without tenant', async () => {
      await expect(
        service.recordOfflineSaleIntent('user-1', intentDto),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('recordOfflineSaleIntent — provenance', () => {
    it('derives device/store/cashier from the session and freezes the lines', async () => {
      mockSessionFindUnique.mockResolvedValue(session());
      mockOpCreate.mockResolvedValue(operation());
      mockOpFindUnique.mockResolvedValue(operation());

      const result = await runInTenant(() =>
        service.recordOfflineSaleIntent('user-1', intentDto),
      );

      const args = (mockOpCreate.mock.calls[0] as unknown as [CreateArgs])[0];
      expect(args.data).toEqual({
        tenantId: 'tenant-1', // server-derived
        deviceId: 'device-1', // from session
        sessionId: 'session-1', // retained even after close
        storeId: 'store-1', // from session
        userId: 'user-1', // cashier = session opener
        clientUuid: intentDto.clientUuid,
        seq: 1,
        type: 'SALE_INTENT',
        status: 'PENDING', // sync-inbox state ONLY
      });
      const itemArgs = (
        mockItemCreate.mock.calls[0] as unknown as [ItemCreateArgs]
      )[0];
      expect(itemArgs.data).toEqual({
        tenantId: 'tenant-1',
        operationId: 'op-1',
        variantId: 'variant-1',
        quantity: 2,
        currency: 'USD',
        observedUnitAmountMinor: 1250n, // exact BIGINT, never a float
      });
      expect(result.status).toBe('PENDING');
      expect(result.items[0].observedUnitAmountMinor).toBe('1250'); // string in JSON
    });

    it('throws NotFound for an unknown/foreign session (uniform 404)', async () => {
      mockSessionFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.recordOfflineSaleIntent('user-1', intentDto)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a non-opener cashier (uniform 404, no row written)', async () => {
      mockSessionFindUnique.mockResolvedValue(session());
      await expect(
        runInTenant(() =>
          service.recordOfflineSaleIntent('user-OTHER', intentDto),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockOpCreate).not.toHaveBeenCalled();
    });

    it('accepts a CLOSED session (historical outbox; U5 decides)', async () => {
      mockSessionFindUnique.mockResolvedValue(
        session({ status: 'CLOSED', closedAt: new Date() }),
      );
      mockOpCreate.mockResolvedValue(operation());
      mockOpFindUnique.mockResolvedValue(operation());
      const result = await runInTenant(() =>
        service.recordOfflineSaleIntent('user-1', intentDto),
      );
      expect(result.status).toBe('PENDING');
    });

    it('forwards the optional customerId; walk-in default has none', async () => {
      mockSessionFindUnique.mockResolvedValue(session());
      mockOpCreate.mockResolvedValue(operation());
      mockOpFindUnique.mockResolvedValue(operation());
      await runInTenant(() =>
        service.recordOfflineSaleIntent('user-1', {
          ...intentDto,
          customerId: 'cust-9',
        }),
      );
      const args = (mockOpCreate.mock.calls[0] as unknown as [CreateArgs])[0];
      expect(args.data.customerId).toBe('cust-9');
    });
  });

  describe('idempotency (deviceId, clientUuid)', () => {
    it('duplicate push returns the ORIGINAL durable row (no second row)', async () => {
      mockSessionFindUnique.mockResolvedValue(session());
      mockOpCreate.mockRejectedValue(p2002Error(['deviceId', 'clientUuid']));
      mockOpFindFirst.mockResolvedValue(operation());

      const result = await runInTenant(() =>
        service.recordOfflineSaleIntent('user-1', intentDto),
      );
      expect(result.id).toBe('op-1');
      expect(mockOpFindFirst).toHaveBeenCalledWith({
        where: { deviceId: 'device-1', clientUuid: intentDto.clientUuid },
        include: { items: true },
      });
    });

    it('duplicate with a lost original row surfaces as a 409 (never invents)', async () => {
      mockSessionFindUnique.mockResolvedValue(session());
      mockOpCreate.mockRejectedValue(p2002Error(['deviceId', 'clientUuid']));
      mockOpFindFirst.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.recordOfflineSaleIntent('user-1', intentDto)),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('sequence uniqueness (deviceId, seq)', () => {
    it('a DIFFERENT operation claiming the same seq is a deterministic 409', async () => {
      mockSessionFindUnique.mockResolvedValue(session());
      mockOpCreate.mockRejectedValue(p2002Error(['deviceId', 'seq']));
      await expect(
        runInTenant(() => service.recordOfflineSaleIntent('user-1', intentDto)),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(
        (await runInTenant(() =>
          service.recordOfflineSaleIntent('user-1', intentDto),
        ).catch((e: unknown) => e)) as ConflictException,
      ).toBeInstanceOf(ConflictException);
    });
  });

  describe('getOperation / listDeviceOperations', () => {
    it('projects an operation with string BigInt lines', async () => {
      mockOpFindUnique.mockResolvedValue(operation());
      const result: OfflineOperationSummary = await runInTenant(() =>
        service.getOperation('op-1'),
      );
      expect(result.clientUuid).toBe(intentDto.clientUuid);
      expect(result.status).toBe('PENDING');
    });

    it('unknown operation -> 404', async () => {
      mockOpFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.getOperation('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("lists a device's operations ordered by ITS seq (device isolation)", async () => {
      mockDeviceFindUnique.mockResolvedValue(device());
      mockOpFindMany.mockResolvedValue([
        operation({ seq: 2 }),
        operation({
          seq: 1,
          clientUuid: '22222222-222-4222-8222-222222222222',
        }),
      ]);
      const ops = await runInTenant(() =>
        service.listDeviceOperations('device-1'),
      );
      expect(mockOpFindMany).toHaveBeenCalledWith({
        where: { deviceId: 'device-1' },
        orderBy: { seq: 'asc' },
        include: { items: true },
      });
      expect(ops).toHaveLength(2);
    });

    it("unknown device's list -> uniform 404", async () => {
      mockDeviceFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.listDeviceOperations('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
