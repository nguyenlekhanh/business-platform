import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PosSession } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { OpenPosSessionDto } from './dto/pos.dto';

const DEVICE_NOT_FOUND = 'Pos device not found';
const DEVICE_NOT_ACTIVE = 'Device is not active';
const SESSION_NOT_FOUND = 'POS session not found';
const ALREADY_OPEN = 'Device already has an open session';
const NOT_OPEN = 'Only open sessions can be closed';

/**
 * POS session summary projection (A3: bare lifecycle — no financial
 * summary fields in P4-U1).
 */
export interface PosSessionSummary {
  id: string;
  tenantId: string;
  deviceId: string;
  storeId: string;
  userId: string;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * PosSession administration — Phase 4 P4-U1 (D9).
 *
 * A session is a cashier shift on a device:
 *  - the STORE is derived from the DEVICE (never client-supplied — A5);
 *  - the CASHIER is the authenticated principal (server-derived userId);
 *  - one OPEN session per device, enforced by the handwritten partial
 *    unique index PosSession_one_open_per_device (arbitrates the open
 *    race at the DB level — deliberately stricter than the tolerated U5
 *    cart race; a terminal is single-cashier-at-a-time);
 *  - lifecycle is a bare OPEN -> CLOSED (A3): guarded updateMany, and
 *    closing an already-CLOSED session is a 409, never idempotent
 *    (shift boundaries must stay unambiguous).
 *
 * SECURITY CONTRACT: identical to PosDeviceService — server-derived
 * tenant only, fail-closed, tenant-scoped lookups (uniform 404).
 */
@Injectable()
export class PosSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async openSession(
    userId: string,
    dto: OpenPosSessionDto,
  ): Promise<PosSessionSummary> {
    this.assertTenantContext();
    const tenantId = this.tenantContext.requireTenantId();

    const device = await this.prisma.posDevice.findUnique({
      where: { id: dto.deviceId },
    });
    if (!device) throw new NotFoundException(DEVICE_NOT_FOUND);
    if (device.status !== 'ACTIVE') {
      throw new ConflictException(DEVICE_NOT_ACTIVE);
    }

    try {
      const session = await this.prisma.posSession.create({
        data: {
          tenantId,
          deviceId: device.id,
          storeId: device.storeId, // derived from the device, never the client
          userId,
          status: 'OPEN',
          openedAt: new Date(),
        },
      });
      return this.toSummary(session);
    } catch (error) {
      // The partial unique index is the arbiter: a concurrent open on the
      // same device lands here.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(ALREADY_OPEN);
      }
      throw error;
    }
  }

  async getSession(id: string): Promise<PosSessionSummary> {
    this.assertTenantContext();
    const session = await this.findSession(id);
    if (!session) throw new NotFoundException(SESSION_NOT_FOUND);
    return this.toSummary(session);
  }

  async closeSession(id: string): Promise<PosSessionSummary> {
    this.assertTenantContext();

    const updated = await this.prisma.posSession.updateMany({
      where: { id, status: 'OPEN' },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    if (updated.count === 0) {
      // Uniform 404 for unknown/foreign; 409 for an already-closed shift.
      const session = await this.findSession(id);
      if (!session) throw new NotFoundException(SESSION_NOT_FOUND);
      throw new ConflictException(NOT_OPEN);
    }

    const fresh = await this.findSession(id);
    if (!fresh) throw new NotFoundException(SESSION_NOT_FOUND);
    return this.toSummary(fresh);
  }

  private findSession(id: string): Promise<PosSession | null> {
    return this.prisma.posSession.findUnique({ where: { id } });
  }

  private toSummary(session: PosSession): PosSessionSummary {
    return {
      id: session.id,
      tenantId: session.tenantId,
      deviceId: session.deviceId,
      storeId: session.storeId,
      userId: session.userId,
      status: session.status,
      openedAt: session.openedAt,
      closedAt: session.closedAt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }
}
