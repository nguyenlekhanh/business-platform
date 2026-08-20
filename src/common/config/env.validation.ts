import * as Joi from 'joi';

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const envValidationSchema: Joi.ObjectSchema<EnvConfig> = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().integer().port().default(3000),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().integer().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_DB: Joi.number().integer().min(0).default(0),
  LOG_LEVEL: Joi.string()
    .valid(...LOG_LEVELS)
    .default('info'),
  LOG_PRETTY: Joi.boolean().default(true),
});

export interface EnvConfig {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  DATABASE_URL: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD: string;
  REDIS_DB: number;
  LOG_LEVEL: LogLevel;
  LOG_PRETTY: boolean;
}

/**
 * Validates and coerces the raw environment into a typed configuration.
 * Used as the `validate` option of `ConfigModule.forRoot()`.
 */
export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envValidationSchema.validate(config, {
    abortEarly: true,
    convert: true,
    stripUnknown: true,
  });

  if (result.error) {
    throw new Error(
      `Invalid environment configuration: ${result.error.message}`,
    );
  }

  return result.value;
}
