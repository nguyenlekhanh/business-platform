import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PERMISSIONS, SYSTEM_ROLE_KEYS } from '../rbac/permission-catalog';
import { PermissionService } from '../rbac/permission.service';
import { CreateMemberDto } from './dto/create-member.dto';
import { MemberService } from './member.service';

const DEFAULT_ROLE_NOT_FOUND = 'Default role not found';

describe('MemberService.createMember', () => {
  let service: MemberService;
  let tenantContext: TenantContextService;
  let permissionService: {
    assertPermissions: jest.Mock;
    getPermissions: jest.Mock;
    clearMemo: jest.Mock;
  };

  const mockUserUpsert = jest.fn();
  const mockRoleFindUnique = jest.fn();
  const mockRoleFindFirst = jest.fn();
  const mockMembershipFindUnique = jest.fn();
  const mockMembershipCreate = jest.fn();
  const mockTransaction = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();

    tenantContext = new TenantContextService();

    permissionService = {
      assertPermissions: jest.fn().mockResolvedValue(undefined),
      getPermissions: jest.fn(),
      clearMemo: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MemberService,
        {
          provide: PrismaService,
          useValue: {
            user: { upsert: mockUserUpsert },
            role: {
              findUnique: mockRoleFindUnique,
              findFirst: mockRoleFindFirst,
            },
            membership: {
              findUnique: mockMembershipFindUnique,
              create: mockMembershipCreate,
            },
            $transaction: mockTransaction,
          },
        },
        { provide: PermissionService, useValue: permissionService },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();

    service = moduleRef.get(MemberService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  const tenantScopedRole = (overrides: Record<string, unknown> = {}) => ({
    id: 'role-1',
    key: SYSTEM_ROLE_KEYS.EMPLOYEE,
    isSystem: true,
    ...overrides,
  });

  const fullMembership = (overrides: Record<string, unknown> = {}) => ({
    id: 'm-1',
    userId: 'new-user-1',
    tenantId: 'tenant-1',
    user: {
      id: 'new-user-1',
      email: 'invite@example.com',
      firstName: null,
      lastName: null,
    },
    role: {
      id: 'role-1',
      key: SYSTEM_ROLE_KEYS.EMPLOYEE,
      name: 'Employee',
      isSystem: true,
    },
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  const dto = (overrides: Partial<CreateMemberDto> = {}): CreateMemberDto => ({
    email: 'INVITE@Example.COM',
    firstName: 'Invite',
    lastName: 'User',
    ...overrides,
  });

  const txClient = {
    user: { upsert: mockUserUpsert },
    role: { findUnique: mockRoleFindUnique, findFirst: mockRoleFindFirst },
    membership: {
      findUnique: mockMembershipFindUnique,
      create: mockMembershipCreate,
    },
  };

  /** Runs the service call through a $transaction mock that executes the
   *  callback against txClient, preserving tenant-scoped context. */
  const withTx = <T>(fn: () => Promise<T>): Promise<T> => {
    mockTransaction.mockImplementation(
      async (cb: (tx: typeof txClient) => Promise<unknown>) => cb(txClient),
    );
    return fn();
  };

  describe('permission gate', () => {
    it('asserts member:manage with ALL mode', async () => {
      await runInTenant(async () => {
        mockRoleFindFirst.mockResolvedValue(tenantScopedRole());
        mockUserUpsert.mockResolvedValue({ id: 'new-user-1' });
        mockMembershipFindUnique.mockResolvedValue(null);
        mockMembershipCreate.mockResolvedValue(fullMembership());
        await withTx(() =>
          service.createMember('actor-1', dto({ roleId: undefined })),
        );
      });

      expect(permissionService.assertPermissions).toHaveBeenCalledWith(
        'actor-1',
        { mode: 'ALL', permissions: [PERMISSIONS.MEMBER_MANAGE] },
      );
    });
  });

  describe('role resolution', () => {
    it('defaults to the tenant employee role when roleId omitted', async () => {
      await runInTenant(async () => {
        mockRoleFindFirst.mockResolvedValue(tenantScopedRole());
        mockUserUpsert.mockResolvedValue({ id: 'new-user-1' });
        mockMembershipFindUnique.mockResolvedValue(null);
        mockMembershipCreate.mockResolvedValue(fullMembership());
        await withTx(() =>
          service.createMember('actor-1', dto({ roleId: undefined })),
        );
      });

      expect(mockRoleFindFirst).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-1',
          key: SYSTEM_ROLE_KEYS.EMPLOYEE,
          isSystem: true,
        },
        select: { id: true, key: true, isSystem: true },
      });
    });

    it('resolves an explicit roleId', async () => {
      await runInTenant(async () => {
        mockRoleFindUnique.mockResolvedValue(tenantScopedRole());
        mockUserUpsert.mockResolvedValue({ id: 'new-user-1' });
        mockMembershipFindUnique.mockResolvedValue(null);
        mockMembershipCreate.mockResolvedValue(fullMembership());
        await withTx(() =>
          service.createMember('actor-1', dto({ roleId: 'role-9' })),
        );
      });

      expect(mockRoleFindUnique).toHaveBeenCalledWith({
        where: { tenantId_id: { tenantId: 'tenant-1', id: 'role-9' } },
        select: { id: true, key: true, isSystem: true },
      });
      expect(mockRoleFindFirst).not.toHaveBeenCalled();
    });

    it('rejects a cross-tenant/missing role with 404 (explicit roleId)', async () => {
      await runInTenant(async () => {
        mockRoleFindUnique.mockResolvedValue(null);
        await expect(
          service.createMember('actor-1', dto({ roleId: 'cross-tenant-role' })),
        ).rejects.toThrow(NotFoundException);
      });
    });

    it('rejects missing default employee role with 404', async () => {
      await runInTenant(async () => {
        mockRoleFindFirst.mockResolvedValue(null);
        await expect(
          service.createMember('actor-1', dto({ roleId: undefined })),
        ).rejects.toThrow(new RegExp(DEFAULT_ROLE_NOT_FOUND));
      });
    });
  });

  describe('owner assignment protection', () => {
    beforeEach(() => {
      mockUserUpsert.mockResolvedValue({ id: 'new-user-1' });
      mockMembershipFindUnique.mockResolvedValue(null);
      mockMembershipCreate.mockResolvedValue(fullMembership());
    });

    it('allows owner to assign owner', async () => {
      permissionService.getPermissions.mockResolvedValue({
        isOwner: true,
        keys: [],
      });
      await runInTenant(async () => {
        mockRoleFindUnique.mockResolvedValue({
          id: 'owner-role',
          key: SYSTEM_ROLE_KEYS.OWNER,
          isSystem: true,
        });
        await withTx(() =>
          service.createMember('owner-1', dto({ roleId: 'owner-role' })),
        );
      });
    });

    it.each([
      ['admin', { isOwner: false, keys: [PERMISSIONS.MEMBER_MANAGE] }],
      ['admin-without-manage', { isOwner: false, keys: [] }],
    ])('denies non-owner %s from assigning owner', async (_label, snapshot) => {
      permissionService.getPermissions.mockResolvedValue(snapshot);
      await runInTenant(async () => {
        mockRoleFindUnique.mockResolvedValue({
          id: 'owner-role',
          key: SYSTEM_ROLE_KEYS.OWNER,
          isSystem: true,
        });
        await expect(
          service.createMember('admin-1', dto({ roleId: 'owner-role' })),
        ).rejects.toThrow(ForbiddenException);
        expect(permissionService.getPermissions).toHaveBeenCalledWith(
          'admin-1',
        );
      });
    });
  });

  describe('user resolution', () => {
    beforeEach(() => {
      mockUserUpsert.mockResolvedValue({ id: 'new-user-1' });
      mockMembershipFindUnique.mockResolvedValue(null);
      mockMembershipCreate.mockResolvedValue(fullMembership());
    });

    it('normalizes email before resolving the user (trim + lowercase)', async () => {
      await runInTenant(async () => {
        mockRoleFindFirst.mockResolvedValue(tenantScopedRole());
        await withTx(() =>
          service.createMember(
            'actor-1',
            dto({ email: '  Invite@Example.COM  ' }),
          ),
        );
      });

      expect(mockUserUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'invite@example.com' } }),
      );
    });

    it('reuses an existing User instead of duplicating', async () => {
      await runInTenant(async () => {
        mockRoleFindFirst.mockResolvedValue(tenantScopedRole());
        mockUserUpsert.mockResolvedValue({ id: 'existing-user-1' });
        await withTx(() => service.createMember('actor-1', dto()));
      });

      expect(mockUserUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: {
            email: 'invite@example.com',
            firstName: 'Invite',
            lastName: 'User',
          },
        }),
      );
    });
  });

  describe('self-onboarding protection', () => {
    it('rejects onboarding the actor themselves with 403', async () => {
      await runInTenant(async () => {
        mockRoleFindFirst.mockResolvedValue(tenantScopedRole());
        mockMembershipFindUnique.mockResolvedValue(null);
        mockUserUpsert.mockResolvedValue({ id: 'actor-1' });
        mockTransaction.mockImplementation(
          async (cb: (tx: typeof txClient) => Promise<unknown>) => cb(txClient),
        );
        await expect(
          withTx(() =>
            service.createMember(
              'actor-1',
              dto({ email: 'actor-me@example.com' }),
            ),
          ),
        ).rejects.toThrow(ForbiddenException);
      });
    });
  });

  describe('duplicate membership', () => {
    it('rejects an existing membership for the same user+tenant with 409', async () => {
      await runInTenant(async () => {
        mockRoleFindFirst.mockResolvedValue(tenantScopedRole());
        mockUserUpsert.mockResolvedValue({ id: 'user-1' });
        mockMembershipFindUnique.mockResolvedValue({
          id: 'existing-membership',
        });
        await expect(
          withTx(() => service.createMember('actor-1', dto())),
        ).rejects.toThrow(ConflictException);
      });
    });
  });

  describe('transactional integrity', () => {
    it('rolls back the entire transaction when user upsert fails with P2002', async () => {
      await runInTenant(async () => {
        mockRoleFindFirst.mockResolvedValue(tenantScopedRole());
        mockUserUpsert.mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        );
        mockTransaction.mockImplementation(
          async (cb: (tx: typeof txClient) => Promise<unknown>) => cb(txClient),
        );
        await expect(service.createMember('actor-1', dto())).rejects.toThrow(
          ConflictException,
        );
        expect(mockMembershipCreate).not.toHaveBeenCalled();
      });
    });
  });

  describe('tenant context', () => {
    it('fails closed outside a tenant context', async () => {
      await expect(service.createMember('actor-1', dto())).rejects.toThrow();
    });

    it('never writes a client-supplied tenantId into the membership', async () => {
      await runInTenant(async () => {
        mockRoleFindUnique.mockResolvedValue(
          tenantScopedRole({ id: 'role-1' }),
        );
        mockUserUpsert.mockResolvedValue({ id: 'new-user-1' });
        mockMembershipFindUnique.mockResolvedValue(null);
        mockMembershipCreate.mockResolvedValue(
          fullMembership({ userId: 'new-user-1' }),
        );
        await withTx(() =>
          service.createMember('actor-1', dto({ roleId: 'role-1' })),
        );
      });

      const createCalls = mockMembershipCreate.mock.calls as unknown as Array<
        [
          {
            data: Record<string, unknown>;
          },
        ]
      >;
      const createCall = createCalls[0][0];
      expect(createCall.data).toEqual({
        userId: 'new-user-1',
        tenantId: 'tenant-1',
        roleId: 'role-1',
      });
      expect(createCall).toHaveProperty('include');
    });
  });
});
