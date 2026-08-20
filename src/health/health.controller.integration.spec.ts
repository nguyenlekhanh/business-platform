import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../app.module';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';

interface HealthComponent {
  status: 'up' | 'down';
  error?: string;
}

interface HealthPayload {
  status: 'ok' | 'error';
  info: Record<string, HealthComponent>;
  error: Record<string, HealthComponent>;
  details: Record<string, HealthComponent>;
}

describe('GET /health (integration)', () => {
  let app: INestApplication;

  const buildApp = async (overrides: {
    prismaQueryRaw: jest.Mock;
    redisPing: jest.Mock;
  }) => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ $queryRaw: overrides.prismaQueryRaw })
      .overrideProvider(RedisService)
      .useValue({ ping: overrides.redisPing })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    return app;
  };

  const httpServer = () => app.getHttpServer() as unknown as Server;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('returns 200 with database and redis up when dependencies are healthy', async () => {
    await buildApp({
      prismaQueryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      redisPing: jest.fn().mockResolvedValue(true),
    });

    const response = await request(httpServer()).get('/health');
    const body = response.body as HealthPayload;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      info: {
        database: { status: 'up' },
        redis: { status: 'up' },
      },
      error: {},
      details: {
        database: { status: 'up' },
        redis: { status: 'up' },
      },
    });
  });

  it('returns 503 with database down when the database is unreachable', async () => {
    await buildApp({
      prismaQueryRaw: jest
        .fn()
        .mockRejectedValue(new Error('connection refused')),
      redisPing: jest.fn().mockResolvedValue(true),
    });

    const response = await request(httpServer()).get('/health');
    const body = response.body as HealthPayload;

    expect(response.status).toBe(503);
    expect(body.status).toBe('error');
    expect(body.details.database.status).toBe('down');
    expect(body.details.redis.status).toBe('up');
  });

  it('returns 503 with redis down when redis is unreachable', async () => {
    await buildApp({
      prismaQueryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      redisPing: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });

    const response = await request(httpServer()).get('/health');
    const body = response.body as HealthPayload;

    expect(response.status).toBe(503);
    expect(body.status).toBe('error');
    expect(body.details.database.status).toBe('up');
    expect(body.details.redis.status).toBe('down');
  });

  it('returns a structured 404 through the global exception filter for unknown routes', async () => {
    await buildApp({
      prismaQueryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      redisPing: jest.fn().mockResolvedValue(true),
    });

    const response = await request(httpServer()).get('/nope');
    const body = response.body as {
      statusCode: number;
      error: string;
      path: string;
      method: string;
      timestamp: string;
    };

    expect(response.status).toBe(404);
    expect(body).toEqual(
      expect.objectContaining({
        statusCode: 404,
        error: 'Not Found',
        path: '/nope',
        method: 'GET',
      }),
    );
    expect(body).toHaveProperty('timestamp');
  });
});
