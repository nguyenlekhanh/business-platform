import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('applies defaults for optional values', () => {
    const config = validateEnv({
      DATABASE_URL: 'postgresql://app:app@localhost:5432/app?schema=public',
      JWT_SECRET: 'a-very-long-test-secret-of-at-least-32-characters',
    });

    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.REDIS_HOST).toBe('localhost');
    expect(config.REDIS_PORT).toBe(6379);
    expect(config.REDIS_PASSWORD).toBe('');
    expect(config.REDIS_DB).toBe(0);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.LOG_PRETTY).toBe(true);
    expect(config.JWT_EXPIRES_IN).toBe('15m');
  });

  it('coerces string values into their typed equivalents', () => {
    const config = validateEnv({
      NODE_ENV: 'production',
      PORT: '8080',
      DATABASE_URL: 'postgresql://app:app@db:5432/app?schema=public',
      REDIS_HOST: 'redis',
      REDIS_PORT: '6380',
      REDIS_DB: '2',
      LOG_LEVEL: 'debug',
      LOG_PRETTY: 'false',
      JWT_SECRET: 'a-very-long-test-secret-of-at-least-32-characters',
      JWT_EXPIRES_IN: '1h',
    });

    expect(config.NODE_ENV).toBe('production');
    expect(config.PORT).toBe(8080);
    expect(config.REDIS_PORT).toBe(6380);
    expect(config.REDIS_DB).toBe(2);
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.LOG_PRETTY).toBe(false);
    expect(config.JWT_SECRET).toBe(
      'a-very-long-test-secret-of-at-least-32-characters',
    );
    expect(config.JWT_EXPIRES_IN).toBe('1h');
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => validateEnv({})).toThrow(/Invalid environment configuration/);
  });

  it('throws when DATABASE_URL is not a postgres URL', () => {
    expect(() =>
      validateEnv({ DATABASE_URL: 'mysql://app:app@localhost/app' }),
    ).toThrow(/Invalid environment configuration/);
  });

  it('throws when NODE_ENV is not one of the allowed values', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'staging',
        DATABASE_URL: 'postgresql://app:app@localhost:5432/app?schema=public',
      }),
    ).toThrow(/Invalid environment configuration/);
  });

  it('throws when LOG_LEVEL is not a supported pino level', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://app:app@localhost:5432/app?schema=public',
        JWT_SECRET: 'a-very-long-test-secret-of-at-least-32-characters',
        LOG_LEVEL: 'verbose',
      }),
    ).toThrow(/Invalid environment configuration/);
  });

  it('throws when JWT_SECRET is missing', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://app:app@localhost:5432/app?schema=public',
      }),
    ).toThrow(/Invalid environment configuration/);
  });

  it('throws when JWT_SECRET is shorter than 32 characters', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://app:app@localhost:5432/app?schema=public',
        JWT_SECRET: 'too-short',
      }),
    ).toThrow(/Invalid environment configuration/);
  });
});
