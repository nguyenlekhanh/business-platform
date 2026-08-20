# SaaS Platform Backend

Modular SaaS platform backend foundation. Phase 1 establishes the infrastructure
layer only — no business domains (auth, users, tenants, products, orders, etc.)
are implemented yet.

## Stack

- NestJS (TypeScript, strict mode)
- PostgreSQL via Prisma
- Redis via ioredis
- Docker Compose for local services
- Swagger/OpenAPI at `/docs`
- Structured JSON logging via pino (nestjs-pino)
- Global exception handling
- Health checks at `/health` (database + redis)
- Jest unit tests and HTTP integration tests

## Project layout

```
src/
  main.ts                                   bootstrap: Swagger, shutdown hooks
  app.module.ts                             composes foundation modules
  common/
    config/env.validation.ts                Joi validation of environment variables
    database/prisma/                        global PrismaModule + PrismaService
    redis/                                  global RedisModule + RedisService
    logging/                                pino structured logging
    filters/                                global exception filter
  health/                                   GET /health (terminus + indicators)
prisma/schema.prisma                        database schema (no models yet)
test/setup-env.ts                           deterministic test environment
```

Future domains will live in their own top-level modules (e.g. `src/domains/<name>/`)
and register themselves in `AppModule`.

## Quick start (Docker Compose)

```bash
cp .env.example .env
docker compose up --build
```

- API: http://localhost:3000
- Health: http://localhost:3000/health
- Swagger: http://localhost:3000/docs
- PostgreSQL: localhost:5432 (user/pass/db `app` by default)
- Redis: localhost:6379

## Local development (without Docker)

Requires a PostgreSQL and Redis instance reachable at the values in `.env`.

```bash
npm install
npx prisma generate
npm run start:dev
```

## Commands

```bash
npm run build             # compile
npm run format            # prettier
npm run lint              # eslint
npm run test:unit         # unit tests
npm run test:integration  # integration tests (boots the app over HTTP)
npm run test:all          # both
npm run test:cov          # unit coverage
npx prisma migrate dev    # create/apply a migration
npx prisma migrate deploy # apply migrations (production)
```

## Environment variables

Validated at startup by `src/common/config/env.validation.ts`; the app refuses to
start on missing or invalid values. See `.env.example`.