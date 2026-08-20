import { Test } from '@nestjs/testing';
import type { MembershipStatus, Tenant, TenantStatus } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantService } from './tenant.service';

describe('TenantService', () => {
  let service: TenantService;
  const mockFindUnique = jest.fn();

  const tenant = (overrides: Partial<Tenant> = {}): Tenant => ({
    id: 'tenant-1',
    name: 'Acme',
    slug: 'acme',
    status: 'ACTIVE',
    settings: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const membership = (
    overrides: {
      status?: MembershipStatus;
      tenantStatus?: TenantStatus;
    } = {},
  ) => ({
    id: 'membership-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    roleId: 'role-1',
    status: overrides.status ?? 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    tenant: tenant({ status: overrides.tenantStatus ?? 'ACTIVE' }),
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        TenantService,
        {
          provide: PrismaService,
          useValue: { membership: { findUnique: mockFindUnique } },
        },
      ],
    }).compile();

    service = moduleRef.get(TenantService);
  });

  it('returns the tenant for an ACTIVE membership in an ACTIVE tenant', async () => {
    mockFindUnique.mockResolvedValue(membership());

    await expect(service.resolveTenant('user-1', 'tenant-1')).resolves.toEqual(
      tenant(),
    );
  });

  it('returns null when the membership does not exist', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(
      service.resolveTenant('user-1', 'tenant-1'),
    ).resolves.toBeNull();
  });

  it('returns null for an INVITED membership', async () => {
    mockFindUnique.mockResolvedValue(membership({ status: 'INVITED' }));

    await expect(
      service.resolveTenant('user-1', 'tenant-1'),
    ).resolves.toBeNull();
  });

  it('returns null for a SUSPENDED membership', async () => {
    mockFindUnique.mockResolvedValue(membership({ status: 'SUSPENDED' }));

    await expect(
      service.resolveTenant('user-1', 'tenant-1'),
    ).resolves.toBeNull();
  });

  it('returns the tenant for an ACTIVE tenant', async () => {
    mockFindUnique.mockResolvedValue(membership());

    await expect(service.resolveTenant('user-1', 'tenant-1')).resolves.toEqual(
      tenant(),
    );
  });

  it('returns null when the tenant is SUSPENDED', async () => {
    mockFindUnique.mockResolvedValue(membership({ tenantStatus: 'SUSPENDED' }));

    await expect(
      service.resolveTenant('user-1', 'tenant-1'),
    ).resolves.toBeNull();
  });

  it('returns null when the tenant is DISABLED', async () => {
    mockFindUnique.mockResolvedValue(membership({ tenantStatus: 'DISABLED' }));

    await expect(
      service.resolveTenant('user-1', 'tenant-1'),
    ).resolves.toBeNull();
  });

  it('queries by userId + tenantId and includes the tenant relation', async () => {
    mockFindUnique.mockResolvedValue(null);

    await service.resolveTenant('user-1', 'tenant-1');

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { userId_tenantId: { userId: 'user-1', tenantId: 'tenant-1' } },
      include: { tenant: true },
    });
  });
});
