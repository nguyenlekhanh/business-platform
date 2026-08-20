import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PERMISSIONS } from './permission-catalog';
import { PermissionService } from './permission.service';

describe('PermissionService', () => {
  let service: PermissionService;
  let tenantContext: TenantContextService;
  const mockFindUnique = jest.fn();

  const ownerRole = () => ({
    key: 'owner',
    permissions: [],
  });

  const roleWith = (keys: string[]) => ({
    key: 'custom',
    permissions: keys.map((key) => ({ permission: { key } })),
  });

  const membership = (role: unknown, status = 'ACTIVE') => ({
    id: 'membership-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    roleId: 'role-1',
    status,
    role,
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    tenantContext = new TenantContextService();

    const moduleRef = await Test.createTestingModule({
      providers: [
        PermissionService,
        {
          provide: PrismaService,
          useValue: { membership: { findUnique: mockFindUnique } },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();

    service = moduleRef.get(PermissionService);
  });

  const runInTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run('tenant-1', fn);

  it('returns owner semantics for a member with the owner role', async () => {
    mockFindUnique.mockResolvedValue(membership(ownerRole()));

    const snapshot = await runInTenant(() => service.getPermissions('user-1'));
    expect(snapshot).toEqual({ isOwner: true, keys: [] });
  });

  it('returns the permission keys of the members role', async () => {
    mockFindUnique.mockResolvedValue(
      membership(roleWith([PERMISSIONS.STORE_READ, PERMISSIONS.REPORT_READ])),
    );

    const snapshot = await runInTenant(() => service.getPermissions('user-1'));
    expect(snapshot).toEqual({
      isOwner: false,
      keys: [PERMISSIONS.STORE_READ, PERMISSIONS.REPORT_READ],
    });
  });

  it('returns no permissions for an INACTIVE membership', async () => {
    mockFindUnique.mockResolvedValue(membership(roleWith([]), 'SUSPENDED'));

    const snapshot = await runInTenant(() => service.getPermissions('user-1'));
    expect(snapshot).toEqual({ isOwner: false, keys: [] });
  });

  it('returns no permissions when there is no membership', async () => {
    mockFindUnique.mockResolvedValue(null);

    const snapshot = await runInTenant(() => service.getPermissions('user-1'));
    expect(snapshot).toEqual({ isOwner: false, keys: [] });
  });

  it('queries the membership scoped to the active tenant context', async () => {
    mockFindUnique.mockResolvedValue(null);

    await runInTenant(() => service.getPermissions('user-1'));

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { userId_tenantId: { userId: 'user-1', tenantId: 'tenant-1' } },
      select: expect.objectContaining({}) as object,
    });
  });

  it('assertPermissions passes when all required permissions are held', async () => {
    mockFindUnique.mockResolvedValue(
      membership(roleWith([PERMISSIONS.STORE_READ, PERMISSIONS.REPORT_READ])),
    );

    await expect(
      runInTenant(() =>
        service.assertPermissions('user-1', {
          mode: 'ALL',
          permissions: [PERMISSIONS.STORE_READ, PERMISSIONS.REPORT_READ],
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('assertPermissions ALL fails when one required permission is missing', async () => {
    mockFindUnique.mockResolvedValue(
      membership(roleWith([PERMISSIONS.STORE_READ])),
    );

    await expect(
      runInTenant(() =>
        service.assertPermissions('user-1', {
          mode: 'ALL',
          permissions: [PERMISSIONS.STORE_READ, PERMISSIONS.REPORT_READ],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('assertPermissions ANY passes when at least one permission is held', async () => {
    mockFindUnique.mockResolvedValue(
      membership(roleWith([PERMISSIONS.STORE_READ])),
    );

    await expect(
      runInTenant(() =>
        service.assertPermissions('user-1', {
          mode: 'ANY',
          permissions: [PERMISSIONS.REPORT_READ, PERMISSIONS.STORE_READ],
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('assertPermissions ANY fails when none of the permissions are held', async () => {
    mockFindUnique.mockResolvedValue(membership(roleWith([])));

    await expect(
      runInTenant(() =>
        service.assertPermissions('user-1', {
          mode: 'ANY',
          permissions: [PERMISSIONS.REPORT_READ, PERMISSIONS.SETTINGS_READ],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('owner passes any assertion', async () => {
    mockFindUnique.mockResolvedValue(membership(ownerRole()));

    await expect(
      runInTenant(() =>
        service.assertPermissions('user-1', {
          mode: 'ALL',
          permissions: [PERMISSIONS.STORE_MANAGE, PERMISSIONS.ROLE_MANAGE],
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('requires a tenant context and fails closed otherwise', async () => {
    await expect(service.getPermissions('user-1')).rejects.toThrow();
  });

  it('memoizes the snapshot within a single request', async () => {
    mockFindUnique.mockResolvedValue(
      membership(roleWith([PERMISSIONS.STORE_READ])),
    );

    await runInTenant(async () => {
      const first = await service.getPermissions('user-1');
      const second = await service.getPermissions('user-1');
      expect(second).toBe(first);
      expect(mockFindUnique).toHaveBeenCalledTimes(1);
    });
  });

  it('clearMemo forces a fresh snapshot on the next lookup', async () => {
    mockFindUnique.mockResolvedValueOnce(
      membership(roleWith([PERMISSIONS.STORE_READ])),
    );
    mockFindUnique.mockResolvedValueOnce(membership(roleWith([])));

    await runInTenant(async () => {
      const before = await service.getPermissions('user-1');
      expect(before.keys).toEqual([PERMISSIONS.STORE_READ]);

      service.clearMemo();
      const after = await service.getPermissions('user-1');
      expect(after.keys).toEqual([]);
      expect(mockFindUnique).toHaveBeenCalledTimes(2);
    });
  });
});
