import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { CustomerService, CustomerSummary } from './customer.service';
import type { CreateCustomerDto } from './dto/customer.dto';

describe('CustomerService', () => {
  let service: CustomerService;
  let tenantContext: TenantContextService;

  const mockFindMany = jest.fn();
  const mockFindUnique = jest.fn();
  const mockCreate = jest.fn();
  const mockUpdate = jest.fn();
  const mockDelete = jest.fn();

  const customer = (
    overrides: Partial<CustomerSummary> = {},
  ): CustomerSummary => ({
    id: 'cust-1',
    tenantId: 'tenant-1',
    name: 'Alpha Construction',
    code: 'CUST-001',
    email: null,
    phone: null,
    notes: null,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
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
        CustomerService,
        {
          provide: PrismaService,
          useValue: {
            customer: {
              findMany: mockFindMany,
              findUnique: mockFindUnique,
              create: mockCreate,
              update: mockUpdate,
              delete: mockDelete,
            },
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();

    service = moduleRef.get(CustomerService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  const createDto = (
    overrides: Partial<CreateCustomerDto> = {},
  ): CreateCustomerDto => ({
    name: 'Alpha Construction',
    code: 'CUST-001',
    ...overrides,
  });

  describe('listCustomers', () => {
    it('lists customers in the current tenant context (envelope, default contract)', async () => {
      mockFindMany.mockResolvedValue([customer(), customer({ id: 'cust-2' })]);

      const result = await runInTenant(() => service.listCustomers({}));

      expect(result.data).toHaveLength(2);
      expect(result.meta.nextCursor).toBeNull();
      expect(result.data[0]).toEqual(expect.objectContaining({ id: 'cust-1' }));
      expect(mockFindMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 21,
      });
    });

    it('composes the status filter and honors limit/order', async () => {
      mockFindMany.mockResolvedValue([]);

      await runInTenant(() =>
        service.listCustomers({ status: 'ARCHIVED', limit: 5, order: 'desc' }),
      );

      expect(mockFindMany).toHaveBeenCalledWith({
        where: { AND: [{ status: 'ARCHIVED' }] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 6,
      });
    });

    it('rejects an invalid cursor with 400 without querying', async () => {
      await expect(
        runInTenant(() => service.listCustomers({ cursor: 'garbage!!' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('fails closed outside a tenant context', async () => {
      await expect(service.listCustomers({})).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockFindMany).not.toHaveBeenCalled();
    });
  });

  describe('getCustomer', () => {
    it('returns the summary for an existing id', async () => {
      mockFindUnique.mockResolvedValue(customer());

      const result = await runInTenant(() => service.getCustomer('cust-1'));

      expect(result.id).toBe('cust-1');
      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { id: 'cust-1' },
      });
    });

    it('throws NotFound for an unknown or foreign-tenant id', async () => {
      mockFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.getCustomer('cust-missing')),
      ).rejects.toThrow('Customer not found');
    });
  });

  describe('createCustomer', () => {
    it('creates a customer deriving the tenant from context', async () => {
      mockCreate.mockResolvedValue(customer());

      const result = await runInTenant(() =>
        service.createCustomer(createDto()),
      );

      expect(result).toEqual(expect.objectContaining({ id: 'cust-1' }));
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          name: 'Alpha Construction',
          code: 'CUST-001',
        },
      });
    });

    it('passes optional fields through when provided', async () => {
      mockCreate.mockResolvedValue(
        customer({
          email: 'ops@alpha.example',
          phone: '+15550100',
          notes: 'Net 30',
          status: 'INACTIVE',
        }),
      );

      await runInTenant(() =>
        service.createCustomer(
          createDto({
            email: 'ops@alpha.example',
            phone: '+15550100',
            notes: 'Net 30',
            status: 'INACTIVE',
          }),
        ),
      );

      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          name: 'Alpha Construction',
          code: 'CUST-001',
          email: 'ops@alpha.example',
          phone: '+15550100',
          notes: 'Net 30',
          status: 'INACTIVE',
        },
      });
    });

    it('maps P2002 to Conflict (duplicate tenant+code)', async () => {
      mockCreate.mockRejectedValue(p2002(['tenantId', 'code']));

      await expect(
        runInTenant(() => service.createCustomer(createDto())),
      ).rejects.toThrow(ConflictException);
    });

    it('rethrows non-P2002 errors', async () => {
      mockCreate.mockRejectedValue(new Error('boom'));

      await expect(
        runInTenant(() => service.createCustomer(createDto())),
      ).rejects.toThrow('boom');
    });
  });

  describe('updateCustomer', () => {
    it('updates only provided fields and never writes tenantId/id', async () => {
      mockFindUnique.mockResolvedValue(customer());
      mockUpdate.mockResolvedValue(customer({ name: 'Beta Group' }));

      const result = await runInTenant(() =>
        service.updateCustomer('cust-1', { name: 'Beta Group' }),
      );

      expect(result.name).toBe('Beta Group');
      const updateCalls = mockUpdate.mock.calls as unknown as Array<
        [{ where: { id: string }; data: Record<string, unknown> }]
      >;
      expect(updateCalls[0][0].where).toEqual({ id: 'cust-1' });
      expect(updateCalls[0][0].data).toEqual({ name: 'Beta Group' });
      expect(updateCalls[0][0].data).not.toHaveProperty('tenantId');
      expect(updateCalls[0][0].data).not.toHaveProperty('id');
    });

    it('throws NotFound before any write when the record is missing', async () => {
      mockFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() =>
          service.updateCustomer('cust-missing', { name: 'X' }),
        ),
      ).rejects.toThrow('Customer not found');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('maps P2002 to Conflict on duplicate-code rename', async () => {
      mockFindUnique.mockResolvedValue(customer());
      mockUpdate.mockRejectedValue(p2002(['tenantId', 'code']));

      await expect(
        runInTenant(() => service.updateCustomer('cust-1', { code: 'TAKEN' })),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('deleteCustomer', () => {
    it('deletes an existing customer and returns its id', async () => {
      mockFindUnique.mockResolvedValue(customer());
      mockDelete.mockResolvedValue(customer());

      const result = await runInTenant(() => service.deleteCustomer('cust-1'));

      expect(result).toEqual({ id: 'cust-1' });
      expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'cust-1' } });
    });

    it('throws NotFound when the record is missing', async () => {
      mockFindUnique.mockResolvedValue(null);
      await expect(
        runInTenant(() => service.deleteCustomer('cust-missing')),
      ).rejects.toThrow('Customer not found');
    });
  });

  describe('fail-closed without TenantContext', () => {
    it.each([
      ['listCustomers', () => service.listCustomers()],
      ['getCustomer', () => service.getCustomer('cust-1')],
      ['createCustomer', () => service.createCustomer(createDto())],
      ['updateCustomer', () => service.updateCustomer('cust-1', { name: 'X' })],
      ['deleteCustomer', () => service.deleteCustomer('cust-1')],
    ])('%s throws outside a tenant context', async (_name, op) => {
      await expect(op()).rejects.toThrow();
    });
  });
});
