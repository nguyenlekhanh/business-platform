import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
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

  it('logs in and returns an access token', async () => {
    const response = await request(httpServer())
      .post('/auth/login')
      .send({ email, password });

    const body = response.body as AuthResponseBody;
    expect(response.status).toBe(200);
    expect(typeof body.accessToken).toBe('string');
    expect((body.accessToken as string).length).toBeGreaterThan(0);
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
});
