import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../common/database/prisma/prisma.service';

/** Minimal identity claims embedded in the access token. */
export interface JwtPayload {
  sub: string;
}

/** The authenticated identity attached to the request by the JWT guard. */
export interface JwtUser {
  userId: string;
}

const INVALID_TOKEN_ERROR = 'Invalid credentials';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /**
   * Re-validates the user on every authenticated request so that a
   * previously issued token stops working once the user is suspended or
   * deleted.
   */
  async validate(payload: JwtPayload): Promise<JwtUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException(INVALID_TOKEN_ERROR);
    }

    return { userId: user.id };
  }
}
