import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Booking, BookingStatus, Service, ServiceStatus, Customer, CustomerStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { BookingService, BookingSummary } from './booking.service';

const tenantId = 'tenant-123';
const serviceId = 'service-123';
const customerId = 'customer-123';
const bookingId = 'booking-123';

const mockService: Service = {
  id: serviceId,
  tenantId,
  name: 'Test Service',
  description: null,
  status: 'ACTIVE' as ServiceStatus,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockCustomer: Customer = {
  id: customerId,
  tenantId,
  name: 'Test Customer',
  code: 'CUST001',
  email: null,
  phone: null,
  notes: null,
  status: 'ACTIVE' as CustomerStatus,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockBooking: Booking = {
  id: bookingId,
  tenantId,
  serviceId,
  customerId,
  startAt: new Date('2026-09-02T10:00:00.000Z'),
  endAt: new Date('2026-09-02T11:00:00.000Z'),
  status: 'BOOKED' as BookingStatus,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPrisma = {
  booking: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  service: {
    findUnique: jest.fn(),
  },
  customer: {
    findUnique: jest.fn(),
  },
};

const mockTenantContext = {
  requireTenantId: jest.fn().mockReturnValue(tenantId),
};

describe('BookingService', () => {
  let service: BookingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BookingService(
      mockPrisma as unknown as PrismaService,
      mockTenantContext as unknown as TenantContextService,
    );
  });

  describe('assertTenantContext', () => {
    it('throws when tenant context is missing', () => {
      const badContext = { requireTenantId: () => { throw new Error('No tenant'); } };
      const badService = new BookingService(
        mockPrisma as unknown as PrismaService,
        badContext as unknown as TenantContextService,
      );
      expect(() => badService['assertTenantContext']()).toThrow('No tenant');
    });
  });

  describe('listBookings', () => {
    it('composes keyset pagination with status filter', async () => {
      mockPrisma.booking.findMany.mockResolvedValue([
        { ...mockBooking, id: 'b1', startAt: new Date('2026-09-02T10:00:00.000Z') },
        { ...mockBooking, id: 'b2', startAt: new Date('2026-09-02T12:00:00.000Z') },
      ]);

      const result = await service.listBookings({
        status: 'BOOKED',
        limit: 2,
        order: 'asc',
      } as any);

      expect(mockPrisma.booking.findMany).toHaveBeenCalled();
      const callArgs = mockPrisma.booking.findMany.mock.calls[0][0];
      expect(callArgs.where).toBeDefined();
      expect(callArgs.orderBy).toEqual([{ startAt: 'asc' }, { id: 'asc' }]);
      expect(callArgs.take).toBe(3); // limit + 1
      expect(result.data).toHaveLength(2);
    });

    it('includes serviceId and customerId filters', async () => {
      mockPrisma.booking.findMany.mockResolvedValue([]);

      await service.listBookings({
        status: 'BOOKED',
        serviceId: 'svc-1',
        customerId: 'cust-1',
      } as any);

      const callArgs = mockPrisma.booking.findMany.mock.calls[0][0];
      expect(callArgs.where.AND).toContainEqual(
        expect.objectContaining({ serviceId: 'svc-1', customerId: 'cust-1' })
      );
    });

    it('projects BookingSummary correctly', async () => {
      const booking = { ...mockBooking, id: 'proj-1' };
      mockPrisma.booking.findMany.mockResolvedValue([booking]);

      const result = await service.listBookings({} as any);

      expect(result.data[0]).toEqual({
        id: booking.id,
        tenantId: booking.tenantId,
        serviceId: booking.serviceId,
        customerId: booking.customerId,
        startAt: booking.startAt,
        endAt: booking.endAt,
        status: booking.status,
        createdAt: booking.createdAt,
        updatedAt: booking.updatedAt,
      });
    });

    it('fails closed when tenant context missing', async () => {
      const badContext = { requireTenantId: () => { throw new Error('No tenant'); } };
      const badService = new BookingService(
        mockPrisma as unknown as PrismaService,
        badContext as unknown as TenantContextService,
      );
      await expect(badService.listBookings({} as any)).rejects.toThrow('No tenant');
    });
  });

  describe('getBooking', () => {
    it('returns booking summary when found', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(mockBooking);

      const result = await service.getBooking(bookingId);

      expect(result).toEqual({
        id: mockBooking.id,
        tenantId: mockBooking.tenantId,
        serviceId: mockBooking.serviceId,
        customerId: mockBooking.customerId,
        startAt: mockBooking.startAt,
        endAt: mockBooking.endAt,
        status: mockBooking.status,
        createdAt: mockBooking.createdAt,
        updatedAt: mockBooking.updatedAt,
      });
    });

    it('throws 404 when booking not found', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.getBooking(bookingId)).rejects.toThrow(NotFoundException);
    });

    it('fails closed when tenant context missing', async () => {
      const badContext = { requireTenantId: () => { throw new Error('No tenant'); } };
      const badService = new BookingService(
        mockPrisma as unknown as PrismaService,
        badContext as unknown as TenantContextService,
      );
      await expect(badService.getBooking(bookingId)).rejects.toThrow('No tenant');
    });
  });

  describe('createBooking', () => {
    const createDto = {
      serviceId,
      customerId,
      startAt: '2026-09-02T10:00:00.000Z',
      endAt: '2026-09-02T11:00:00.000Z',
      status: 'BOOKED' as BookingStatus,
    };

    it('creates booking with BOOKED default when status omitted', async () => {
      const dto = { serviceId, customerId, startAt: createDto.startAt, endAt: createDto.endAt };
      mockPrisma.service.findUnique.mockResolvedValue(mockService);
      mockPrisma.customer.findUnique.mockResolvedValue(mockCustomer);
      mockPrisma.booking.create.mockResolvedValue({
        ...mockBooking,
        id: 'new-booking',
        status: 'BOOKED',
      });

      const result = await service.createBooking(dto as any);

      expect(mockPrisma.booking.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId,
            serviceId,
            customerId,
          }),
        }),
      );
      expect(result.status).toBe('BOOKED');
      expect(result.tenantId).toBe(tenantId);
    });

    it('uses explicit status when provided', async () => {
      const explicitDto = {
        serviceId,
        customerId,
        startAt: createDto.startAt,
        endAt: createDto.endAt,
        status: 'CONFIRMED' as BookingStatus,
      };
      mockPrisma.service.findUnique.mockResolvedValue(mockService);
      mockPrisma.customer.findUnique.mockResolvedValue(mockCustomer);
      mockPrisma.booking.create.mockResolvedValue({
        ...mockBooking,
        id: 'new-booking',
        status: 'CONFIRMED',
      });

      const result = await service.createBooking(explicitDto as any);

      expect(mockPrisma.booking.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'CONFIRMED' }),
        }),
      );
      expect(result.status).toBe('CONFIRMED');
    });

    it('omits customerId when not provided (walk-in)', async () => {
      const dto = { serviceId, startAt: createDto.startAt, endAt: createDto.endAt };
      mockPrisma.service.findUnique.mockResolvedValue(mockService);
      mockPrisma.booking.create.mockResolvedValue({
        ...mockBooking,
        id: 'new-booking',
        customerId: null,
      });

      const result = await service.createBooking(dto as any);

      expect(mockPrisma.customer.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.booking.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ customerId: expect.anything() }),
        }),
      );
      expect(result.customerId).toBeNull();
    });

    it('validates service exists', async () => {
      mockPrisma.service.findUnique.mockResolvedValue(null);

      await expect(service.createBooking(createDto as any)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.booking.create).not.toHaveBeenCalled();
    });

    it('validates service is ACTIVE', async () => {
      mockPrisma.service.findUnique.mockResolvedValue({ ...mockService, status: 'DRAFT' });

      await expect(service.createBooking(createDto as any)).rejects.toThrow(ConflictException);
      expect(mockPrisma.booking.create).not.toHaveBeenCalled();
    });

    it('validates customer exists when provided', async () => {
      mockPrisma.service.findUnique.mockResolvedValue(mockService);
      mockPrisma.customer.findUnique.mockResolvedValue(null);

      await expect(service.createBooking(createDto as any)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.booking.create).not.toHaveBeenCalled();
    });

    it('maps P2002/P2003 (overlap) to 409', async () => {
      mockPrisma.service.findUnique.mockResolvedValue(mockService);
      mockPrisma.customer.findUnique.mockResolvedValue(mockCustomer);
      const error = new Prisma.PrismaClientKnownRequestError('Overlap', { code: 'P2002', clientVersion: '6.19.3' });
      mockPrisma.booking.create.mockRejectedValue(error);

      await expect(service.createBooking(createDto as any)).rejects.toThrow(ConflictException);
    });

    it('fails closed when tenant context missing', async () => {
      const badContext = { requireTenantId: () => { throw new Error('No tenant'); } };
      const badService = new BookingService(
        mockPrisma as unknown as PrismaService,
        badContext as unknown as TenantContextService,
      );
      await expect(badService.createBooking(createDto as any)).rejects.toThrow('No tenant');
    });
  });

  describe('updateBooking', () => {
    const updateDto = {
      status: 'CONFIRMED' as BookingStatus,
      startAt: '2026-09-02T12:00:00.000Z',
      endAt: '2026-09-02T13:00:00.000Z',
    };

    it('updates booking fields', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(mockBooking);
      mockPrisma.booking.update.mockResolvedValue({
        ...mockBooking,
        status: 'CONFIRMED',
      });

      const result = await service.updateBooking(bookingId, updateDto as any);

      expect(mockPrisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: bookingId },
          data: expect.objectContaining({
            status: 'CONFIRMED',
            startAt: new Date(updateDto.startAt),
            endAt: new Date(updateDto.endAt),
          }),
        }),
      );
      expect(result.status).toBe('CONFIRMED');
    });

    it('does not write tenantId', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(mockBooking);
      mockPrisma.booking.update.mockResolvedValue(mockBooking);

      await service.updateBooking(bookingId, { status: 'CONFIRMED' } as any);

      const callArgs = mockPrisma.booking.update.mock.calls[0][0];
      expect(callArgs.data).not.toHaveProperty('tenantId');
    });

    it('throws 404 when booking not found', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.updateBooking(bookingId, updateDto as any)).rejects.toThrow(NotFoundException);
    });

    it('validates service exists and is ACTIVE when changing', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(mockBooking);
      mockPrisma.service.findUnique.mockResolvedValue(null);

      await expect(service.updateBooking(bookingId, { serviceId: 'svc-999' } as any)).rejects.toThrow(NotFoundException);
    });

    it('validates service is ACTIVE when changing', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(mockBooking);
      mockPrisma.service.findUnique.mockResolvedValue({ ...mockService, status: 'DRAFT' });

      await expect(service.updateBooking(bookingId, { serviceId: 'svc-999' } as any)).rejects.toThrow(ConflictException);
    });

    it('validates customer exists when provided', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(mockBooking);
      mockPrisma.customer.findUnique.mockResolvedValue(null);

      await expect(service.updateBooking(bookingId, { customerId: 'cust-999' } as any)).rejects.toThrow(NotFoundException);
    });

    it('maps P2002/P2003 (overlap) to 409', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(mockBooking);
      const error = new Prisma.PrismaClientKnownRequestError('Overlap', { code: 'P2002', clientVersion: '6.19.3' });
      mockPrisma.booking.update.mockRejectedValue(error);

      await expect(service.updateBooking(bookingId, updateDto as any)).rejects.toThrow(ConflictException);
    });

    it('fails closed when tenant context missing', async () => {
      const badContext = { requireTenantId: () => { throw new Error('No tenant'); } };
      const badService = new BookingService(
        mockPrisma as unknown as PrismaService,
        badContext as unknown as TenantContextService,
      );
      await expect(badService.updateBooking(bookingId, updateDto as any)).rejects.toThrow('No tenant');
    });
  });
});