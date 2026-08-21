import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { normalizeEmail } from '../common/utils/normalize-email.util';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { PasswordHashingService } from './password-hashing.service';
import { JwtPayload } from './jwt.strategy';
import { SafeUser, SAFE_USER_SELECT } from './safe-user';

const GENERIC_AUTH_ERROR = 'Invalid credentials';

// Refresh tokens live for 7 days. Deliberately a plain constant: no session
// management beyond what Phase 2 requires.
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// A fixed Argon2id hash used to equalize the cost of a failed login when the
// user does not exist or has no password hash, preventing a timing
// side-channel that could reveal whether an email is registered.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$ywC4vqqaw6KZ8+QYagqxgQ$s06KgIX7Q8umUZiNAxXlkJE6JhoID2i0reCIF3p+StY';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordHashing: PasswordHashingService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<SafeUser> {
    const email = normalizeEmail(dto.email);

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('Email is already registered');
    }

    const passwordHash = await this.passwordHashing.hash(dto.password);

    try {
      return await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
        },
        select: SAFE_USER_SELECT,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // The database unique constraint is the final authority: a
        // concurrent registration of the same normalized email surfaces
        // here as a unique-constraint violation.
        throw new ConflictException('Email is already registered');
      }
      throw error;
    }
  }

  async login(
    dto: LoginDto,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const email = normalizeEmail(dto.email);

    const user = await this.prisma.user.findUnique({ where: { email } });

    // A single, generic failure for every auth error prevents user
    // enumeration via the response message. The dummy verification runs the
    // same Argon2id work regardless of whether the user exists, so response
    // timing cannot reveal registration status.
    if (!user || !user.passwordHash || user.status !== 'ACTIVE') {
      await this.passwordHashing.verify(DUMMY_PASSWORD_HASH, dto.password);
      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }

    const passwordValid = await this.passwordHashing.verify(
      user.passwordHash,
      dto.password,
    );
    if (!passwordValid) {
      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }

    const payload: JwtPayload = { sub: user.id };
    const accessToken = await this.jwtService.signAsync(payload);

    const refresh = this.createRefreshTokenMaterial();
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      },
    });

    return { accessToken, refreshToken: refresh.token };
  }

  /**
   * Rotates a refresh token: proves possession by hash match, rejects
   * unknown / expired / already-rotated (reused) tokens with the SAME generic
   * error, re-validates the user exactly like JwtStrategy.validate, revokes
   * the presented token and issues a fresh pair. The revoke step re-checks
   * liveness inside the transaction so concurrent reuse of one token can
   * never rotate twice. Only hashes are ever persisted.
   */
  async refresh(
    dto: RefreshDto,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const tokenHash = this.hashToken(dto.refreshToken);
    const now = new Date();

    const rotated = await this.prisma.$transaction(async (tx) => {
      // Fetch first only to resolve the owner for user re-validation.
      const existing = await tx.refreshToken.findUnique({
        where: { tokenHash },
        select: { userId: true },
      });
      if (!existing) {
        throw new UnauthorizedException(GENERIC_AUTH_ERROR);
      }
      const user = await tx.user.findUnique({
        where: { id: existing.userId },
        select: { id: true, status: true },
      });
      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedException(GENERIC_AUTH_ERROR);
      }

      // Race-safe liveness guard: covers revoked (reuse), expired and the
      // concurrent-double-use case in one atomic conditional write.
      const revoked = await tx.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now },
      });
      if (revoked.count === 0) {
        throw new UnauthorizedException(GENERIC_AUTH_ERROR);
      }

      const fresh = this.createRefreshTokenMaterial();
      await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: fresh.tokenHash,
          expiresAt: fresh.expiresAt,
        },
      });
      return { userId: user.id, token: fresh.token };
    });

    const payload: JwtPayload = { sub: rotated.userId };
    const accessToken = await this.jwtService.signAsync(payload);

    return { accessToken, refreshToken: rotated.token };
  }

  /**
   * Revokes the presented refresh token. Idempotent and leak-free: unknown,
   * expired or already-revoked tokens resolve to the same silent success so
   * logout responses reveal nothing about token existence. Rows are never
   * deleted (retained for reuse detection).
   */
  async logout(dto: RefreshDto): Promise<void> {
    const tokenHash = this.hashToken(dto.refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async getCurrentUser(userId: string): Promise<SafeUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: SAFE_USER_SELECT,
    });

    if (!user) {
      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }

    return user;
  }

  /**
   * Generates 384 bits of random token material (base64url) and returns it
   * alongside its sha256 hex hash and expiry. The raw token is returned to
   * the client exactly once and NEVER persisted.
   */
  private createRefreshTokenMaterial(): {
    token: string;
    tokenHash: string;
    expiresAt: Date;
  } {
    const token = randomBytes(48).toString('base64url');
    return {
      token,
      tokenHash: this.hashToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
