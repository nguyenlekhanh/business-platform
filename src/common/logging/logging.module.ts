import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

/**
 * Configures pino as the application-wide structured logger.
 * Every HTTP request is logged as a single JSON line by pino-http.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        pinoHttp: {
          level: configService.get<string>('LOG_LEVEL'),
          autoLogging: {
            ignore: (request) => request.url === '/health',
          },
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
            ],
            censor: '[redacted]',
          },
          transport:
            configService.get<boolean>('LOG_PRETTY') === true
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
