import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
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
        {
          provide: PrismaService,
          useValue: {
            user: { findUnique: mockFindUnique, create: mockCreate },
          },
        },
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
    it('returns an access token for valid credentials', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        passwordHash: 'argon2id-hash-value',
        status: 'ACTIVE',
      });
      mockVerify.mockResolvedValue(true);
      mockSignAsync.mockResolvedValue('signed-token');

      const result = await service.login({
        email: 'user@example.com',
        password: 'superSecret123',
      });

      expect(result).toEqual({ accessToken: 'signed-token' });
      expect(mockSignAsync).toHaveBeenCalledWith({ sub: 'user-1' });
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
