import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { normalizeEmail } from '../common/utils/normalize-email.util';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { PasswordHashingService } from './password-hashing.service';
import { JwtPayload } from './jwt.strategy';
import { SafeUser, SAFE_USER_SELECT } from './safe-user';

const GENERIC_AUTH_ERROR = 'Invalid credentials';

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

  async login(dto: LoginDto): Promise<{ accessToken: string }> {
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

    return { accessToken };
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
}
