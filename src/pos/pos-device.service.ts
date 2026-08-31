import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PosDevice } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../common/database/prisma/prisma.service';
import {
  buildOrderBy,
  encodeRowCursor,
  fetchPage,
  Paginated,
  resolveListContinuation,
} from '../common/pagination/paginate';
import { DEFAULT_PAGE_SIZE } from '../common/pagination/pagination-query.dto';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  CreatePosDeviceDto,
  PosDeviceListQueryDto,
  UpdatePosDeviceDto,
} from './dto/pos.dto';

const STORE_NOT_FOUND = 'Store not found';
const DEVICE_NOT_FOUND = 'Pos device not found';
const NAME_TAKEN = 'A POS device with this name already exists in the tenant';
const NOT_ACTIVE = 'Device is not active';
const NOT_SUSPENDED = 'Device is not suspended';
const ALREADY_RETIRED = 'Device is already retired';

/**
 * Summary projection returned by every device read/list endpoint. The
 * credentialHash is NEVER included (A2: credentials are never exposed by
 * list/read endpoints, never logged).
 */
export interface PosDeviceSummary {
  id: string;
  tenantId: string;
  storeId: string;
  name: string;
  status: string;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Registration/rotation response: the plaintext credential appears HERE and
 * ONLY here (A2/D6). No other endpoint, projection, or log ever contains it.
 */
export interface PosDeviceRegistrationSummary extends PosDeviceSummary {
  credential: string;
}

/**
 * PosDevice administration — Phase 4 P4-U1.
 *
 * SECURITY CONTRACT (mirrors CustomerService/AssetService):
 * - Tenant identity is ALWAYS server-derived via TenantContext.requireTenantId()
 *   and fails closed when missing; tenantId is never client input.
 * - The store reference is resolved through a tenant-scoped Store lookup
 *   (foreign/unknown store -> 404) BEFORE any write — the Asset.storeId
 *   pattern. The binding is permanent afterwards (A5).
 * - Credentials: 384-bit random material, sha256-hex hashed at rest
 *   (RefreshToken precedent), returned in plaintext exactly once.
 * - Lifecycle (A6) is a strict state machine via guarded updateMany:
 *     ACTIVE <-> SUSPENDED, ACTIVE|SUSPENDED -> RETIRED (terminal).
 *   RETIRED has no outgoing transitions and forbids credential rotation.
 */
@Injectable()
export class PosDeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async registerDevice(
    dto: CreatePosDeviceDto,
  ): Promise<PosDeviceRegistrationSummary> {
    this.assertTenantContext();
    const tenantId = this.tenantContext.requireTenantId();

    const store = await this.prisma.store.findUnique({
      where: { id: dto.storeId },
    });
    if (!store) throw new NotFoundException(STORE_NOT_FOUND);

    const { credential, hash } = this.createCredentialMaterial();

    try {
      const device = await this.prisma.posDevice.create({
        data: {
          tenantId,
          storeId: dto.storeId,
          name: dto.name,
          status: 'ACTIVE',
          credentialHash: hash,
        },
      });
      return { ...this.toSummary(device), credential };
    } catch (error) {
      if (this.isP2002(error)) throw new ConflictException(NAME_TAKEN);
      throw error;
    }
  }

  async getDevice(id: string): Promise<PosDeviceSummary> {
    this.assertTenantContext();
    const device = await this.findDevice(id);
    if (!device) throw new NotFoundException(DEVICE_NOT_FOUND);
    return this.toSummary(device);
  }

  async listDevices(
    query: PosDeviceListQueryDto,
  ): Promise<Paginated<PosDeviceSummary>> {
    this.assertTenantContext();
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const direction = query.order ?? 'asc';

    const equality: Record<string, unknown> = {};
    if (query.status !== undefined) equality.status = query.status;

    const { fingerprint, keyset } = resolveListContinuation({
      cursor: query.cursor,
      sortBy: 'createdAt',
      direction,
      equality,
    });

    const predicates: Record<string, unknown>[] = [];
    if (Object.keys(equality).length > 0) predicates.push(equality);
    if (keyset !== undefined) predicates.push(keyset);
    const where = (
      predicates.length > 0 ? { AND: predicates } : {}
    ) as Prisma.PosDeviceWhereInput;

    const page = await fetchPage(
      async () =>
        (await this.prisma.posDevice.findMany({
          where,
          orderBy: buildOrderBy('createdAt', direction),
          take: limit + 1,
        })) as unknown as Array<Record<string, unknown>>,
      limit,
      encodeRowCursor,
      'createdAt',
      direction,
      fingerprint,
    );
    return {
      data: page.data.map((row) => this.toSummary(row as unknown as PosDevice)),
      meta: page.meta,
    };
  }

  async updateDevice(
    id: string,
    dto: UpdatePosDeviceDto,
  ): Promise<PosDeviceSummary> {
    this.assertTenantContext();
    const device = await this.findDevice(id);
    if (!device) throw new NotFoundException(DEVICE_NOT_FOUND);

    try {
      const updated = await this.prisma.posDevice.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
        },
      });
      return this.toSummary(updated);
    } catch (error) {
      if (this.isP2002(error)) throw new ConflictException(NAME_TAKEN);
      throw error;
    }
  }

  /**
   * Guarded lifecycle transition (A6). Only the approved edges are legal:
   *   suspend:   ACTIVE -> SUSPENDED
   *   resume:    SUSPENDED -> ACTIVE
   *   retire:    ACTIVE | SUSPENDED -> RETIRED (terminal)
   * RETIRED is checked FIRST for every action: a retired device rejects
   * all transitions (and credential rotation) with the terminal-state
   * message. The store binding is immutable (A5).
   */
  async transition(
    id: string,
    action: 'suspend' | 'resume' | 'retire',
  ): Promise<PosDeviceSummary> {
    this.assertTenantContext();

    const device = await this.findDevice(id);
    if (!device) throw new NotFoundException(DEVICE_NOT_FOUND);
    if (device.status === 'RETIRED') {
      throw new ConflictException(ALREADY_RETIRED);
    }

    if (action === 'retire') {
      const updated = await this.prisma.posDevice.updateMany({
        where: { id, status: { in: ['ACTIVE', 'SUSPENDED'] } },
        data: { status: 'RETIRED' },
      });
      if (updated.count === 0) {
        throw new ConflictException(ALREADY_RETIRED);
      }
    } else {
      const expected: 'ACTIVE' | 'SUSPENDED' =
        action === 'suspend' ? 'ACTIVE' : 'SUSPENDED';
      const updated = await this.prisma.posDevice.updateMany({
        where: { id, status: expected },
        data: { status: action === 'suspend' ? 'SUSPENDED' : 'ACTIVE' },
      });
      if (updated.count === 0) {
        // Distinguish the state-machine failure for a clear 409:
        // suspend requires ACTIVE (failure => device not active);
        // resume requires SUSPENDED (failure => device not suspended).
        throw new ConflictException(
          action === 'suspend' ? NOT_ACTIVE : NOT_SUSPENDED,
        );
      }
    }

    const fresh = await this.findDevice(id);
    if (!fresh) throw new NotFoundException(DEVICE_NOT_FOUND);
    return this.toSummary(fresh);
  }

  /**
   * Credential rotation (A2/A6): issues new random material, atomically
   * replaces the stored hash, and returns the plaintext exactly once.
   * Forbidden for retired devices.
   */
  async rotateCredential(id: string): Promise<PosDeviceRegistrationSummary> {
    this.assertTenantContext();
    const device = await this.findDevice(id);
    if (!device) throw new NotFoundException(DEVICE_NOT_FOUND);
    if (device.status === 'RETIRED') {
      throw new ConflictException(ALREADY_RETIRED);
    }

    const { credential, hash } = this.createCredentialMaterial();
    // Guarded: only a non-retired device may rotate; a concurrent retire
    // racing this update loses (count 0 -> 409).
    const updated = await this.prisma.posDevice.updateMany({
      where: { id, status: { in: ['ACTIVE', 'SUSPENDED'] } },
      data: { credentialHash: hash },
    });
    if (updated.count === 0) throw new ConflictException(ALREADY_RETIRED);

    const fresh = await this.findDevice(id);
    if (!fresh) throw new NotFoundException(DEVICE_NOT_FOUND);
    return { ...this.toSummary(fresh), credential };
  }

  /**
   * Constant-time credential verification for the future sync protocol
   * (A2/D6; consumed by P4-U5). Compares sha256 digests with
   * timingSafeEqual so the comparison duration never leaks the expected
   * hash. Not exposed through any HTTP route in P4-U1.
   */
  verifyCredential(device: PosDevice, presentedCredential: string): boolean {
    const presentedHash = createHash('sha256')
      .update(presentedCredential, 'utf8')
      .digest('hex');
    const a = Buffer.from(presentedHash, 'utf8');
    const b = Buffer.from(device.credentialHash, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** 384-bit random secret -> base64url, plus its sha256 hex hash. */
  private createCredentialMaterial(): { credential: string; hash: string } {
    const credential = randomBytes(48).toString('base64url');
    const hash = createHash('sha256').update(credential, 'utf8').digest('hex');
    return { credential, hash };
  }

  /** Tenant-scoped lookup; foreign ids resolve to null (uniform 404). */
  private findDevice(id: string): Promise<PosDevice | null> {
    return this.prisma.posDevice.findUnique({ where: { id } });
  }

  private toSummary(device: PosDevice): PosDeviceSummary {
    return {
      id: device.id,
      tenantId: device.tenantId,
      storeId: device.storeId,
      name: device.name,
      status: device.status,
      lastSeenAt: device.lastSeenAt,
      createdAt: device.createdAt,
      updatedAt: device.updatedAt,
    };
  }

  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }

  private isP2002(
    error: unknown,
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}
