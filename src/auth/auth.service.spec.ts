import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { AuthService } from './auth.service';
import { PasswordHashingService } from './password-hashing.service';
import { SafeUser } from './safe-user';

describe('AuthService', () => {
  let service: AuthService;

  type CreateArg = {
    data: {
      email: string;
      passwordHash: string;
      password?: string;
      firstName?: string;
      lastName?: string;
    };
    select: unknown;
  };

  const mockFindUnique = jest.fn<
    SafeUser | null,
    [{ where: { email: string } | { id: string } }]
  >();
  const mockCreate = jest.fn<SafeUser, [CreateArg]>();
  const mockHash = jest.fn<Promise<string>, [string]>();
  const mockVerify = jest.fn<Promise<boolean>, [string, string]>();
  const mockSignAsync = jest.fn<Promise<string>, [{ sub: string }]>();

  // Refresh-token delegates.
  type RefreshCreateArg = {
    data: { userId: string; tokenHash: string; expiresAt: Date };
  };
  const mockRefreshCreate = jest.fn<unknown, [RefreshCreateArg]>();
  const mockRefreshFindUnique = jest.fn<
    { userId: string } | null,
    [{ where: { tokenHash: string }; select: { userId: true } }]
  >();
  const mockRefreshUpdateMany = jest.fn<
    { count: number },
    [
      {
        where: {
          tokenHash: string;
          revokedAt: null;
          expiresAt?: { gt: unknown };
        };
        data: { revokedAt: unknown };
      },
    ]
  >();

  const prismaMock = {
    user: { findUnique: mockFindUnique, create: mockCreate },
    refreshToken: {
      create: mockRefreshCreate,
      findUnique: mockRefreshFindUnique,
      updateMany: mockRefreshUpdateMany,
    },
  };
  // $transaction receives the transaction client; tests reuse the same
  // delegates so tx.* calls resolve against the identical mocks.
  const prismaStub = {
    ...prismaMock,
    $transaction: (fn: (tx: typeof prismaMock) => Promise<unknown>) =>
      fn(prismaMock),
  } as unknown as PrismaService;

  const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');

  const safeUser = (overrides: Partial<SafeUser> = {}): SafeUser => ({
    id: 'user-1',
    email: 'user@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prismaStub },
        {
          provide: PasswordHashingService,
          useValue: { hash: mockHash, verify: mockVerify },
        },
        { provide: JwtService, useValue: { signAsync: mockSignAsync } },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('register', () => {
    it('normalizes the email before checking and storing it', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockHash.mockResolvedValue('argon2-hash');
      mockCreate.mockResolvedValue(safeUser({ email: 'user@example.com' }));

      await service.register({
        email: '  USER@Example.COM  ',
        password: 'password123',
      });

      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { email: 'user@example.com' },
      });

      const createArg = mockCreate.mock.calls[0]?.[0];
      expect(createArg?.data.email).toBe('user@example.com');
    });

    it('stores an argon2 hash of the password, never the plaintext', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockHash.mockResolvedValue('argon2id-hash-value');
      mockCreate.mockResolvedValue(safeUser());

      await service.register({
        email: 'user@example.com',
        password: 'superSecret123',
      });

      expect(mockHash).toHaveBeenCalledWith('superSecret123');

      const createArg = mockCreate.mock.calls[0]?.[0];
      expect(createArg?.data.passwordHash).toBe('argon2id-hash-value');
      expect(createArg?.data.password).toBeUndefined();
    });

    it('returns the created user without exposing passwordHash', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockHash.mockResolvedValue('argon2id-hash-value');
      mockCreate.mockResolvedValue(safeUser());

      const result = await service.register({
        email: 'user@example.com',
        password: 'superSecret123',
      });

      expect(result).toEqual(safeUser());
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('throws ConflictException when the email is already registered', async () => {
      mockFindUnique.mockResolvedValue(safeUser());

      await expect(
        service.register({
          email: 'user@example.com',
          password: 'superSecret123',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps a database unique-constraint violation to ConflictException', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockHash.mockResolvedValue('argon2id-hash-value');

      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`email`)',
        { code: 'P2002', clientVersion: '6.19.3' },
      );
      mockCreate.mockRejectedValueOnce(p2002);

      await expect(
        service.register({
          email: 'user@example.com',
          password: 'superSecret123',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('login', () => {
    it('returns an access + refresh token pair for valid credentials', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        passwordHash: 'argon2id-hash-value',
        status: 'ACTIVE',
      });
      mockVerify.mockResolvedValue(true);
      mockSignAsync.mockResolvedValue('signed-token');
      mockRefreshCreate.mockResolvedValue({});

      const result = await service.login({
        email: 'user@example.com',
        password: 'superSecret123',
      });

      expect(result.accessToken).toBe('signed-token');
      expect(typeof result.refreshToken).toBe('string');
      expect(result.refreshToken.length).toBeGreaterThan(40);
      expect(mockSignAsync).toHaveBeenCalledWith({ sub: 'user-1' });
      // Only the sha256 hash is persisted, never the raw token material.
      expect(mockRefreshCreate).toHaveBeenCalledTimes(1);
      const persisted = mockRefreshCreate.mock.calls[0][0].data;
      expect(persisted.userId).toBe('user-1');
      expect(persisted.tokenHash).toBe(sha256(result.refreshToken));
      expect(persisted.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('normalizes the email before looking up the user', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        service.login({
          email: '  USER@Example.COM ',
          password: 'superSecret123',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { email: 'user@example.com' },
      });
    });

    it('rejects with a generic message when the password is wrong', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        passwordHash: 'argon2id-hash-value',
        status: 'ACTIVE',
      });
      mockVerify.mockResolvedValue(false);

      await expect(
        service.login({
          email: 'user@example.com',
          password: 'wrongPassword',
        }),
      ).rejects.toEqual(new UnauthorizedException('Invalid credentials'));
    });

    it('rejects with the same generic message when the user does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        service.login({
          email: 'nobody@example.com',
          password: 'whatever123',
        }),
      ).rejects.toEqual(new UnauthorizedException('Invalid credentials'));
      // The dummy verification runs so response timing cannot reveal that
      // the email is not registered.
      expect(mockVerify).toHaveBeenCalled();
    });

    it('rejects a user with no password hash (OAuth-only identity)', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        passwordHash: null,
        status: 'ACTIVE',
      });

      await expect(
        service.login({
          email: 'user@example.com',
          password: 'superSecret123',
        }),
      ).rejects.toEqual(new UnauthorizedException('Invalid credentials'));
    });

    it('rejects a suspended user', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        passwordHash: 'argon2id-hash-value',
        status: 'SUSPENDED',
      });

      await expect(
        service.login({
          email: 'user@example.com',
          password: 'superSecret123',
        }),
      ).rejects.toEqual(new UnauthorizedException('Invalid credentials'));
      expect(mockRefreshCreate).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    const presentedToken = 'presented-refresh-token-material';
    const dto = { refreshToken: presentedToken };

    it('rotates: revokes the presented token, issues a new pair bound to the same user', async () => {
      mockRefreshFindUnique.mockResolvedValue({ userId: 'user-1' });
      mockFindUnique.mockResolvedValue({ id: 'user-1', status: 'ACTIVE' });
      mockRefreshUpdateMany.mockResolvedValue({ count: 1 });
      mockRefreshCreate.mockResolvedValue({});
      mockSignAsync.mockResolvedValue('new-access');

      const result = await service.refresh(dto);

      expect(result.accessToken).toBe('new-access');
      expect(typeof result.refreshToken).toBe('string');
      expect(result.refreshToken).not.toBe(presentedToken);
      expect(mockSignAsync).toHaveBeenCalledWith({ sub: 'user-1' });
      // Old token revoked with the full liveness guard.
      expect(mockRefreshUpdateMany).toHaveBeenCalledTimes(1);
      const revokeCall = mockRefreshUpdateMany.mock.calls[0][0];
      expect(revokeCall.where.tokenHash).toBe(sha256(presentedToken));
      expect(revokeCall.where.revokedAt).toBeNull();
      expect(revokeCall.where.expiresAt?.gt).toBeInstanceOf(Date);
      // New row stores only the hash of the NEW material, same userId.
      const persisted = mockRefreshCreate.mock.calls[0][0].data;
      expect(persisted.userId).toBe('user-1');
      expect(persisted.tokenHash).toBe(sha256(result.refreshToken));
      expect(persisted.tokenHash).not.toBe(sha256(presentedToken));
    });

    it('rejects reuse of a rotated/revoked token with the generic error', async () => {
      mockRefreshFindUnique.mockResolvedValue({ userId: 'user-1' });
      mockFindUnique.mockResolvedValue({ id: 'user-1', status: 'ACTIVE' });
      mockRefreshUpdateMany.mockResolvedValue({ count: 0 });

      await expect(service.refresh(dto)).rejects.toEqual(
        new UnauthorizedException('Invalid credentials'),
      );
      expect(mockSignAsync).not.toHaveBeenCalled();
      expect(mockRefreshCreate).not.toHaveBeenCalled();
    });

    it('rejects an expired token with the generic error', async () => {
      mockRefreshFindUnique.mockResolvedValue({ userId: 'user-1' });
      mockFindUnique.mockResolvedValue({ id: 'user-1', status: 'ACTIVE' });
      mockRefreshUpdateMany.mockResolvedValue({ count: 0 });

      await expect(service.refresh(dto)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      const guard = mockRefreshUpdateMany.mock.calls[0][0].where;
      expect(guard.expiresAt?.gt).toBeInstanceOf(Date);
      expect((guard.expiresAt?.gt as Date).getTime()).toBeLessThanOrEqual(
        Date.now(),
      );
    });

    it('rejects an unknown/random token without revealing existence details', async () => {
      mockRefreshFindUnique.mockResolvedValue(null);

      await expect(
        service.refresh({ refreshToken: 'totally-random-value' }),
      ).rejects.toEqual(new UnauthorizedException('Invalid credentials'));
      expect(mockSignAsync).not.toHaveBeenCalled();
    });

    it('rejects when the owning user no longer exists or is suspended', async () => {
      mockRefreshFindUnique.mockResolvedValue({ userId: 'user-9' });
      mockFindUnique.mockResolvedValue(null);

      await expect(service.refresh(dto)).rejects.toEqual(
        new UnauthorizedException('Invalid credentials'),
      );
      expect(mockRefreshUpdateMany).not.toHaveBeenCalled();
    });

    it('looks up tokens by sha256 hash, never by raw material', async () => {
      mockRefreshFindUnique.mockResolvedValue(null);

      await expect(service.refresh(dto)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(mockRefreshFindUnique).toHaveBeenCalledWith({
        where: { tokenHash: sha256(presentedToken) },
        select: { userId: true },
      });
    });
  });

  describe('logout', () => {
    it('revokes the presented live token and nothing else', async () => {
      mockRefreshUpdateMany.mockResolvedValue({ count: 1 });

      await service.logout({ refreshToken: 'some-live-token' });

      expect(mockRefreshUpdateMany).toHaveBeenCalledTimes(1);
      const logoutCall = mockRefreshUpdateMany.mock.calls[0][0];
      expect(logoutCall.where.tokenHash).toBe(sha256('some-live-token'));
      expect(logoutCall.where.revokedAt).toBeNull();
      expect(logoutCall.data.revokedAt).toBeInstanceOf(Date);
    });

    it('is silently idempotent for unknown or already-revoked tokens', async () => {
      mockRefreshUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.logout({ refreshToken: 'unknown-or-revoked' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('getCurrentUser', () => {
    it('returns the user without exposing passwordHash', async () => {
      mockFindUnique.mockResolvedValue(safeUser());

      const result = await service.getCurrentUser('user-1');

      expect(result).toEqual(safeUser());
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('throws UnauthorizedException when the user does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(service.getCurrentUser('missing-user')).rejects.toEqual(
        new UnauthorizedException('Invalid credentials'),
      );
    });
  });
});
