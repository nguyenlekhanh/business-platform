import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { TenantContextService } from '../../tenant-context/tenant-context.service';
import { PrismaService } from './prisma.service';

const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockDisconnect = jest.fn().mockResolvedValue(undefined);

jest.mock('@prisma/client', () => {
  class MockPrismaClient {
    $connect = mockConnect;
    $disconnect = mockDisconnect;
    $extends = jest.fn(() => new MockPrismaClient());
  }
  return { PrismaClient: MockPrismaClient };
});

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PrismaService, TenantContextService],
    }).compile();

    service = moduleRef.get(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  it('connects to the database on module init', async () => {
    await service.onModuleInit();

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the database is unreachable at startup', async () => {
    mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('disconnects from the database on module destroy', async () => {
    await service.onModuleDestroy();

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it('is an instance of PrismaClient', () => {
    expect(service).toBeInstanceOf(PrismaClient);
  });
});
