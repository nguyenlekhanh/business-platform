import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;
  private readonly logger = new Logger(RedisService.name);

  constructor(configService: ConfigService) {
    const password = configService.get<string>('REDIS_PASSWORD');

    this.client = new Redis({
      host: configService.get<string>('REDIS_HOST'),
      port: configService.get<number>('REDIS_PORT'),
      db: configService.get<number>('REDIS_DB'),
      password: password && password.length > 0 ? password : undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
    });

    this.client.on('error', (error) => {
      this.logger.warn(`Redis error: ${error.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      this.logger.log('Redis connection established');
    } catch (error) {
      this.logger.warn(
        `Redis connection failed at startup: ${(error as Error).message}. ` +
          'The redis health check will report it as down.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
    this.logger.log('Redis connection closed');
  }

  /** Returns true when Redis answers with PONG. */
  async ping(): Promise<boolean> {
    const result = await this.client.ping();
    return result === 'PONG';
  }
}
