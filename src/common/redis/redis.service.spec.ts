import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockQuit = jest.fn().mockResolvedValue(undefined);
const mockPing = jest.fn().mockResolvedValue('PONG');
const mockOn = jest.fn();

jest.mock('ioredis', () => {
  const MockRedis = jest.fn().mockImplementation(function (this: {
    connect: jest.Mock;
    quit: jest.Mock;
    ping: jest.Mock;
    on: jest.Mock;
  }) {
    this.connect = mockConnect;
    this.quit = mockQuit;
    this.ping = mockPing;
    this.on = mockOn;
  });
  return { __esModule: true, default: MockRedis };
});

describe('RedisService', () => {
  let service: RedisService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RedisService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const values: Record<string, unknown> = {
                REDIS_HOST: 'localhost',
                REDIS_PORT: 6379,
                REDIS_DB: 0,
                REDIS_PASSWORD: '',
              };
              return values[key];
            }),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(RedisService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  it('creates an ioredis client', () => {
    expect(Redis).toHaveBeenCalledTimes(1);
    expect(service.client).toBeDefined();
  });

  it('registers an error listener to avoid unhandled error crashes', () => {
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('connects on module init', async () => {
    await service.onModuleInit();

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('does not throw when redis is unreachable at startup', async () => {
    mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('disconnects on module destroy', async () => {
    await service.onModuleDestroy();

    expect(mockQuit).toHaveBeenCalledTimes(1);
  });

  it('ping returns true when Redis answers PONG', async () => {
    mockPing.mockResolvedValue('PONG');

    await expect(service.ping()).resolves.toBe(true);
  });

  it('ping returns false when Redis does not answer PONG', async () => {
    mockPing.mockResolvedValue('NO');

    await expect(service.ping()).resolves.toBe(false);
  });
});
