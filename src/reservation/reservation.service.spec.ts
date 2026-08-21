import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  decodeCursor,
  encodeCursor,
  filterFingerprint,
} from '../common/pagination/cursor';
import { ReservationService, ReservationSummary } from './reservation.service';
import type {
  CreateReservationDto,
  ReservationListQueryDto,
} from './dto/reservation.dto';

describe('ReservationService', () => {
  let service: ReservationService;
  let tenantContext: TenantContextService;

  const mockFindMany = jest.fn();
  const mockFindUnique = jest.fn();
  const mockFindFirst = jest.fn();
  const mockCreate = jest.fn();
  const mockUpdate = jest.fn();
  const mockCustomerFindUnique = jest.fn();
  const mockEquipmentFindUnique = jest.fn();

  const START = '2026-06-01T10:00:00.000Z';
  const END = '2026-06-01T14:00:00.000Z';

  const reservation = (
    overrides: Partial<ReservationSummary> = {},
  ): ReservationSummary => ({
    id: 'resv-1',
    tenantId: 'tenant-1',
    customerId: 'cust-1',
    equipmentId: 'equip-1',
    startAt: new Date(START),
    endAt: new Date(END),
    status: 'RESERVED',
    notes: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const createDto = (
    overrides: Partial<CreateReservationDto> = {},
  ): CreateReservationDto => ({
    customerId: 'cust-1',
    equipmentId: 'equip-1',
    startAt: START,
    endAt: END,
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    tenantContext = new TenantContextService();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReservationService,
        {
          provide: PrismaService,
          useValue: {
            reservation: {
              findMany: mockFindMany,
              findUnique: mockFindUnique,
              findFirst: mockFindFirst,
              create: mockCreate,
              update: mockUpdate,
            },
            customer: { findUnique: mockCustomerFindUnique },
            equipment: { findUnique: mockEquipmentFindUnique },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();

    service = moduleRef.get(ReservationService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  const allowRefs = () => {
    mockCustomerFindUnique.mockResolvedValue({ id: 'cust-1' });
    mockEquipmentFindUnique.mockResolvedValue({ id: 'equip-1' });
  };

  describe('listReservations', () => {
    const list = (query: ReservationListQueryDto = {}) =>
      runInTenant(() => service.listReservations(query));

    it('applies the default contract: createdAt asc, take limit+1, envelope', async () => {
      mockFindMany.mockResolvedValue([reservation()]);

      const result = await list();

      expect(result.data).toHaveLength(1);
      expect(result.meta.nextCursor).toBeNull();
      expect(mockFindMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 21,
      });
    });

    it('honors explicit limit, sortBy and order', async () => {
      mockFindMany.mockResolvedValue([]);

      await list({ limit: 5, sortBy: 'startAt', order: 'desc' });

      expect(mockFindMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ startAt: 'desc' }, { id: 'desc' }],
        take: 6,
      });
    });

    it('trims the probe row and encodes nextCursor from the last retained row', async () => {
      const rows = [1, 2, 3].map((n) =>
        reservation({
          id: `resv-${n}`,
          createdAt: new Date(2020, 0, n),
        }),
      );
      rows.push(
        reservation({ id: 'resv-probe', createdAt: new Date(2020, 0, 4) }),
      );
      mockFindMany.mockResolvedValue(rows);

      const result = await list({ limit: 3 });

      expect(result.data.map((r) => r.id)).toEqual([
        'resv-1',
        'resv-2',
        'resv-3',
      ]);
      expect(result.meta.nextCursor).not.toBeNull();
      const decoded = decodeCursor(result.meta.nextCursor as string, {
        sortBy: 'createdAt',
        direction: 'asc',
        fingerprint: filterFingerprint({}),
      });
      expect(decoded.primaryValue).toBe(new Date(2020, 0, 3).getTime());
      expect(decoded.idValue).toBe('resv-3');
    });

    it('composes equality filters and overlap range into AND predicates', async () => {
      mockFindMany.mockResolvedValue([]);
      const from = '2026-05-01T00:00:00.000Z';
      const to = '2026-06-01T00:00:00.000Z';

      await list({
        status: 'RESERVED',
        customerId: 'cust-7',
        equipmentId: 'equip-7',
        from,
        to,
      });

      expect(mockFindMany).toHaveBeenCalledWith({
        where: {
          AND: [
            {
              status: 'RESERVED',
              customerId: 'cust-7',
              equipmentId: 'equip-7',
            },
            { startAt: { lt: new Date(to) }, endAt: { gt: new Date(from) } },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 21,
      });
    });

    it('rejects from >= to with 400 before querying', async () => {
      await expect(
        list({
          from: '2026-06-01T00:00:00.000Z',
          to: '2026-06-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('continues from a valid cursor via the keyset predicate', async () => {
      mockFindMany.mockResolvedValue([]);
      const cursor = encodeCursor(
        'createdAt',
        'asc',
        new Date(2020, 0, 1).getTime(),
        'resv-9',
        filterFingerprint({}),
      );

      await list({ cursor });

      const call = (
        mockFindMany.mock.calls[0] as unknown as [
          { where: { AND: Record<string, unknown>[] } },
        ]
      )[0];
      // Epoch millis from the cursor must be converted back to Date instants
      // for the DateTime column predicate.
      expect(call.where.AND[0]).toEqual({
        OR: [
          { createdAt: { gt: new Date(2020, 0, 1) } },
          { createdAt: { equals: new Date(2020, 0, 1) }, id: { gt: 'resv-9' } },
        ],
      });
    });

    it('rejects an invalid cursor with 400 without querying', async () => {
      await expect(list({ cursor: 'garbage!!' })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('rejects a well-formed cursor carrying a non-date key with 400', async () => {
      // Fingerprints are not secret, so a client can mint a structurally
      // valid cursor with a garbage date key; it must stay a 400, not 500.
      const forged = encodeCursor(
        'createdAt',
        'asc',
        'not-a-date',
        'resv-9',
        filterFingerprint({}),
      );
      await expect(list({ cursor: forged })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('rejects a cursor minted for a different sort (fingerprint/sort mismatch)', async () => {
      const cursor = encodeCursor(
        'createdAt',
        'asc',
        123,
        'resv-9',
        filterFingerprint({ status: 'RESERVED' }),
      );
      // Same sort/direction but no filters applied now -> fingerprint mismatch.
      await expect(list({ cursor })).rejects.toThrow(BadRequestException);
      // Different sort with matching empty fingerprint -> sort mismatch.
      const plainCursor = encodeCursor(
        'createdAt',
        'asc',
        123,
        'resv-9',
        filterFingerprint({}),
      );
      await expect(
        list({ cursor: plainCursor, sortBy: 'startAt' }),
      ).rejects.toThrow(BadRequestException);
      expect(mockFindMany).not.toHaveBeenCalled();
    });
  });

  describe('getReservation', () => {
    it('returns the summary for an existing id', async () => {
      mockFindUnique.mockResolvedValue(reservation());

      const result = await runInTenant(() => service.getReservation('resv-1'));

      expect(result.id).toBe('resv-1');
      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { id: 'resv-1' },
      });
    });

    it('throws NotFound for an unknown or foreign-tenant id', async () => {
      mockFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.getReservation('resv-missing')),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createReservation', () => {
    it('creates a RESERVED reservation deriving the tenant from context', async () => {
      allowRefs();
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockResolvedValue(reservation());

      const result = await runInTenant(() =>
        service.createReservation(createDto()),
      );

      expect(result.status).toBe('RESERVED');
      const createCalls = mockCreate.mock.calls as unknown as Array<
        [{ data: Record<string, unknown> }]
      >;
      expect(createCalls[0][0].data).toMatchObject({
        tenantId: 'tenant-1',
        customerId: 'cust-1',
        equipmentId: 'equip-1',
      });
      expect(createCalls[0][0].data.startAt).toEqual(new Date(START));
      expect(createCalls[0][0].data.endAt).toEqual(new Date(END));
      expect(createCalls[0][0].data).not.toHaveProperty('status');
    });

    it('resolves references through tenant-scoped lookups', async () => {
      allowRefs();
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockResolvedValue(reservation());

      await runInTenant(() => service.createReservation(createDto()));

      expect(mockCustomerFindUnique).toHaveBeenCalledWith({
        where: { id: 'cust-1' },
        select: { id: true },
      });
      expect(mockEquipmentFindUnique).toHaveBeenCalledWith({
        where: { id: 'equip-1' },
        select: { id: true },
      });
    });

    it('throws NotFound for a foreign customer before any write', async () => {
      mockCustomerFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.createReservation(createDto())),
      ).rejects.toThrow(NotFoundException);
      expect(mockEquipmentFindUnique).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('throws NotFound for a foreign equipment before any write', async () => {
      mockCustomerFindUnique.mockResolvedValue({ id: 'cust-1' });
      mockEquipmentFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.createReservation(createDto())),
      ).rejects.toThrow(NotFoundException);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it.each([
      ['equal timestamps', START, START],
      ['reversed range', END, START],
    ])('rejects %s with 400', async (_name, startAt, endAt) => {
      allowRefs();
      await expect(
        runInTenant(() =>
          service.createReservation(createDto({ startAt, endAt })),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockFindFirst).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects unparseable timestamps with 400', async () => {
      allowRefs();
      await expect(
        runInTenant(() =>
          service.createReservation(createDto({ startAt: 'not-a-timestamp' })),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('runs the overlap pre-check with the correct half-open window shape', async () => {
      allowRefs();
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockResolvedValue(reservation());

      await runInTenant(() => service.createReservation(createDto()));

      expect(mockFindFirst).toHaveBeenCalledWith({
        where: {
          equipmentId: 'equip-1',
          status: { in: ['RESERVED', 'ACTIVE'] },
          startAt: { lt: new Date(END) },
          endAt: { gt: new Date(START) },
        },
        select: { id: true },
      });
    });

    it('maps a pre-check overlap to 409 with the friendly message', async () => {
      allowRefs();
      mockFindFirst.mockResolvedValue({ id: 'resv-other' });

      await expect(
        runInTenant(() => service.createReservation(createDto())),
      ).rejects.toThrow(
        new ConflictException(
          'Equipment is already reserved for the selected period',
        ),
      );
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('maps SQLSTATE 23P01 exclusion violations to 409', async () => {
      allowRefs();
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockRejectedValue(
        new Error('exclusion constraint violated (23P01)'),
      );

      await expect(
        runInTenant(() => service.createReservation(createDto())),
      ).rejects.toThrow(
        new ConflictException(
          'Equipment is already reserved for the selected period',
        ),
      );
    });

    it('maps error objects carrying code 23P01 to 409', async () => {
      allowRefs();
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockRejectedValue(
        new Prisma.PrismaClientUnknownRequestError(
          'Database error code: 23P01',
          { clientVersion: 'test' },
        ),
      );

      await expect(
        runInTenant(() => service.createReservation(createDto())),
      ).rejects.toThrow(ConflictException);
    });

    it('rethrows unrelated errors', async () => {
      allowRefs();
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockRejectedValue(new Error('boom'));

      await expect(
        runInTenant(() => service.createReservation(createDto())),
      ).rejects.toThrow('boom');
    });
  });

  describe('updateReservation', () => {
    it('updates only provided fields and never writes tenantId/id/status/links', async () => {
      mockFindUnique.mockResolvedValue(reservation());
      mockUpdate.mockResolvedValue(reservation({ notes: 'changed' }));

      const result = await runInTenant(() =>
        service.updateReservation('resv-1', { notes: 'changed' }),
      );

      expect(result.notes).toBe('changed');
      const updateCalls = mockUpdate.mock.calls as unknown as Array<
        [{ where: { id: string }; data: Record<string, unknown> }]
      >;
      expect(updateCalls[0][0].where).toEqual({ id: 'resv-1' });
      expect(updateCalls[0][0].data).toEqual({ notes: 'changed' });
      expect(updateCalls[0][0].data).not.toHaveProperty('tenantId');
      expect(updateCalls[0][0].data).not.toHaveProperty('id');
      expect(updateCalls[0][0].data).not.toHaveProperty('status');
      expect(updateCalls[0][0].data).not.toHaveProperty('customerId');
      expect(updateCalls[0][0].data).not.toHaveProperty('equipmentId');
    });

    it('merges partial time updates with stored values for validation', async () => {
      mockFindUnique.mockResolvedValue(reservation());
      mockUpdate.mockResolvedValue(reservation());
      mockFindFirst.mockResolvedValue(null);

      // Only endAt moves later: effective range stays valid.
      await runInTenant(() =>
        service.updateReservation('resv-1', {
          endAt: '2026-06-01T16:00:00.000Z',
        }),
      );

      expect(mockFindFirst).toHaveBeenCalledWith({
        where: {
          equipmentId: 'equip-1',
          status: { in: ['RESERVED', 'ACTIVE'] },
          startAt: { lt: new Date('2026-06-01T16:00:00.000Z') },
          endAt: { gt: new Date(START) },
          id: { not: 'resv-1' },
        },
        select: { id: true },
      });
    });

    it('skips the overlap check for notes-only updates', async () => {
      mockFindUnique.mockResolvedValue(reservation());
      mockUpdate.mockResolvedValue(reservation());

      await runInTenant(() =>
        service.updateReservation('resv-1', { notes: 'x' }),
      );

      expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it('rejects an update that would make the range invalid', async () => {
      mockFindUnique.mockResolvedValue(reservation());

      await expect(
        runInTenant(() =>
          service.updateReservation('resv-1', { endAt: START }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('throws NotFound before any write when missing', async () => {
      mockFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() =>
          service.updateReservation('resv-missing', { notes: 'x' }),
        ),
      ).rejects.toThrow(NotFoundException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('rejects updates to CANCELLED reservations with 409', async () => {
      mockFindUnique.mockResolvedValue(reservation({ status: 'CANCELLED' }));

      await expect(
        runInTenant(() => service.updateReservation('resv-1', { notes: 'x' })),
      ).rejects.toThrow(
        new ConflictException(
          'Only reservations in RESERVED status can be updated',
        ),
      );
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('maps exclusion violations during update to 409', async () => {
      mockFindUnique.mockResolvedValue(reservation());
      mockFindFirst.mockResolvedValue(null);
      mockUpdate.mockRejectedValue(
        new Error('exclusion constraint violated (23P01)'),
      );

      await expect(
        runInTenant(() =>
          service.updateReservation('resv-1', {
            endAt: '2026-06-01T20:00:00.000Z',
          }),
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('deleteReservation (soft cancel)', () => {
    it('sets status to CANCELLED without deleting the row', async () => {
      mockFindUnique.mockResolvedValue(reservation());
      mockUpdate.mockResolvedValue(reservation({ status: 'CANCELLED' }));

      const result = await runInTenant(() =>
        service.deleteReservation('resv-1'),
      );

      expect(result).toEqual({ id: 'resv-1' });
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'resv-1' },
        data: { status: 'CANCELLED' },
      });
    });

    it('throws NotFound when missing', async () => {
      mockFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.deleteReservation('resv-missing')),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects double-cancel with 409', async () => {
      mockFindUnique.mockResolvedValue(reservation({ status: 'CANCELLED' }));

      await expect(
        runInTenant(() => service.deleteReservation('resv-1')),
      ).rejects.toThrow(
        new ConflictException('Reservation is already cancelled'),
      );
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle transitions', () => {
    it('startReservation moves RESERVED -> ACTIVE', async () => {
      mockFindUnique.mockResolvedValue(reservation());
      mockUpdate.mockResolvedValue(reservation({ status: 'ACTIVE' }));

      const result = await runInTenant(() =>
        service.startReservation('resv-1'),
      );

      expect(result.status).toBe('ACTIVE');
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'resv-1' },
        data: { status: 'ACTIVE' },
      });
    });

    it('startReservation throws NotFound before any write when missing', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.startReservation('resv-missing')),
      ).rejects.toThrow(NotFoundException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it.each([
      ['ACTIVE', 'started'],
      ['COMPLETED', 'started'],
      ['CANCELLED', 'started'],
    ] as const)(
      'startReservation rejects reservations already in %s with 409',
      async (status) => {
        mockFindUnique.mockResolvedValue(reservation({ status }));

        await expect(
          runInTenant(() => service.startReservation('resv-1')),
        ).rejects.toThrow(
          new ConflictException(
            'Only reservations in RESERVED status can be started',
          ),
        );
        expect(mockUpdate).not.toHaveBeenCalled();
      },
    );

    it('completeReservation moves ACTIVE -> COMPLETED', async () => {
      mockFindUnique.mockResolvedValue(reservation({ status: 'ACTIVE' }));
      mockUpdate.mockResolvedValue(reservation({ status: 'COMPLETED' }));

      const result = await runInTenant(() =>
        service.completeReservation('resv-1'),
      );

      expect(result.status).toBe('COMPLETED');
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'resv-1' },
        data: { status: 'COMPLETED' },
      });
    });

    it('completeReservation throws NotFound before any write when missing', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.completeReservation('resv-missing')),
      ).rejects.toThrow(NotFoundException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it.each([
      ['RESERVED', 'completed'],
      ['CANCELLED', 'completed'],
    ] as const)(
      'completeReservation rejects reservations in %s with 409',
      async (status) => {
        mockFindUnique.mockResolvedValue(reservation({ status }));

        await expect(
          runInTenant(() => service.completeReservation('resv-1')),
        ).rejects.toThrow(
          new ConflictException(
            'Only reservations in ACTIVE status can be completed',
          ),
        );
        expect(mockUpdate).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['startReservation', () => service.startReservation('resv-1')],
      ['completeReservation', () => service.completeReservation('resv-1')],
    ])('%s throws outside a tenant context', async (_name, op) => {
      await expect(op()).rejects.toThrow();
    });

    describe('window-aware gating', () => {
      const PAST_START = '2020-01-01T00:00:00.000Z';
      const PAST_END = '2020-01-01T04:00:00.000Z';
      const FAR_FUTURE = '2099-01-01T00:00:00.000Z';
      const FUTURE_END = '2099-01-01T04:00:00.000Z';

      it('startReservation succeeds once startAt has passed', async () => {
        mockFindUnique.mockResolvedValue(
          reservation({ startAt: new Date(PAST_START) }),
        );
        mockUpdate.mockResolvedValue(reservation({ status: 'ACTIVE' }));

        const result = await runInTenant(() =>
          service.startReservation('resv-1'),
        );

        expect(result.status).toBe('ACTIVE');
        expect(mockUpdate).toHaveBeenCalled();
      });

      it('startReservation rejects a future window with 409 and does not write', async () => {
        mockFindUnique.mockResolvedValue(
          reservation({ startAt: new Date(FAR_FUTURE) }),
        );

        await expect(
          runInTenant(() => service.startReservation('resv-1')),
        ).rejects.toThrow(
          new ConflictException(
            'Reservation cannot be started before its scheduled start time',
          ),
        );
        expect(mockUpdate).not.toHaveBeenCalled();
      });

      it('completeReservation succeeds once endAt has passed', async () => {
        mockFindUnique.mockResolvedValue(
          reservation({ status: 'ACTIVE', endAt: new Date(PAST_END) }),
        );
        mockUpdate.mockResolvedValue(reservation({ status: 'COMPLETED' }));

        const result = await runInTenant(() =>
          service.completeReservation('resv-1'),
        );

        expect(result.status).toBe('COMPLETED');
        expect(mockUpdate).toHaveBeenCalled();
      });

      it('completeReservation rejects before endAt with 409 and does not write', async () => {
        // Window [past startAt, far-future endAt): open, so starting is fine,
        // but completing early conflicts.
        mockFindUnique.mockResolvedValue(
          reservation({
            status: 'ACTIVE',
            startAt: new Date(PAST_START),
            endAt: new Date(FUTURE_END),
          }),
        );

        await expect(
          runInTenant(() => service.completeReservation('resv-1')),
        ).rejects.toThrow(
          new ConflictException(
            'Reservation cannot be completed before its scheduled end time',
          ),
        );
        expect(mockUpdate).not.toHaveBeenCalled();
      });
    });
  });

  describe('projection safety', () => {
    it('returns exactly the safe ReservationSummary keys', async () => {
      mockFindUnique.mockResolvedValue(reservation());

      const result = await runInTenant(() => service.getReservation('resv-1'));

      expect(Object.keys(result).sort()).toEqual([
        'createdAt',
        'customerId',
        'endAt',
        'equipmentId',
        'id',
        'notes',
        'startAt',
        'status',
        'tenantId',
        'updatedAt',
      ]);
    });
  });

  describe('fail-closed without TenantContext', () => {
    it.each([
      ['listReservations', () => service.listReservations()],
      ['getReservation', () => service.getReservation('resv-1')],
      ['createReservation', () => service.createReservation(createDto())],
      [
        'updateReservation',
        () => service.updateReservation('resv-1', { notes: 'x' }),
      ],
      ['deleteReservation', () => service.deleteReservation('resv-1')],
    ])('%s throws outside a tenant context', async (_name, op) => {
      await expect(op()).rejects.toThrow();
    });
  });
});
