import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PERMISSIONS } from './permission-catalog';
import { PermissionRequirement } from './permission.decorator';
import { PermissionService } from './permission.service';
import { PermissionsGuard } from './permissions.guard';

describe('PermissionsGuard', () => {
  let guard: PermissionsGuard;
  let tenantContext: TenantContextService;
  const mockReflect = jest.fn();
  const mockAssert = jest.fn();

  const context = (tenantId?: string, userId = 'user-1'): ExecutionContext =>
    ({
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({
          user: { userId },
          tenant: tenantId ? { id: tenantId } : undefined,
        }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(async () => {
    jest.clearAllMocks();
    tenantContext = new TenantContextService();

    const moduleRef = await Test.createTestingModule({
      providers: [
        PermissionsGuard,
        { provide: Reflector, useValue: { getAllAndOverride: mockReflect } },
        {
          provide: PermissionService,
          useValue: { assertPermissions: mockAssert },
        },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();

    guard = moduleRef.get(PermissionsGuard);
  });

  it('allows requests with no permission requirement', async () => {
    mockReflect.mockReturnValue(undefined);

    await expect(guard.canActivate(context('tenant-1'))).resolves.toBe(true);
    expect(mockAssert).not.toHaveBeenCalled();
  });

  it('allows requests with an empty permission requirement', async () => {
    mockReflect.mockReturnValue({ mode: 'ALL', permissions: [] });

    await expect(guard.canActivate(context('tenant-1'))).resolves.toBe(true);
    expect(mockAssert).not.toHaveBeenCalled();
  });

  it('denies when no tenant was resolved', async () => {
    mockReflect.mockReturnValue({
      mode: 'ALL',
      permissions: [PERMISSIONS.STORE_READ],
    });

    await expect(guard.canActivate(context(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('asserts the required permission inside the resolved tenant context', async () => {
    mockReflect.mockReturnValue({
      mode: 'ALL',
      permissions: [PERMISSIONS.STORE_READ],
    });
    mockAssert.mockResolvedValue(undefined);

    await expect(guard.canActivate(context('tenant-1'))).resolves.toBe(true);

    expect(mockAssert).toHaveBeenCalledTimes(1);
    const calls = mockAssert.mock.calls as Array<
      [string, PermissionRequirement]
    >;
    expect(calls[0][0]).toBe('user-1');
    expect(calls[0][1]).toEqual({
      mode: 'ALL',
      permissions: [PERMISSIONS.STORE_READ],
    });
  });

  it('runs the assertion inside the tenant context', async () => {
    mockReflect.mockReturnValue({
      mode: 'ALL',
      permissions: [PERMISSIONS.STORE_READ],
    });
    let observedTenant: string | undefined;
    mockAssert.mockImplementation(() => {
      observedTenant = tenantContext.getTenantId();
      return Promise.resolve();
    });

    await guard.canActivate(context('tenant-1'));

    expect(observedTenant).toBe('tenant-1');
  });

  it('propagates the ForbiddenException thrown by the permission service', async () => {
    mockReflect.mockReturnValue({
      mode: 'ALL',
      permissions: [PERMISSIONS.STORE_READ],
    });
    mockAssert.mockRejectedValue(
      new ForbiddenException('Insufficient permissions'),
    );

    await expect(guard.canActivate(context('tenant-1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
