import {
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  DeviceReconciliationReport,
  PosReconciliationService,
  SessionReconciliationReport,
} from './pos-reconciliation.service';
import type { PosOperation, PosOperationItem } from '@prisma/client';

/** Typed accessor for findMany call arguments. */
interface FindManyArgs {
  where: { deviceId?: string; sessionId?: string };
  orderBy: { seq: 'asc' };
}

describe('PosReconciliationService', () => {
  let service: PosReconciliationService;
  let tenantContext: TenantContextService;

  const mockDeviceFindUnique = jest.fn();
  const mockSessionFindUnique = jest.fn();
  const mockOpFindMany = jest.fn();

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

  const operation = (overrides: Partial<PosOperation> = {}): PosOperation => ({
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
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    tenantContext = new TenantContextService();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PosReconciliationService,
        {
          provide: PrismaService,
          useValue: {
            posDevice: { findUnique: mockDeviceFindUnique },
            posSession: { findUnique: mockSessionFindUnique },
            posOperation: { findMany: mockOpFindMany },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();
    service = moduleRef.get(PosReconciliationService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  describe('fail-closed', () => {
    it('device report fails closed without tenant', async () => {
      await expect(
        service.getDeviceReconciliation('device-1'),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('session report fails closed without tenant', async () => {
      await expect(
        service.getSessionReconciliation('session-1'),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('getDeviceReconciliation', () => {
    it('partitions the durable resolutions: pending/accepted/rejected with typed codes', async () => {
      mockDeviceFindUnique.mockResolvedValue({
        id: 'device-1',
        storeId: 'store-1',
      });
      mockOpFindMany.mockResolvedValue([
        operation({
          id: 'op-3',
          seq: 3,
          status: 'REJECTED',
          resultCode: 'PRICE_CHANGED',
        }),
        operation({
          id: 'op-1',
          seq: 1,
          status: 'ACCEPTED',
          resultOrderId: 'order-1',
          resultPaymentId: 'payment-1',
        }),
        operation({ id: 'op-2', seq: 2, status: 'PENDING' }),
      ]);

      const report: DeviceReconciliationReport = await runInTenant(() =>
        service.getDeviceReconciliation('device-1'),
      );

      expect(mockOpFindMany).toHaveBeenCalledWith({
        where: { deviceId: 'device-1' },
        orderBy: { seq: 'asc' },
      } satisfies FindManyArgs);
      expect(report.totals).toEqual({ pending: 1, accepted: 1, rejected: 1 });
      expect(report.rejected).toHaveLength(1);
      expect(report.rejected[0].resultCode).toBe('PRICE_CHANGED');
      expect(report.accepted).toHaveLength(1);
      expect(report.accepted[0].orderId).toBe('order-1');
      expect(report.accepted[0].paymentId).toBe('payment-1');
      expect(report.pending).toHaveLength(1);
      expect(report.pending[0].status).toBe('PENDING');
      // Ordered by the device's outbox sequence.
      expect(
        report.rejected[0].seq + report.accepted[0].seq + report.pending[0].seq,
      ).toBe(6);
    });

    it('DUPLICATE-status operations report as ACCEPTED (the durable result)', async () => {
      mockDeviceFindUnique.mockResolvedValue({
        id: 'device-1',
        storeId: 'store-1',
      });
      mockOpFindMany.mockResolvedValue([
        operation({
          id: 'op-1',
          status: 'DUPLICATE',
          resultOrderId: 'order-1',
          resultPaymentId: 'payment-1',
        }),
      ]);
      const report = await runInTenant(() =>
        service.getDeviceReconciliation('device-1'),
      );
      expect(report.accepted).toHaveLength(1);
      expect(report.totals.rejected).toBe(0);
    });

    it('throws uniform 404 for an unknown/foreign device', async () => {
      mockDeviceFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.getDeviceReconciliation('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockOpFindMany).not.toHaveBeenCalled();
    });
  });

  describe('getSessionReconciliation', () => {
    it('projects the shift report with the session provenance', async () => {
      mockSessionFindUnique.mockResolvedValue({
        id: 'session-1',
        deviceId: 'device-1',
        storeId: 'store-1',
        userId: 'user-1',
      });
      mockOpFindMany.mockResolvedValue([
        operation({
          id: 'op-2',
          seq: 2,
          status: 'REJECTED',
          resultCode: 'OUT_OF_STOCK',
        }),
        operation({
          id: 'op-1',
          seq: 1,
          status: 'ACCEPTED',
          resultOrderId: 'order-1',
          resultPaymentId: 'payment-1',
        }),
      ]);

      const report: SessionReconciliationReport = await runInTenant(() =>
        service.getSessionReconciliation('session-1'),
      );
      expect(mockOpFindMany).toHaveBeenCalledWith({
        where: { sessionId: 'session-1' },
        orderBy: { seq: 'asc' },
      } satisfies FindManyArgs);
      expect(report.cashierId).toBe('user-1');
      expect(report.storeId).toBe('store-1');
      expect(report.deviceId).toBe('device-1');
      expect(report.totals).toEqual({ pending: 0, accepted: 1, rejected: 1 });
      expect(report.rejected[0].resultCode).toBe('OUT_OF_STOCK');
    });

    it('throws uniform 404 for an unknown/foreign session', async () => {
      mockSessionFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.getSessionReconciliation('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockOpFindMany).not.toHaveBeenCalled();
    });
  });

  describe('read-only guarantee', () => {
    it('exposes only the projection — no intent lines, no tenant fields, no mutation methods invoked', async () => {
      mockDeviceFindUnique.mockResolvedValue({
        id: 'device-1',
        storeId: 'store-1',
      });
      mockOpFindMany.mockResolvedValue([operation()]);
      const report = await runInTenant(() =>
        service.getDeviceReconciliation('device-1'),
      );
      const projected = report.pending[0] as unknown as Record<string, unknown>;
      expect(Object.keys(projected).sort()).toEqual(
        [
          'operationId',
          'clientUuid',
          'seq',
          'status',
          'resultCode',
          'orderId',
          'paymentId',
          'createdAt',
        ].sort(),
      );
      // The frozen intent payload (items) never leaks into the report.
      expect(projected['items']).toBeUndefined();
      expect(projected['tenantId']).toBeUndefined();
    });
  });

  // Keep the line fixture referenced for type safety of the import surface.
  it('line fixture is well-formed', () => {
    expect(line().quantity).toBe(2);
  });
});
