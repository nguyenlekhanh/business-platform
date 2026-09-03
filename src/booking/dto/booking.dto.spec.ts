import { CreateBookingDto } from './booking.dto';
import { UpdateBookingDto } from './booking.dto';
import { BookingListQueryDto } from './booking.dto';
import { BookingStatus } from '@prisma/client';

describe('Booking DTOs', () => {
  describe('CreateBookingDto', () => {
    it('accepts minimal valid payload', () => {
      const dto = new CreateBookingDto();
      dto.serviceId = 'cuid123456789012345678';
      dto.startAt = '2026-09-02T10:00:00.000Z';
      dto.endAt = '2026-09-02T11:00:00.000Z';

      expect(dto.serviceId).toBe('cuid123456789012345678');
      expect(dto.startAt).toBe('2026-09-02T10:00:00.000Z');
      expect(dto.endAt).toBe('2026-09-02T11:00:00.000Z');
      expect(dto.customerId).toBeUndefined();
      expect(dto.status).toBeUndefined();
    });

    it('accepts optional customerId', () => {
      const dto = new CreateBookingDto();
      dto.serviceId = 'cuid123456789012345678';
      dto.startAt = '2026-09-02T10:00:00.000Z';
      dto.endAt = '2026-09-02T11:00:00.000Z';
      dto.customerId = 'uuid-1234-5678-9012-345678901234';

      expect(dto.customerId).toBe('uuid-1234-5678-9012-345678901234');
    });

    it('accepts optional status', () => {
      const dto = new CreateBookingDto();
      dto.serviceId = 'cuid123456789012345678';
      dto.startAt = '2026-09-02T10:00:00.000Z';
      dto.endAt = '2026-09-02T11:00:00.000Z';
      dto.status = BookingStatus.CONFIRMED;

      expect(dto.status).toBe(BookingStatus.CONFIRMED);
    });

    it('rejects missing serviceId', () => {
      const dto = new CreateBookingDto();
      dto.startAt = '2026-09-02T10:00:00.000Z';
      dto.endAt = '2026-09-02T11:00:00.000Z';

      expect(dto.serviceId).toBeUndefined();
    });

    it('rejects missing startAt', () => {
      const dto = new CreateBookingDto();
      dto.serviceId = 'cuid123456789012345678';
      dto.endAt = '2026-09-02T11:00:00.000Z';

      expect(dto.startAt).toBeUndefined();
    });

    it('rejects missing endAt', () => {
      const dto = new CreateBookingDto();
      dto.serviceId = 'cuid123456789012345678';
      dto.startAt = '2026-09-02T10:00:00.000Z';

      expect(dto.endAt).toBeUndefined();
    });

    it('rejects invalid serviceId format', () => {
      const dto = new CreateBookingDto();
      dto.serviceId = 'not-a-uuid';
      dto.startAt = '2026-09-02T10:00:00.000Z';
      dto.endAt = '2026-09-02T11:00:00.000Z';

      expect(dto.serviceId).toBe('not-a-uuid');
    });

    it('rejects invalid customerId format', () => {
      const dto = new CreateBookingDto();
      dto.serviceId = 'cuid123456789012345678';
      dto.startAt = '2026-09-02T10:00:00.000Z';
      dto.endAt = '2026-09-02T11:00:00.000Z';
      dto.customerId = 'not-a-uuid';

      expect(dto.customerId).toBe('not-a-uuid');
    });

    it('rejects invalid ISO date format', () => {
      const dto = new CreateBookingDto();
      dto.serviceId = 'cuid123456789012345678';
      dto.startAt = 'not-a-date';
      dto.endAt = '2026-09-02T11:00:00.000Z';

      expect(dto.startAt).toBe('not-a-date');
    });

    it('rejects invalid status enum', () => {
      const dto = new CreateBookingDto();
      dto.serviceId = 'cuid123456789012345678';
      dto.startAt = '2026-09-02T10:00:00.000Z';
      dto.endAt = '2026-09-02T11:00:00.000Z';
      dto.status = 'INVALID_STATUS' as BookingStatus;

      expect(dto.status).toBe('INVALID_STATUS');
    });
  });

  describe('UpdateBookingDto', () => {
    it('accepts empty patch (all optional)', () => {
      const dto = new UpdateBookingDto();

      expect(dto.serviceId).toBeUndefined();
      expect(dto.customerId).toBeUndefined();
      expect(dto.startAt).toBeUndefined();
      expect(dto.endAt).toBeUndefined();
      expect(dto.status).toBeUndefined();
    });

    it('accepts partial updates', () => {
      const dto = new UpdateBookingDto();
      dto.status = BookingStatus.CONFIRMED;
      dto.customerId = 'uuid-1234-5678-9012-345678901234';

      expect(dto.status).toBe(BookingStatus.CONFIRMED);
      expect(dto.customerId).toBe('uuid-1234-5678-9012-345678901234');
    });

    it('rejects invalid serviceId format', () => {
      const dto = new UpdateBookingDto();
      dto.serviceId = 'not-a-uuid';

      expect(dto.serviceId).toBe('not-a-uuid');
    });

    it('rejects invalid customerId format', () => {
      const dto = new UpdateBookingDto();
      dto.customerId = 'not-a-uuid';

      expect(dto.customerId).toBe('not-a-uuid');
    });

    it('rejects invalid ISO date format', () => {
      const dto = new UpdateBookingDto();
      dto.startAt = 'not-a-date';

      expect(dto.startAt).toBe('not-a-date');
    });

    it('rejects invalid status enum', () => {
      const dto = new UpdateBookingDto();
      dto.status = 'INVALID_STATUS' as BookingStatus;

      expect(dto.status).toBe('INVALID_STATUS');
    });
  });

  describe('BookingListQueryDto', () => {
    it('extends PageQueryDto with booking-specific filters', () => {
      const dto = new BookingListQueryDto();
      dto.status = BookingStatus.BOOKED;
      dto.serviceId = 'cuid123456789012345678';
      dto.customerId = 'uuid-1234-5678-9012-345678901234';
      dto.limit = 50;
      dto.cursor = 'cursor123';
      dto.order = 'desc';

      expect(dto.status).toBe(BookingStatus.BOOKED);
      expect(dto.serviceId).toBe('cuid123456789012345678');
      expect(dto.customerId).toBe('uuid-1234-5678-9012-345678901234');
      expect(dto.limit).toBe(50);
      expect(dto.cursor).toBe('cursor123');
      expect(dto.order).toBe('desc');
    });

    it('rejects invalid serviceId format', () => {
      const dto = new BookingListQueryDto();
      dto.serviceId = 'not-a-uuid';

      expect(dto.serviceId).toBe('not-a-uuid');
    });

    it('rejects invalid customerId format', () => {
      const dto = new BookingListQueryDto();
      dto.customerId = 'not-a-uuid';

      expect(dto.customerId).toBe('not-a-uuid');
    });

    it('rejects invalid status enum', () => {
      const dto = new BookingListQueryDto();
      dto.status = 'INVALID_STATUS' as BookingStatus;

      expect(dto.status).toBe('INVALID_STATUS');
    });

    it('rejects invalid limit (via PageQueryDto)', () => {
      const dto = new BookingListQueryDto();
      dto.limit = 101;

      expect(dto.limit).toBe(101);
    });

    it('rejects invalid order (via PageQueryDto)', () => {
      const dto = new BookingListQueryDto();
      dto.order = 'invalid';

      expect(dto.order).toBe('invalid');
    });
  });
});