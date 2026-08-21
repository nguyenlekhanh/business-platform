import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createHash } from 'crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../app.module';
import { PrismaService } from '../common/database/prisma/prisma.service';

describe('Auth (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  interface AuthResponseBody {
    accessToken?: string;
    refreshToken?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    status?: string;
    id?: string;
    message?: string;
  }

  const email = `integration-${Date.now()}@example.com`;
  const password = 's3cretPass!123';
  const emailsToCleanUp: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    if (prisma && emailsToCleanUp.length > 0) {
      await prisma.user
        .deleteMany({ where: { email: { in: emailsToCleanUp } } })
        .catch(() => undefined);
    }
    if (app) {
      await app.close();
    }
  });

  const httpServer = () => app.getHttpServer() as unknown as Server;

  const registerUser = async (userEmail: string, pass: string = password) => {
    emailsToCleanUp.push(userEmail);
    return request(httpServer())
      .post('/auth/register')
      .send({ email: userEmail, password: pass });
  };

  const loginAs = async (userEmail: string, pass: string = password) => {
    const response = await request(httpServer())
      .post('/auth/login')
      .send({ email: userEmail, password: pass });
    return (response.body as AuthResponseBody).accessToken as string;
  };

  const loginAsPair = async (
    userEmail: string,
    pass: string = password,
  ): Promise<{ accessToken: string; refreshToken: string }> => {
    const response = await request(httpServer())
      .post('/auth/login')
      .send({ email: userEmail, password: pass });
    const body = response.body as AuthResponseBody;
    return {
      accessToken: body.accessToken as string,
      refreshToken: body.refreshToken as string,
    };
  };

  const suspendUser = async (userEmail: string) => {
    const user = await prisma.user.findUnique({ where: { email: userEmail } });
    if (!user) {
      throw new Error(`Cannot suspend user ${userEmail}: not found`);
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'SUSPENDED' },
    });
  };

  it('registers a user and returns it without passwordHash', async () => {
    const response = await request(httpServer())
      .post('/auth/register')
      .send({ email, password, firstName: 'Grace', lastName: 'Hopper' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      email,
      firstName: 'Grace',
      lastName: 'Hopper',
      status: 'ACTIVE',
    });
    expect(response.body).toHaveProperty('id');
    expect(response.body).not.toHaveProperty('passwordHash');
    emailsToCleanUp.push(email);
  });

  it('normalizes email on register (trims and lowercases)', async () => {
    const rawEmail = ` MixedCase-${Date.now()}@Example.COM `;
    const expectedEmail = rawEmail.trim().toLowerCase();

    const response = await request(httpServer())
      .post('/auth/register')
      .send({ email: rawEmail, password });

    const body = response.body as AuthResponseBody;
    expect(response.status).toBe(201);
    expect(body.email).toBe(expectedEmail);
    emailsToCleanUp.push(expectedEmail);
  });

  it('logs in and returns an access + refresh token pair', async () => {
    const response = await request(httpServer())
      .post('/auth/login')
      .send({ email, password });

    const body = response.body as AuthResponseBody;
    expect(response.status).toBe(200);
    expect(typeof body.accessToken).toBe('string');
    expect((body.accessToken as string).length).toBeGreaterThan(0);
    expect(typeof body.refreshToken).toBe('string');
    expect((body.refreshToken as string).length).toBeGreaterThan(40);
  });

  it('returns the current user for a valid token', async () => {
    const token = await loginAs(email);

    const response = await request(httpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);

    const body = response.body as AuthResponseBody;
    expect(response.status).toBe(200);
    expect(body.email).toBe(email);
    expect(response.body).not.toHaveProperty('passwordHash');
  });

  it('rejects /auth/me without a token', async () => {
    const response = await request(httpServer()).get('/auth/me');

    expect(response.status).toBe(401);
  });

  it('rejects login with an invalid password', async () => {
    const response = await request(httpServer())
      .post('/auth/login')
      .send({ email, password: 'wrong-password' });

    const body = response.body as AuthResponseBody;
    expect(response.status).toBe(401);
    expect(body.message).toBe('Invalid credentials');
  });

  it('rejects login with a nonexistent user using the same generic message', async () => {
    const response = await request(httpServer())
      .post('/auth/login')
      .send({ email: `nobody-${Date.now()}@example.com`, password });

    const body = response.body as AuthResponseBody;
    expect(response.status).toBe(401);
    expect(body.message).toBe('Invalid credentials');
  });

  it('rejects login for a suspended user', async () => {
    const userEmail = `suspended-${Date.now()}@example.com`;
    await registerUser(userEmail);
    await suspendUser(userEmail);

    const response = await request(httpServer())
      .post('/auth/login')
      .send({ email: userEmail, password });

    const body = response.body as AuthResponseBody;
    expect(response.status).toBe(401);
    expect(body.message).toBe('Invalid credentials');
  });

  it('rejects a previously issued JWT after the user is suspended', async () => {
    const userEmail = `suspended-jwt-${Date.now()}@example.com`;
    await registerUser(userEmail);
    const token = await loginAs(userEmail);

    const before = await request(httpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);

    await suspendUser(userEmail);

    const after = await request(httpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  it('rejects a second registration with a duplicate normalized email as 409', async () => {
    const userEmail = `duplicate-${Date.now()}@example.com`;
    const first = await registerUser(userEmail);
    expect(first.status).toBe(201);

    const second = await request(httpServer())
      .post('/auth/register')
      .send({ email: userEmail.toUpperCase(), password });

    const body = second.body as AuthResponseBody;
    expect(second.status).toBe(409);
    expect(body.message).toBe('Email is already registered');
  });

  it('rejects an expired JWT with 401', async () => {
    const userEmail = `expired-${Date.now()}@example.com`;
    await registerUser(userEmail);
    const user = await prisma.user.findUnique({ where: { email: userEmail } });

    const expiredToken = await jwtService.signAsync(
      { sub: user!.id },
      { expiresIn: -60 },
    );

    const response = await request(httpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(response.status).toBe(401);
  });

  it('rejects a malformed JWT with 401', async () => {
    const response = await request(httpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer not-a-valid-jwt');

    expect(response.status).toBe(401);
  });

  it('refreshes: rotates the token pair and invalidates the presented refresh token', async () => {
    const userEmail = `refresh-${Date.now()}@example.com`;
    await registerUser(userEmail);
    const first = await loginAsPair(userEmail);

    const refreshed = await request(httpServer())
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken });

    const body = refreshed.body as AuthResponseBody;
    expect(refreshed.status).toBe(200);
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    // Refresh material is random -> always differs from the presented token.
    // (Access-token strings may legitimately coincide when issued within the
    // same second, so they are compared via /me below instead.)
    expect(body.refreshToken).not.toBe(first.refreshToken);

    // The rotated pair is bound to the same user (claims read directly so
    // the assertion does not depend on JwtService typing quirks).
    const claims = JSON.parse(
      Buffer.from((body.accessToken ?? '').split('.')[1], 'base64').toString(
        'utf8',
      ),
    ) as { sub: string };
    const user = await prisma.user.findUnique({ where: { email: userEmail } });
    expect(claims.sub).toBe(user!.id);

    // The old refresh token can never be used again (reuse rejected with
    // the same generic error as every other failure class).
    const reuse = await request(httpServer())
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(reuse.status).toBe(401);
    expect((reuse.body as AuthResponseBody).message).toBe(
      'Invalid credentials',
    );

    // The new pair still authenticates.
    const me = await request(httpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`);
    expect(me.status).toBe(200);
  });

  it('rejects an unknown/random refresh token with the generic error', async () => {
    await registerUser(`random-refresh-${Date.now()}@example.com`);

    const response = await request(httpServer())
      .post('/auth/refresh')
      .send({ refreshToken: 'a'.repeat(64) });

    expect(response.status).toBe(401);
    expect((response.body as AuthResponseBody).message).toBe(
      'Invalid credentials',
    );
  });

  it('rejects a malformed refresh request body with 400', async () => {
    const empty = await request(httpServer()).post('/auth/refresh').send({});
    expect(empty.status).toBe(400);

    const wrongType = await request(httpServer())
      .post('/auth/refresh')
      .send({ refreshToken: 12345 });
    expect(wrongType.status).toBe(400);
  });

  it('never persists raw refresh-token material (hash-only storage)', async () => {
    const userEmail = `plaintext-${Date.now()}@example.com`;
    await registerUser(userEmail);
    const { refreshToken } = await loginAsPair(userEmail);

    const user = await prisma.user.findUnique({ where: { email: userEmail } });
    const rows = await prisma.refreshToken.findMany({
      where: { userId: user!.id },
      select: { tokenHash: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tokenHash).not.toBe(refreshToken);
      expect(row.tokenHash).not.toContain(refreshToken.slice(0, 8));
      expect(row.tokenHash).toHaveLength(64); // sha256 hex digest
    }
    expect(
      rows.some(
        (row) =>
          row.tokenHash ===
          createHash('sha256').update(refreshToken).digest('hex'),
      ),
    ).toBe(true);
  });

  it('logout revokes the session and is idempotent without leaking existence info', async () => {
    const userEmail = `logout-${Date.now()}@example.com`;
    await registerUser(userEmail);
    const first = await loginAsPair(userEmail);

    const logout = await request(httpServer())
      .post('/auth/logout')
      .send({ refreshToken: first.refreshToken });
    expect(logout.status).toBe(204);
    expect(logout.text).toBe('');

    // Revoked token cannot be refreshed afterwards.
    const afterLogout = await request(httpServer())
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(afterLogout.status).toBe(401);
    expect((afterLogout.body as AuthResponseBody).message).toBe(
      'Invalid credentials',
    );

    // Repeated logout of the same token stays silently successful.
    const repeat = await request(httpServer())
      .post('/auth/logout')
      .send({ refreshToken: first.refreshToken });
    expect(repeat.status).toBe(204);

    // Unknown tokens get the identical silent success (no oracle).
    const unknown = await request(httpServer())
      .post('/auth/logout')
      .send({ refreshToken: 'never-issued-token' });
    expect(unknown.status).toBe(204);
  });

  it('logout does not affect unrelated sessions of other users', async () => {
    const emailA = `logout-a-${Date.now()}@example.com`;
    const emailB = `logout-b-${Date.now()}@example.com`;
    await registerUser(emailA);
    await registerUser(emailB);
    const sessionA = await loginAsPair(emailA);
    const sessionB = await loginAsPair(emailB);

    const logoutA = await request(httpServer())
      .post('/auth/logout')
      .send({ refreshToken: sessionA.refreshToken });
    expect(logoutA.status).toBe(204);

    const refreshB = await request(httpServer())
      .post('/auth/refresh')
      .send({ refreshToken: sessionB.refreshToken });
    expect(refreshB.status).toBe(200);

    const meB = await request(httpServer())
      .get('/auth/me')
      .set(
        'Authorization',
        `Bearer ${(refreshB.body as AuthResponseBody).accessToken}`,
      );
    expect(meB.status).toBe(200);
    const bodyB = meB.body as AuthResponseBody;
    expect(bodyB.email).toBe(emailB);
  });

  it('keeps stateless access-token auth unchanged across a refresh rotation', async () => {
    const userEmail = `stateless-${Date.now()}@example.com`;
    await registerUser(userEmail);
    const first = await loginAsPair(userEmail);

    const before = await request(httpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${first.accessToken}`);
    expect(before.status).toBe(200);

    const refreshed = await request(httpServer())
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(refreshed.status).toBe(200);

    // The pre-rotation access token remains valid until its own expiry:
    // revocation applies to refresh tokens only.
    const after = await request(httpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${first.accessToken}`);
    expect(after.status).toBe(200);
  });
});
