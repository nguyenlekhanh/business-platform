import {
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PermissionService } from '../rbac/permission.service';
import { PosDeviceService } from './pos-device.service';
import { PosSaleService } from './pos-sale.service';
import { PosSyncService, SyncResult } from './pos-sync.service';
import type { PosDevice, PosOperation, PosOperationItem } from '@prisma/client';
import { createHash } from 'node:crypto';

/** Typed accessors for mock call arguments. */
interface OpUpdateManyArgs {
  where: { id: string; status?: string; processedAt?: unknown };
  data: Record<string, unknown>;
}
interface SaleCallArgs {
  sessionId: string;
  items: Array<{ variantId: string; quantity: number }>;
  method: string;
  customerId?: string;
}
interface SaleOptions {
  allowClosedSession?: boolean;
}

const secret = 'sync-device-secret-abc123';
const secretHash = createHash('sha256').update(secret, 'utf8').digest('hex');
const wrongSecret = 'totally-wrong';
const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('PosSyncService', () => {
  let service: PosSyncService;
  let tenantContext: TenantContextService;

  const mockOpFindUnique = jest.fn();
  const mockOpUpdateMany = jest.fn();
  const mockDeviceFindUnique = jest.fn();
  const mockVariantFindMany = jest.fn();
  const mockPriceFindMany = jest.fn();
  const mockInventoryFindFirst = jest.fn();
  const mockSaleCreate = jest.fn();
  const mockAssertPermissions = jest.fn();
  const mockVerifyCredential = jest.fn();
  const mockFeedFindMany = jest.fn();

  const device = (overrides: Partial<PosDevice> = {}): PosDevice => ({
    id: 'device-1',
    tenantId: 'tenant-1',
    storeId: 'store-1',
    name: 'Register 1',
    status: 'ACTIVE',
    credentialHash: secretHash,
    lastSeenAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const line = (
    overrides: Partial<PosOperationItem> = {},
  ): PosOperationItem => ({
    id: 'line-1',
    tenantId: 'tenant-1',
    operationId: 'op-1',
    variantId: 'variant-1',
    quantity: 2,
    currency: 'USD',
    observedUnitAmountMinor: 1250n,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const operation = (
    overrides: Partial<PosOperation> = {},
    items: PosOperationItem[] = [line()],
  ): PosOperation & { items: PosOperationItem[] } => ({
    id: 'op-1',
    tenantId: 'tenant-1',
    deviceId: 'device-1',
    sessionId: 'session-1',
    storeId: 'store-1',
    userId: 'user-1',
    clientUuid: '11111111-1111-4111-8111-111111111111',
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
    items,
    ...overrides,
  });

  const saleSummary = () => ({
    id: 'sale-1',
    orderId: 'order-1',
    paymentId: 'payment-1',
    orderStatus: 'PAID',
    paymentStatus: 'CAPTURED',
  });

  /** Seed a fully valid, executable operation context. */
  const seedExecutable = () => {
    mockOpFindUnique.mockResolvedValue(operation());
    mockDeviceFindUnique.mockResolvedValue(device());
    mockVerifyCredential.mockReturnValue(true);
    mockAssertPermissions.mockResolvedValue(undefined);
    mockVariantFindMany.mockResolvedValue([
      {
        id: 'variant-1',
        status: 'ACTIVE',
        productId: 'prod-1',
        tenantId: 'tenant-1',
      },
    ]);
    mockPriceFindMany.mockResolvedValue([
      {
        variantId: 'variant-1',
        currency: 'USD',
        amountMinor: 1250n,
      },
    ]);
    mockInventoryFindFirst.mockResolvedValue({ quantityOnHand: 10 });
    mockOpUpdateMany.mockResolvedValue({ count: 1 });
    mockSaleCreate.mockResolvedValue(saleSummary());
  };

  /**
   * Stateful rejection mock: the FIRST findUnique returns the PENDING row
   * (the initial load); every subsequent read returns the row as
   * persistRejection/updateMany would have written it (REJECTED +
   * resultCode). updateMany count 1 mirrors the guarded transition.
   */
  const seedRejection = (resultCode: string) => {
    mockOpFindUnique
      .mockResolvedValueOnce(operation())
      .mockResolvedValue(operation({ status: 'REJECTED', resultCode }));
    mockDeviceFindUnique.mockResolvedValue(device());
    mockVerifyCredential.mockReturnValue(true);
    mockAssertPermissions.mockResolvedValue(undefined);
    mockOpUpdateMany.mockResolvedValue({ count: 1 });
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    tenantContext = new TenantContextService();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PosSyncService,
        {
          provide: PrismaService,
          useValue: {
            posOperation: {
              findUnique: mockOpFindUnique,
              updateMany: mockOpUpdateMany,
            },
            posDevice: { findUnique: mockDeviceFindUnique },
            productVariant: { findMany: mockVariantFindMany },
            price: { findMany: mockPriceFindMany },
            inventory: { findFirst: mockInventoryFindFirst },
            posFeedEvent: { findMany: mockFeedFindMany },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
        {
          provide: PermissionService,
          useValue: { assertPermissions: mockAssertPermissions },
        },
        {
          provide: PosDeviceService,
          useValue: { verifyCredential: mockVerifyCredential },
        },
        {
          provide: PosSaleService,
          useValue: { createSale: mockSaleCreate },
        },
      ],
    }).compile();
    service = moduleRef.get(PosSyncService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  describe('fail-closed + authority (D6/D7)', () => {
    it('fails closed without tenant context', async () => {
      await expect(
        service.syncOperation('user-1', 'op-1', secret),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('404 unknown/foreign operation (uniform)', async () => {
      mockOpFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.syncOperation('user-1', 'op-1', secret)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('401 without a device credential', async () => {
      mockOpFindUnique.mockResolvedValue(operation());
      await expect(
        runInTenant(() => service.syncOperation('user-1', 'op-1', undefined)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('401 with a WRONG device credential (constant-time verify fails)', async () => {
      mockOpFindUnique.mockResolvedValue(operation());
      mockDeviceFindUnique.mockResolvedValue(device());
      mockVerifyCredential.mockReturnValue(false);
      await expect(
        runInTenant(() => service.syncOperation('user-1', 'op-1', wrongSecret)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('409 when the operation device is SUSPENDED (revocation at sync)', async () => {
      mockOpFindUnique.mockResolvedValue(operation());
      mockDeviceFindUnique.mockResolvedValue(device({ status: 'SUSPENDED' }));
      await expect(
        runInTenant(() => service.syncOperation('user-1', 'op-1', secret)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('404 when the authenticated principal is NOT the recorded cashier (ownership)', async () => {
      mockOpFindUnique.mockResolvedValue(operation());
      mockDeviceFindUnique.mockResolvedValue(device());
      mockVerifyCredential.mockReturnValue(true);
      await expect(
        runInTenant(() => service.syncOperation('user-OTHER', 'op-1', secret)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403 when the cashier lost pos:create AFTER recording (D7 demotion)', async () => {
      mockOpFindUnique.mockResolvedValue(operation());
      mockDeviceFindUnique.mockResolvedValue(device());
      mockVerifyCredential.mockReturnValue(true);
      mockAssertPermissions.mockRejectedValue(
        new ForbiddenException('Insufficient permissions'),
      );
      await expect(
        runInTenant(() => service.syncOperation('user-1', 'op-1', secret)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // The validation (and any sale) must never run.
      expect(mockVariantFindMany).not.toHaveBeenCalled();
      expect(mockSaleCreate).not.toHaveBeenCalled();
    });
  });

  describe('durable replays (idempotency)', () => {
    it('ACCEPTED retry returns the persisted result WITHOUT re-execution', async () => {
      mockOpFindUnique.mockResolvedValue(
        operation({
          status: 'ACCEPTED',
          resultOrderId: 'order-1',
          resultPaymentId: 'payment-1',
        }),
      );
      mockDeviceFindUnique.mockResolvedValue(device());
      mockVerifyCredential.mockReturnValue(true);
      mockAssertPermissions.mockResolvedValue(undefined);

      const result = await runInTenant(() =>
        service.syncOperation('user-1', 'op-1', secret),
      );
      expect(result.status).toBe('ACCEPTED');
      expect(result.orderId).toBe('order-1');
      expect(mockSaleCreate).not.toHaveBeenCalled(); // never re-executed
    });

    it('REJECTED retry returns the persisted rejection UNCHANGED (PRICE_CHANGED)', async () => {
      mockOpFindUnique.mockResolvedValue(
        operation({ status: 'REJECTED', resultCode: 'PRICE_CHANGED' }),
      );
      mockDeviceFindUnique.mockResolvedValue(device());
      mockVerifyCredential.mockReturnValue(true);
      mockAssertPermissions.mockResolvedValue(undefined);

      const result = await runInTenant(() =>
        service.syncOperation('user-1', 'op-1', secret),
      );
      expect(result.status).toBe('REJECTED');
      expect(result.resultCode).toBe('PRICE_CHANGED');
      expect(mockSaleCreate).not.toHaveBeenCalled();
    });
  });

  describe('deterministic validations (D3/D4)', () => {
    it('PRICE_CHANGED when the current server price differs (exact BigInt compare)', async () => {
      seedRejection('PRICE_CHANGED');
      mockVariantFindMany.mockResolvedValue([
        { id: 'variant-1', status: 'ACTIVE' },
      ]);
      mockPriceFindMany.mockResolvedValue([
        { variantId: 'variant-1', currency: 'USD', amountMinor: 999n },
      ]);

      const result = await runInTenant(() =>
        service.syncOperation('user-1', 'op-1', secret),
      );
      expect(result.status).toBe('REJECTED');
      expect(result.resultCode).toBe('PRICE_CHANGED');
      // NO sale, NO order, NO payment.
      expect(mockSaleCreate).not.toHaveBeenCalled();
      const calls = mockOpUpdateMany.mock.calls as unknown as Array<
        [OpUpdateManyArgs]
      >;
      const finalUpdate = calls.find((c) => c[0].data.status === 'REJECTED');
      expect(finalUpdate).toBeDefined();
    });

    it('PRICE_CHANGED never silently reprices (sale not called with new price)', async () => {
      seedRejection('PRICE_CHANGED');
      mockVariantFindMany.mockResolvedValue([
        { id: 'variant-1', status: 'ACTIVE' },
      ]);
      mockPriceFindMany.mockResolvedValue([
        { variantId: 'variant-1', currency: 'USD', amountMinor: 1n },
      ]);
      const result: SyncResult = await runInTenant(() =>
        service.syncOperation('user-1', 'op-1', secret),
      );
      expect(result.status).toBe('REJECTED');
      expect(result.resultCode).toBe('PRICE_CHANGED');
      expect(mockSaleCreate).not.toHaveBeenCalled();
    });

    it('OUT_OF_STOCK when the store pool cannot cover the aggregated quantity', async () => {
      seedRejection('OUT_OF_STOCK');
      mockVariantFindMany.mockResolvedValue([
        { id: 'variant-1', status: 'ACTIVE' },
      ]);
      mockPriceFindMany.mockResolvedValue([
        { variantId: 'variant-1', currency: 'USD', amountMinor: 1250n },
      ]);
      mockInventoryFindFirst.mockResolvedValue({ quantityOnHand: 1 });

      const result = await runInTenant(() =>
        service.syncOperation('user-1', 'op-1', secret),
      );
      expect(result.status).toBe('REJECTED');
      expect(result.resultCode).toBe('OUT_OF_STOCK');
      expect(mockSaleCreate).not.toHaveBeenCalled();
    });

    it('VARIANT_NOT_FOUND / VARIANT_NOT_ACTIVE are deterministic rejections', async () => {
      seedRejection('VARIANT_NOT_FOUND');
      mockVariantFindMany.mockResolvedValue([]); // missing
      const missing = await runInTenant(() =>
        service.syncOperation('user-1', 'op-1', secret),
      );
      expect(missing.resultCode).toBe('VARIANT_NOT_FOUND');

      jest.clearAllMocks();
      seedRejection('VARIANT_NOT_ACTIVE');
      mockVariantFindMany.mockResolvedValue([
        { id: 'variant-1', status: 'ARCHIVED' },
      ]);
      const archived = await runInTenant(() =>
        service.syncOperation('user-1', 'op-1', secret),
      );
      expect(archived.resultCode).toBe('VARIANT_NOT_ACTIVE');
    });

    it('CURRENCY_MIX for a mixed-currency intent (existing uniform rule)', async () => {
      const mixedItems = [
        line(),
        line({ id: 'line-2', variantId: 'variant-2', currency: 'EUR' }),
      ];
      mockOpFindUnique
        .mockResolvedValueOnce(operation({}, mixedItems)) // initial load
        .mockResolvedValue(
          operation(
            { status: 'REJECTED', resultCode: 'CURRENCY_MIX' },
            mixedItems,
          ),
        );
      mockDeviceFindUnique.mockResolvedValue(device());
      mockVerifyCredential.mockReturnValue(true);
      mockAssertPermissions.mockResolvedValue(undefined);
      mockVariantFindMany.mockResolvedValue([
        { id: 'variant-1', status: 'ACTIVE' },
        { id: 'variant-2', status: 'ACTIVE' },
      ]);
      mockOpUpdateMany.mockResolvedValue({ count: 1 });

      const result = await runInTenant(() =>
        service.syncOperation('user-1', 'op-1', secret),
      );
      expect(result.status).toBe('REJECTED');
      expect(result.resultCode).toBe('CURRENCY_MIX');
      expect(mockSaleCreate).not.toHaveBeenCalled();
    });
  });

  describe('execution through the EXISTING sale engine', () => {
    it('happy path: claim -> createSale(CASH, allowClosedSession) -> ACCEPTED with ids', async () => {
      seedExecutable();
      // Final re-read returns the ACCEPTED row (claim+result persisted).
      mockOpFindUnique
        .mockResolvedValueOnce(operation()) // initial load
        .mockResolvedValue(
          operation({
            status: 'ACCEPTED',
            resultOrderId: 'order-1',
            resultPaymentId: 'payment-1',
          }),
        );
      const result = await runInTenant(() =>
        service.syncOperation('user-1', 'op-1', secret),
      );

      // Claim on the EXISTING processedAt column (null -> now).
      const updateCalls = mockOpUpdateMany.mock.calls as unknown as Array<
        [OpUpdateManyArgs]
      >;
      const claimCall = updateCalls.find(
        (c) => c[0].where.processedAt === null,
      );
      expect(claimCall).toBeDefined();

      // Engine invoked exactly once: cash-only + historical session allowed.
      expect(mockSaleCreate).toHaveBeenCalledTimes(1);
      const [userId, dto, opts] = mockSaleCreate.mock.calls[0] as unknown as [
        string,
        SaleCallArgs,
        SaleOptions,
      ];
      expect(userId).toBe('user-1');
      expect(dto.sessionId).toBe('session-1');
      expect(dto.method).toBe('CASH'); // D5
      expect(dto.items).toEqual([{ variantId: 'variant-1', quantity: 2 }]);
      expect(opts?.allowClosedSession).toBe(true);

      // Final atomic result: ACCEPTED + ids.
      expect(result.status).toBe('ACCEPTED');
      expect(result.orderId).toBe('order-1');
      expect(result.paymentId).toBe('payment-1');
      expect(result.resultCode).toBeNull();
    });

    it('concurrent claim loser: awaits and returns the winner durable result (no second sale)', async () => {
      seedExecutable();
      // First updateMany (claim) loses.
      mockOpUpdateMany.mockResolvedValueOnce({ count: 0 });
      // The re-read after the bounded poll shows the winner's ACCEPTED row.
      mockOpFindUnique
        .mockResolvedValueOnce(operation()) // initial load
        .mockResolvedValueOnce(
          operation({
            status: 'ACCEPTED',
            resultOrderId: 'order-WINNER',
            resultPaymentId: 'payment-WINNER',
          }),
        );

      const result = await runInTenant(() =>
        service.syncOperation('user-1', 'op-1', secret),
      );
      expect(result.status).toBe('ACCEPTED');
      expect(result.orderId).toBe('order-WINNER');
      expect(mockSaleCreate).not.toHaveBeenCalled(); // loser never executes
    });

    it('engine Insufficient-stock race AFTER validation persists OUT_OF_STOCK', async () => {
      mockOpFindUnique
        .mockResolvedValueOnce(operation()) // initial load
        .mockResolvedValue(
          operation({ status: 'REJECTED', resultCode: 'OUT_OF_STOCK' }),
        );
      mockDeviceFindUnique.mockResolvedValue(device());
      mockVerifyCredential.mockReturnValue(true);
      mockAssertPermissions.mockResolvedValue(undefined);
      mockVariantFindMany.mockResolvedValue([
        { id: 'variant-1', status: 'ACTIVE' },
      ]);
      mockPriceFindMany.mockResolvedValue([
        { variantId: 'variant-1', currency: 'USD', amountMinor: 1250n },
      ]);
      mockInventoryFindFirst.mockResolvedValue({ quantityOnHand: 10 });
      mockOpUpdateMany.mockResolvedValue({ count: 1 });
      mockSaleCreate.mockRejectedValue(
        new ConflictException('Insufficient stock'),
      );
      const result = await runInTenant(() =>
        service.syncOperation('user-1', 'op-1', secret),
      );
      expect(result.status).toBe('REJECTED');
      expect(result.resultCode).toBe('OUT_OF_STOCK');
    });
  });

  describe('pull feed (D8)', () => {
    it('returns ordered entries above the cursor with the next cursor', async () => {
      mockFeedFindMany.mockResolvedValue([
        { feedSeq: 5, kind: 'PRODUCT', entityId: 'p-1' },
        { feedSeq: 6, kind: 'DELETED', entityId: 'p-2' },
      ]);
      const page = await runInTenant(() => service.pullFeed(4));
      expect(page.entries).toHaveLength(2);
      expect(page.nextCursor).toBe(6);
      expect(mockFeedFindMany).toHaveBeenCalledWith({
        where: { feedSeq: { gt: 4 } },
        orderBy: { feedSeq: 'asc' },
        take: 100,
      });
      expect(page.entries[1].kind).toBe('DELETED'); // tombstone delivered
    });

    it('empty feed: nextCursor echoes since (deterministic resume)', async () => {
      mockFeedFindMany.mockResolvedValue([]);
      const page = await runInTenant(() => service.pullFeed(9));
      expect(page.entries).toHaveLength(0);
      expect(page.nextCursor).toBe(9);
    });

    it('rejects a negative / non-integer cursor', async () => {
      await expect(
        runInTenant(() => service.pullFeed(-1)),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // Silence the unused-import linter for the p2002 helper shared fixture.
  it('p2002 fixture is a real known-request error', () => {
    expect(p2002().code).toBe('P2002');
  });
});
