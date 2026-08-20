import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PermissionService } from '../rbac/permission.service';
import { MemberService } from './member.service';

describe('MemberService', () => {
  let service: MemberService;
  let tenantContext: TenantContextService;

  const mockFindMany = jest.fn();
  const mockFindUnique = jest.fn();
  const mockUpdate = jest.fn();
  const mockTransaction = jest.fn<
    Promise<unknown>,
    [(tx: TxClient) => Promise<unknown>]
  >();
  const mockQueryRaw = jest.fn();
  const mockAssertPermissions = jest.fn();
  const mockClearMemo = jest.fn();

  interface TxClient {
    membership?: { update: typeof mockUpdate };
    $queryRaw?: typeof mockQueryRaw;
  }

  const member = (overrides: Record<string, unknown> = {}) => ({
    id: 'membership-1',
    userId: 'user-2',
    status: 'ACTIVE',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    user: {
      id: 'user-2',
      email: 'user-2@example.com',
      firstName: 'User',
      lastName: 'Two',
    },
    role: { id: 'role-1', key: 'employee', name: 'Employee', isSystem: true },
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    tenantContext = new TenantContextService();

    const moduleRef = await Test.createTestingModule({
      providers: [
        MemberService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: mockTransaction,
            membership: {
              findMany: mockFindMany,
              findUnique: mockFindUnique,
              update: mockUpdate,
            },
          },
        },
        {
          provide: PermissionService,
          useValue: {
            assertPermissions: mockAssertPermissions,
            clearMemo: mockClearMemo,
          },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();

    service = moduleRef.get(MemberService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  describe('listMembers', () => {
    it('returns member summaries for the tenant', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindMany.mockResolvedValue([
        member(),
        member({ id: 'membership-2' }),
      ]);

      const result = await runInTenant(() => service.listMembers('user-1'));

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        membershipId: 'membership-1',
        userId: 'user-2',
        email: 'user-2@example.com',
        role: { key: 'employee' },
        status: 'ACTIVE',
      });
      expect(mockAssertPermissions).toHaveBeenCalledWith('user-1', {
        mode: 'ALL',
        permissions: ['member:read'],
      });
    });

    it('requires member:read', async () => {
      mockAssertPermissions.mockRejectedValue(new ForbiddenException());

      await expect(
        runInTenant(() => service.listMembers('user-1')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('getMember', () => {
    it('returns a single member by user id', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValue(member());

      const result = await runInTenant(() =>
        service.getMember('user-1', 'user-2'),
      );

      expect(result).toMatchObject({
        membershipId: 'membership-1',
        userId: 'user-2',
      });
      expect(mockFindUnique).toHaveBeenCalledWith({
        where: {
          userId_tenantId: { userId: 'user-2', tenantId: 'tenant-1' },
        },
        include: expect.objectContaining({}) as object,
      });
    });

    it('returns 404 when the user is not a member of the tenant', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() => service.getMember('user-1', 'user-unknown')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('requires member:read', async () => {
      mockAssertPermissions.mockRejectedValue(new ForbiddenException());

      await expect(
        runInTenant(() => service.getMember('user-1', 'user-2')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('updateMemberStatus', () => {
    it('suspends a non-owner member without the owner lock', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValue(member());
      mockUpdate.mockResolvedValue(member({ status: 'SUSPENDED' }));

      const result = await runInTenant(() =>
        service.updateMemberStatus('user-1', 'membership-1', {
          status: 'SUSPENDED',
        }),
      );

      expect(result.status).toBe('SUSPENDED');
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'membership-1' },
        data: { status: 'SUSPENDED' },
        include: expect.objectContaining({}) as object,
      });
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockClearMemo).toHaveBeenCalled();
    });

    it('reactivates a suspended non-owner member', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValue(member({ status: 'SUSPENDED' }));
      mockUpdate.mockResolvedValue(member({ status: 'ACTIVE' }));

      const result = await runInTenant(() =>
        service.updateMemberStatus('user-1', 'membership-1', {
          status: 'ACTIVE',
        }),
      );

      expect(result.status).toBe('ACTIVE');
    });

    it('requires member:manage', async () => {
      mockAssertPermissions.mockRejectedValue(new ForbiddenException());

      await expect(
        runInTenant(() =>
          service.updateMemberStatus('user-1', 'membership-1', {
            status: 'SUSPENDED',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns 404 when the membership does not exist', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValue(null);

      await expect(
        runInTenant(() =>
          service.updateMemberStatus('user-1', 'membership-missing', {
            status: 'SUSPENDED',
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects changing your own membership status with 403', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValue(member({ userId: 'user-1' }));

      await expect(
        runInTenant(() =>
          service.updateMemberStatus('user-1', 'membership-1', {
            status: 'SUSPENDED',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('suspends an owner through the last-active-owner lock when another owner remains', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique
        .mockResolvedValueOnce(
          member({
            userId: 'user-2',
            role: {
              id: 'role-o',
              key: 'owner',
              name: 'Owner',
              isSystem: true,
            },
          }),
        )
        .mockResolvedValueOnce(
          member({
            userId: 'user-2',
            role: {
              id: 'role-o',
              key: 'owner',
              name: 'Owner',
              isSystem: true,
            },
            status: 'SUSPENDED',
          }),
        );
      mockTransaction.mockImplementation(async (cb) =>
        cb({ membership: { update: mockUpdate }, $queryRaw: mockQueryRaw }),
      );
      mockQueryRaw.mockResolvedValue([{ id: 'o-1' }, { id: 'o-2' }]);
      mockUpdate.mockResolvedValue({ id: 'membership-1' });

      const result = await runInTenant(() =>
        service.updateMemberStatus('user-1', 'membership-1', {
          status: 'SUSPENDED',
        }),
      );

      expect(result.status).toBe('SUSPENDED');
      expect(mockTransaction).toHaveBeenCalled();
      expect(mockQueryRaw).toHaveBeenCalled();
      expect(mockClearMemo).toHaveBeenCalled();
    });

    it('rejects suspending the last active owner with 409', async () => {
      mockAssertPermissions.mockResolvedValue(undefined);
      mockFindUnique.mockResolvedValue(
        member({
          userId: 'user-2',
          role: { id: 'role-o', key: 'owner', name: 'Owner', isSystem: true },
        }),
      );
      mockTransaction.mockImplementation(async (cb) =>
        cb({ membership: { update: mockUpdate }, $queryRaw: mockQueryRaw }),
      );
      mockQueryRaw.mockResolvedValue([{ id: 'o-1' }]);

      await expect(
        runInTenant(() =>
          service.updateMemberStatus('user-1', 'membership-1', {
            status: 'SUSPENDED',
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
