import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  const configService = {
    get: (key: string) =>
      key === 'JWT_SECRET'
        ? 'a-very-long-test-secret-of-at-least-32-characters'
        : undefined,
    getOrThrow: () => 'a-very-long-test-secret-of-at-least-32-characters',
  } as unknown as ConfigService;

  const mockFindUnique = jest.fn();
  const prismaService = {
    user: { findUnique: mockFindUnique },
  } as unknown as PrismaService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts a token for an existing ACTIVE user', async () => {
    mockFindUnique.mockResolvedValue({ id: 'user-1', status: 'ACTIVE' });

    const strategy = new JwtStrategy(configService, prismaService);

    await expect(strategy.validate({ sub: 'user-1' })).resolves.toEqual({
      userId: 'user-1',
    });
  });

  it('rejects a token for a user that no longer exists', async () => {
    mockFindUnique.mockResolvedValue(null);

    const strategy = new JwtStrategy(configService, prismaService);

    await expect(strategy.validate({ sub: 'user-1' })).rejects.toEqual(
      new UnauthorizedException('Invalid credentials'),
    );
  });

  it('rejects a previously issued token after the user is suspended', async () => {
    mockFindUnique.mockResolvedValue({ id: 'user-1', status: 'SUSPENDED' });

    const strategy = new JwtStrategy(configService, prismaService);

    await expect(strategy.validate({ sub: 'user-1' })).rejects.toEqual(
      new UnauthorizedException('Invalid credentials'),
    );
  });
});
