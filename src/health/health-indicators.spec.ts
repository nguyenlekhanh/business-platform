import { HealthIndicatorService } from '@nestjs/terminus';
import { PrismaHealthIndicator } from './prisma-health.indicator';
import { RedisHealthIndicator } from './redis-health.indicator';

describe('Health indicators', () => {
  const healthIndicatorService = new HealthIndicatorService();

  describe('PrismaHealthIndicator', () => {
    it('reports healthy when the database answers SELECT 1', async () => {
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      };
      const indicator = new PrismaHealthIndicator(
        prisma as never,
        healthIndicatorService,
      );

      await expect(indicator.isHealthy('database')).resolves.toEqual({
        database: { status: 'up' },
      });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('reports unhealthy when the database query fails', async () => {
      const prisma = {
        $queryRaw: jest.fn().mockRejectedValue(new Error('connection refused')),
      };
      const indicator = new PrismaHealthIndicator(
        prisma as never,
        healthIndicatorService,
      );

      await expect(indicator.isHealthy('database')).resolves.toEqual({
        database: { status: 'down', error: 'connection refused' },
      });
    });
  });

  describe('RedisHealthIndicator', () => {
    it('reports healthy when Redis answers PONG', async () => {
      const redis = { ping: jest.fn().mockResolvedValue(true) };
      const indicator = new RedisHealthIndicator(
        redis as never,
        healthIndicatorService,
      );

      await expect(indicator.isHealthy('redis')).resolves.toEqual({
        redis: { status: 'up' },
      });
      expect(redis.ping).toHaveBeenCalledTimes(1);
    });

    it('reports unhealthy when ping does not return PONG', async () => {
      const redis = { ping: jest.fn().mockResolvedValue(false) };
      const indicator = new RedisHealthIndicator(
        redis as never,
        healthIndicatorService,
      );

      await expect(indicator.isHealthy('redis')).resolves.toEqual({
        redis: { status: 'down', error: 'Redis ping did not return PONG' },
      });
    });

    it('reports unhealthy when the ping throws', async () => {
      const redis = {
        ping: jest.fn().mockRejectedValue(new Error('connection refused')),
      };
      const indicator = new RedisHealthIndicator(
        redis as never,
        healthIndicatorService,
      );

      await expect(indicator.isHealthy('redis')).resolves.toEqual({
        redis: { status: 'down', error: 'connection refused' },
      });
    });
  });
});
