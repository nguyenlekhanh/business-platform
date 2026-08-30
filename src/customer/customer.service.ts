import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Customer, CustomerStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
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
  CreateCustomerDto,
  CustomerListQueryDto,
  UpdateCustomerDto,
} from './dto/customer.dto';

const CUSTOMER_NOT_FOUND = 'Customer not found';
const CODE_TAKEN = 'A customer with this code already exists in the tenant';

/**
 * Safe customer projection: all scalar fields and no relation traversal.
 */
export interface CustomerSummary {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  status: CustomerStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Customer (rental counterparty) administration.
 *
 * SECURITY CONTRACT (mirrors AssetService):
 * - Tenant identity is ALWAYS server-derived via TenantContext.requireTenantId()
 *   and fails closed when the context is missing. tenantId is never a method
 *   parameter or client input; create passes only the context-derived id,
 *   which the centralized extension enforces on every write.
 * - Customer is a tenant-scoped model in the centralized Prisma extension, so
 *   every top-level read/write is automatically scoped; a customer id from
 *   another tenant resolves to null (404).
 * - A duplicate (tenantId, code) surfaces as Prisma P2002 -> 409.
 * - No raw SQL, no nested writes, no relation traversal into other models.
 */
@Injectable()
export class CustomerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Paginated, filtered customer list (Phase 2J contract): keyset over
   * (createdAt, id) with the shared envelope; equality filter status. Tenant
   * scoping stays centralized in the Prisma extension.
   */
  async listCustomers(
    query: CustomerListQueryDto,
  ): Promise<Paginated<CustomerSummary>> {
    this.assertTenantContext();
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const direction = query.order ?? 'asc';

    const equality: Record<string, unknown> = {};
    if (query.status !== undefined) {
      equality.status = query.status;
    }

    const { fingerprint, keyset } = resolveListContinuation({
      cursor: query.cursor,
      sortBy: 'createdAt',
      direction,
      equality,
    });

    const predicates: Record<string, unknown>[] = [];
    if (Object.keys(equality).length > 0) {
      predicates.push(equality);
    }
    if (keyset !== undefined) {
      predicates.push(keyset);
    }
    const where = (
      predicates.length > 0 ? { AND: predicates } : {}
    ) as Prisma.CustomerWhereInput;

    const page = await fetchPage(
      async () =>
        (await this.prisma.customer.findMany({
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
      data: page.data.map((row) => this.toSummary(row as unknown as Customer)),
      meta: page.meta,
    };
  }

  async getCustomer(id: string): Promise<CustomerSummary> {
    this.assertTenantContext();
    const customer = await this.findCustomer(id);
    if (!customer) {
      throw new NotFoundException(CUSTOMER_NOT_FOUND);
    }
    return this.toSummary(customer);
  }

  async createCustomer(dto: CreateCustomerDto): Promise<CustomerSummary> {
    const tenantId = this.tenantContext.requireTenantId();
    try {
      const customer = await this.prisma.customer.create({
        data: {
          tenantId,
          name: dto.name,
          code: dto.code,
          ...(dto.email !== undefined ? { email: dto.email } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
      return this.toSummary(customer);
    } catch (error) {
      if (this.isP2002(error)) {
        throw new ConflictException(CODE_TAKEN);
      }
      throw error;
    }
  }

  async updateCustomer(
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<CustomerSummary> {
    this.assertTenantContext();
    const customer = await this.findCustomer(id);
    if (!customer) {
      throw new NotFoundException(CUSTOMER_NOT_FOUND);
    }
    try {
      const updated = await this.prisma.customer.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.code !== undefined ? { code: dto.code } : {}),
          ...(dto.email !== undefined ? { email: dto.email } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
      return this.toSummary(updated);
    } catch (error) {
      if (this.isP2002(error)) {
        throw new ConflictException(CODE_TAKEN);
      }
      throw error;
    }
  }

  async deleteCustomer(id: string): Promise<{ id: string }> {
    this.assertTenantContext();
    const customer = await this.findCustomer(id);
    if (!customer) {
      throw new NotFoundException(CUSTOMER_NOT_FOUND);
    }
    try {
      await this.prisma.customer.delete({ where: { id } });
    } catch (error) {
      // RESTRICT history: Reservation.customerId (Phase 2G) and Order.customerId (Phase 3 U6)
      if (this.isP2003(error)) {
        const msg = String((error as { message?: string }).message ?? '');
        if (msg.includes('Order')) {
          throw new ConflictException(
            'Customer has orders and cannot be deleted',
          );
        }
        throw new ConflictException(
          'Customer has reservations and cannot be deleted',
        );
      }
      throw error;
    }
    return { id };
  }

  /** Tenant-scoped customer lookup. The extension merges tenantId into the
   *  where clause, so a customer id from another tenant resolves to null. */
  private findCustomer(id: string): Promise<Customer | null> {
    return this.prisma.customer.findUnique({ where: { id } });
  }

  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }

  private toSummary(customer: Customer): CustomerSummary {
    return {
      id: customer.id,
      tenantId: customer.tenantId,
      name: customer.name,
      code: customer.code,
      email: customer.email,
      phone: customer.phone,
      notes: customer.notes,
      status: customer.status,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    };
  }

  private isP2002(
    error: unknown,
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  /** Foreign-key RESTRICT violation (e.g. customer still has reservations). */
  private isP2003(
    error: unknown,
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003'
    );
  }
}
