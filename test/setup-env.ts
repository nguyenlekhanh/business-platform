/* global process */
process.env.NODE_ENV = 'test';
process.env.PORT = '3100';
process.env.DATABASE_URL =
  'postgresql://app:app@localhost:5432/app?schema=public';
process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';
process.env.REDIS_PASSWORD = '';
process.env.REDIS_DB = '0';
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';
