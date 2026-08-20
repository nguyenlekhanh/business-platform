import {
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PermissionService } from '../rbac/permission.service';
import { TenantAdminService } from './tenant-admin.service';

describe('TenantAdminService', () => {
  let service: TenantAdminService;
  let tenantContext: TenantContextService;

  const mockFindUnique = jest.fn();
  const mockUpdate = jest.fn();
  const mockAssertPermissions = jest.fn();

  const tenant = (overrides: Record<string, unknown> = {}) => ({
    id: 'tenant-1',
    name: 'Acme',
    slug: 'acme',
    status: 'ACTIVE',
    settings: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    tenantContext = new TenantContextService();

    const moduleRef = await Test.createTestingModule({
      providers: [
        TenantAdminService,
        {
          provide: PrismaService,
          useValue: {
            tenant: { findUnique: mockFindUnique, update: mockUpdate },
          },
        },
        {
          provide: PermissionService,
          useValue: { assertPermissions: mockAssertPermissions },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();

    service = moduleRef.get(TenantAdminService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  describe('getTenant', () => {
    it('returns the safe tenant summary for the context tenant', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValue(tenant());

      const result = await runInTenant(() => service.getTenant('user-1'));

      expect(result).toEqual(
        expect.objectContaining({
          id: 'tenant-1',
          name: 'Acme',
          slug: 'acme',
          status: 'ACTIVE',
          settings: null,
        }),
      );
      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { id: 'tenant-1' },
      });
      expect(mockAssertPermissions).toHaveBeenCalledWith('user-1', {
        mode: 'ALL',
        permissions: ['settings:read'],
      });
    });

    it('does not expose non-whitelisted tenant fields', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValue(tenant());

      const result = await runInTenant(() => service.getTenant('user-1'));

      expect(Object.keys(result)).toEqual(
        expect.arrayContaining([
          'id',
          'name',
          'slug',
          'status',
          'settings',
          'createdAt',
          'updatedAt',
        ]),
      );
      expect(Object.keys(result)).toHaveLength(7);
    });

    it('requires settings:read', async () => {
      mockAssertPermissions.mockRejectedValue(new ForbiddenException());

      await expect(
        runInTenant(() => service.getTenant('user-1')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns 404 when the tenant does not exist', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.getTenant('user-1')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('fails closed when no tenant context is available', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);

      await expect(service.getTenant('user-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(mockFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('updateTenant', () => {
    it('updates the allowed fields and returns the summary', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockUpdate.mockResolvedValue(
        tenant({
          name: 'Acme Inc',
          slug: 'acme-inc',
          settings: { theme: 'dark' },
        }),
      );

      const result = await runInTenant(() =>
        service.updateTenant('user-1', {
          name: 'Acme Inc',
          slug: 'acme-inc',
          settings: { theme: 'dark' },
        }),
      );

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'tenant-1' },
        data: {
          name: 'Acme Inc',
          slug: 'acme-inc',
          settings: { theme: 'dark' },
        },
      });
      expect(result).toEqual(
        expect.objectContaining({
          name: 'Acme Inc',
          slug: 'acme-inc',
          settings: { theme: 'dark' },
        }),
      );
      expect(mockAssertPermissions).toHaveBeenCalledWith('user-1', {
        mode: 'ALL',
        permissions: ['settings:manage'],
      });
    });

    it('omits fields not present in the payload', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockUpdate.mockResolvedValue(tenant());

      await runInTenant(() =>
        service.updateTenant('user-1', { name: 'Only Name' }),
      );

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'tenant-1' },
        data: { name: 'Only Name' },
      });
    });

    it('cannot update id, status or tenantId (no DTO fields, no where override)', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockUpdate.mockResolvedValue(tenant());

      await runInTenant(() =>
        service.updateTenant('user-1', { name: 'Acme Inc' }),
      );

      // The update targets ONLY the context tenant and writes ONLY allowed
      // fields; injecting id/status/tenantId into data or another id into
      // where would fail this exact-match assertion.
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'tenant-1' },
        data: { name: 'Acme Inc' },
      });
    });

    it('requires settings:manage', async () => {
      mockAssertPermissions.mockRejectedValue(new ForbiddenException());

      await expect(
        runInTenant(() => service.updateTenant('user-1', { name: 'X' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('maps a duplicate slug (P2002) to 409', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      const prismaError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (slug)',
        { code: 'P2002', clientVersion: 'test' },
      );
      mockUpdate.mockRejectedValue(prismaError);

      await expect(
        runInTenant(() => service.updateTenant('user-1', { slug: 'taken' })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows non-unique Prisma errors', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockUpdate.mockRejectedValue(new Error('boom'));

      await expect(
        runInTenant(() => service.updateTenant('user-1', { name: 'X' })),
      ).rejects.toThrow('boom');
    });

    it('fails closed when no tenant context is available', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);

      await expect(
        service.updateTenant('user-1', { name: 'X' }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
