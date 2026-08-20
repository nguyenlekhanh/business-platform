import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PermissionService } from './permission.service';
import { RoleService } from './role.service';

describe('RoleService', () => {
  let service: RoleService;
  let tenantContext: TenantContextService;

  const mockCreate = jest.fn();
  const mockTransaction = jest.fn<
    Promise<unknown>,
    [(tx: TxClient) => Promise<unknown>]
  >();
  const mockFindUnique = jest.fn();
  const mockFindMany = jest.fn();
  const mockUpdate = jest.fn();
  const mockDelete = jest.fn();
  const mockCount = jest.fn();
  const mockCreateMany = jest.fn();
  const mockDeleteMany = jest.fn();
  const mockPermissionFindMany = jest.fn();
  const mockQueryRaw = jest.fn();
  const mockAssertPermissions = jest.fn();
  const mockGetPermissions = jest.fn();
  const mockClearMemo = jest.fn();

  interface TxClient {
    role?: { create: typeof mockCreate };
    rolePermission?: {
      createMany: typeof mockCreateMany;
      deleteMany: typeof mockDeleteMany;
    };
    membership?: { update: typeof mockUpdate };
    $queryRaw?: typeof mockQueryRaw;
  }

  const role = (overrides: Record<string, unknown> = {}) => ({
    id: 'role-1',
    key: 'custom',
    name: 'Custom',
    description: null,
    isSystem: false,
    permissions: [],
    ...overrides,
  });

  const membership = (overrides: Record<string, unknown> = {}) => ({
    id: 'membership-1',
    userId: 'user-2',
    roleId: 'role-1',
    role: { key: 'custom' },
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    tenantContext = new TenantContextService();

    const moduleRef = await Test.createTestingModule({
      providers: [
        RoleService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: mockTransaction,
            role: {
              create: mockCreate,
              findUnique: mockFindUnique,
              findMany: mockFindMany,
              update: mockUpdate,
              delete: mockDelete,
            },
            membership: {
              count: mockCount,
              findUnique: mockFindUnique,
              update: mockUpdate,
            },
            rolePermission: {
              createMany: mockCreateMany,
              deleteMany: mockDeleteMany,
            },
            permission: { findMany: mockPermissionFindMany },
          },
        },
        {
          provide: PermissionService,
          useValue: {
            assertPermissions: mockAssertPermissions,
            getPermissions: mockGetPermissions,
            clearMemo: mockClearMemo,
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();

    service = moduleRef.get(RoleService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
    new Prisma.PrismaClientKnownRequestError('db error', {
      code,
      clientVersion: '6.19.3',
    });

  describe('createRole', () => {
    it('creates a role and its grants in a transaction', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockPermissionFindMany.mockResolvedValue([
        { id: 'perm-a', key: 'store:read' },
        { id: 'perm-b', key: 'report:read' },
      ]);
      mockGetPermissions.mockResolvedValue({ isOwner: true, keys: [] });
      mockTransaction.mockImplementation((cb) =>
        cb({
          role: { create: mockCreate },
          rolePermission: { createMany: mockCreateMany },
        }),
      );
      mockCreate.mockResolvedValue({
        id: 'role-1',
        key: 'custom',
        name: 'Custom',
      });

      const result = await runInTenant(() =>
        service.createRole('user-1', {
          key: 'custom',
          name: 'Custom',
          permissionIds: ['perm-a', 'perm-b'],
        }),
      );

      expect(result).toEqual({ id: 'role-1', key: 'custom', name: 'Custom' });
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          key: 'custom',
          name: 'Custom',
          description: undefined,
          isSystem: false,
        },
        select: expect.objectContaining({}) as object,
      });
      expect(mockCreateMany).toHaveBeenCalledWith({
        data: [
          { roleId: 'role-1', permissionId: 'perm-a' },
          { roleId: 'role-1', permissionId: 'perm-b' },
        ],
      });
      expect(mockClearMemo).toHaveBeenCalled();
    });

    it('rejects duplicate role keys within the tenant with 409', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockPermissionFindMany.mockResolvedValue([
        { id: 'perm-a', key: 'store:read' },
      ]);
      mockGetPermissions.mockResolvedValue({ isOwner: true, keys: [] });
      mockTransaction.mockRejectedValue(prismaError('P2002'));

      await expect(
        runInTenant(() =>
          service.createRole('user-1', {
            key: 'custom',
            name: 'Custom',
            permissionIds: ['perm-a'],
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects unknown permission ids with 400', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockPermissionFindMany.mockResolvedValue([{ id: 'perm-a', key: 'a' }]);

      await expect(
        runInTenant(() =>
          service.createRole('user-1', {
            key: 'custom',
            name: 'Custom',
            permissionIds: ['perm-a', 'perm-unknown'],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects reserved system role keys with 400', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);

      await expect(
        runInTenant(() =>
          service.createRole('user-1', {
            key: 'owner',
            name: 'Custom',
            permissionIds: ['perm-a'],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPermissionFindMany).not.toHaveBeenCalled();
    });

    it('rejects creating a role without permissions with 400', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);

      await expect(
        runInTenant(() =>
          service.createRole('user-1', {
            key: 'custom',
            name: 'Custom',
            permissionIds: [],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects duplicate permission ids with 400', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);

      await expect(
        runInTenant(() =>
          service.createRole('user-1', {
            key: 'custom',
            name: 'Custom',
            permissionIds: ['perm-a', 'perm-a'],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPermissionFindMany).not.toHaveBeenCalled();
    });

    it('rejects a permission list over the max size with 400', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);

      const oversized = Array.from({ length: 51 }, (_, i) => `perm-${i}`);

      await expect(
        runInTenant(() =>
          service.createRole('user-1', {
            key: 'custom',
            name: 'Custom',
            permissionIds: oversized,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an over-long permission id with 400', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);

      await expect(
        runInTenant(() =>
          service.createRole('user-1', {
            key: 'custom',
            name: 'Custom',
            permissionIds: ['a'.repeat(41)],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects granting a permission the actor does not hold with 403', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockPermissionFindMany.mockResolvedValue([
        { id: 'perm-a', key: 'store:delete' },
      ]);
      mockGetPermissions.mockResolvedValue({
        isOwner: false,
        keys: ['role:manage'],
      });

      await expect(
        runInTenant(() =>
          service.createRole('user-1', {
            key: 'custom',
            name: 'Custom',
            permissionIds: ['perm-a'],
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows a non-owner to grant only permissions they hold', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockPermissionFindMany.mockResolvedValue([
        { id: 'perm-a', key: 'store:read' },
      ]);
      mockGetPermissions.mockResolvedValue({
        isOwner: false,
        keys: ['role:manage', 'store:read'],
      });
      mockTransaction.mockImplementation((cb) =>
        cb({
          role: { create: mockCreate },
          rolePermission: { createMany: mockCreateMany },
        }),
      );
      mockCreate.mockResolvedValue({
        id: 'role-1',
        key: 'custom',
        name: 'Custom',
      });

      const result = await runInTenant(() =>
        service.createRole('user-1', {
          key: 'custom',
          name: 'Custom',
          permissionIds: ['perm-a'],
        }),
      );

      expect(result).toEqual({ id: 'role-1', key: 'custom', name: 'Custom' });
    });
  });

  describe('updateRole', () => {
    it('updates a custom role name and description', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValueOnce(role());
      mockUpdate.mockResolvedValue({
        id: 'role-1',
        key: 'custom',
        name: 'New name',
        description: 'New desc',
      });

      const result = await runInTenant(() =>
        service.updateRole('user-1', 'role-1', {
          name: 'New name',
          description: 'New desc',
        }),
      );

      expect(result.name).toBe('New name');
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'role-1' },
        data: { name: 'New name', description: 'New desc' },
        select: expect.objectContaining({}) as object,
      });
      expect(mockClearMemo).toHaveBeenCalled();
    });

    it('returns 404 when the role does not exist', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValueOnce(null);

      await expect(
        runInTenant(() =>
          service.updateRole('user-1', 'role-missing', { name: 'X' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects updates to system roles with 403', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValueOnce(role({ isSystem: true }));

      await expect(
        runInTenant(() =>
          service.updateRole('user-1', 'role-1', { name: 'X' }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('deleteRole', () => {
    it('deletes a custom role with no memberships', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValueOnce(role());
      mockCount.mockResolvedValue(0);
      mockDelete.mockResolvedValue({ id: 'role-1' });

      const result = await runInTenant(() =>
        service.deleteRole('user-1', 'role-1'),
      );

      expect(result).toEqual({ id: 'role-1' });
      expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'role-1' } });
      expect(mockClearMemo).toHaveBeenCalled();
    });

    it('rejects deleting a role that is assigned to memberships with 409', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValueOnce(role());
      mockCount.mockResolvedValue(1);

      await expect(
        runInTenant(() => service.deleteRole('user-1', 'role-1')),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects deleting a system role with 403', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValueOnce(role({ isSystem: true }));

      await expect(
        runInTenant(() => service.deleteRole('user-1', 'role-1')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('assignPermissions', () => {
    it('replaces the grants on a custom role', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValueOnce(role());
      mockPermissionFindMany.mockResolvedValue([
        { id: 'perm-a', key: 'store:read' },
      ]);
      mockGetPermissions.mockResolvedValue({ isOwner: true, keys: [] });
      mockTransaction.mockImplementation(async (cb) =>
        cb({
          rolePermission: {
            createMany: mockCreateMany,
            deleteMany: mockDeleteMany,
          },
        }),
      );

      const result = await runInTenant(() =>
        service.assignPermissions('user-1', 'role-1', {
          permissionIds: ['perm-a'],
        }),
      );

      expect(result).toEqual({ id: 'role-1', permissionCount: 1 });
      expect(mockDeleteMany).toHaveBeenCalledWith({
        where: { roleId: 'role-1' },
      });
      expect(mockCreateMany).toHaveBeenCalledWith({
        data: [{ roleId: 'role-1', permissionId: 'perm-a' }],
      });
      expect(mockClearMemo).toHaveBeenCalled();
    });

    it('rejects changes to system role grants with 403', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValueOnce(role({ isSystem: true }));

      await expect(
        runInTenant(() =>
          service.assignPermissions('user-1', 'role-1', {
            permissionIds: ['perm-a'],
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects granting a permission the actor does not hold with 403', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValueOnce(role());
      mockPermissionFindMany.mockResolvedValue([
        { id: 'perm-a', key: 'store:delete' },
      ]);
      mockGetPermissions.mockResolvedValue({
        isOwner: false,
        keys: ['role:manage'],
      });

      await expect(
        runInTenant(() =>
          service.assignPermissions('user-1', 'role-1', {
            permissionIds: ['perm-a'],
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('assignRoleToMembership', () => {
    it('assigns a role to another member', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique
        .mockResolvedValueOnce(role())
        .mockResolvedValueOnce(membership());
      mockUpdate.mockResolvedValue({
        id: 'membership-1',
        roleId: 'role-1',
      });

      const result = await runInTenant(() =>
        service.assignRoleToMembership('user-1', {
          membershipId: 'membership-1',
          roleId: 'role-1',
        }),
      );

      expect(result).toEqual({ id: 'membership-1', roleId: 'role-1' });
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'membership-1' },
        data: { roleId: 'role-1' },
        select: expect.objectContaining({}) as object,
      });
      expect(mockClearMemo).toHaveBeenCalled();
    });

    it('rejects changing your own role with 403', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique
        .mockResolvedValueOnce(role())
        .mockResolvedValueOnce(membership({ userId: 'user-1' }));

      await expect(
        runInTenant(() =>
          service.assignRoleToMembership('user-1', {
            membershipId: 'membership-1',
            roleId: 'role-1',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a cross-tenant roleId (scoped lookup returns null) with 404', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValueOnce(null);

      await expect(
        runInTenant(() =>
          service.assignRoleToMembership('user-1', {
            membershipId: 'membership-1',
            roleId: 'role-other-tenant',
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects assigning the owner role when the actor is not an owner', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      const ownerRole = role({ key: 'owner' });
      mockFindUnique
        .mockResolvedValueOnce(ownerRole)
        .mockResolvedValueOnce(membership());
      mockGetPermissions.mockResolvedValue({ isOwner: false, keys: [] });

      await expect(
        runInTenant(() =>
          service.assignRoleToMembership('user-1', {
            membershipId: 'membership-1',
            roleId: 'role-1',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects demoting the last owner of the tenant', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      const currentMembership = membership({
        userId: 'user-2',
        role: { key: 'owner' },
      });
      mockFindUnique
        .mockResolvedValueOnce(role({ key: 'custom' }))
        .mockResolvedValueOnce(currentMembership);
      mockTransaction.mockImplementation(async (cb) =>
        cb({ membership: { update: mockUpdate }, $queryRaw: mockQueryRaw }),
      );
      mockQueryRaw.mockResolvedValue([{ id: 'owner-membership-1' }]);

      await expect(
        runInTenant(() =>
          service.assignRoleToMembership('user-1', {
            membershipId: 'membership-1',
            roleId: 'role-1',
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('demotes an owner when another active owner remains', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      const currentMembership = membership({
        userId: 'user-2',
        role: { key: 'owner' },
      });
      mockFindUnique
        .mockResolvedValueOnce(role({ key: 'custom' }))
        .mockResolvedValueOnce(currentMembership);
      mockTransaction.mockImplementation(async (cb) =>
        cb({ membership: { update: mockUpdate }, $queryRaw: mockQueryRaw }),
      );
      mockQueryRaw.mockResolvedValue([
        { id: 'owner-membership-1' },
        { id: 'owner-membership-2' },
      ]);
      mockUpdate.mockResolvedValue({
        id: 'membership-1',
        roleId: 'role-1',
      });

      const result = await runInTenant(() =>
        service.assignRoleToMembership('user-1', {
          membershipId: 'membership-1',
          roleId: 'role-1',
        }),
      );

      expect(result).toEqual({ id: 'membership-1', roleId: 'role-1' });
      expect(mockQueryRaw).toHaveBeenCalled();
      expect(mockClearMemo).toHaveBeenCalled();
    });
  });

  describe('permission enforcement', () => {
    it('requires role:manage for create, update and delete', async () => {
      mockAssertPermissions.mockRejectedValue(new ForbiddenException());

      await expect(
        runInTenant(() =>
          service.createRole('user-1', {
            key: 'custom',
            name: 'Custom',
            permissionIds: ['perm-a'],
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockAssertPermissions).toHaveBeenCalledWith('user-1', {
        mode: 'ALL',
        permissions: ['role:manage'],
      });
    });

    it('requires role:read for list and get', async () => {
      mockAssertPermissions.mockRejectedValue(new ForbiddenException());

      await expect(
        runInTenant(() => service.listRoles('user-1')),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockAssertPermissions).toHaveBeenCalledWith('user-1', {
        mode: 'ALL',
        permissions: ['role:read'],
      });
    });
  });
});
