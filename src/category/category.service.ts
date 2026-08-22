import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Category } from '@prisma/client';
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
  CategoryListQueryDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './dto/category.dto';

const CATEGORY_NOT_FOUND = 'Category not found';
const NAME_TAKEN = 'A category with this name already exists in the tenant';
const IN_USE =
  'Category is referenced by existing products and cannot be deleted';

/** Safe category projection: all scalar fields, no relation traversal. */
export interface CategorySummary {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Category (product taxonomy) administration — Phase 3 U1.
 *
 * SECURITY CONTRACT (mirrors StoreService):
 * - The tenant identity is ALWAYS server-derived: each method asserts the
 *   TenantContext (requireTenantId) and fails closed (500) when it is missing.
 *   tenantId is never accepted as a method parameter or from client input.
 * - Category is a tenant-scoped model in the centralized Prisma extension, so
 *   every top-level read/write here is automatically scoped to the active
 *   tenant; a category id from another tenant resolves to null (404).
 * - The tenantId is injected by the extension into create/update data — the
 *   service never writes it, so callers cannot override it.
 * - A duplicate (tenantId, name) surfaces as a Prisma P2002 unique-constraint
 *   violation which is mapped to 409. The same name in different tenants is
 *   allowed because the constraint is composite (tenantId, name).
 * - No raw SQL, no nested writes, no generic RolePermission CRUD.
 */
@Injectable()
export class CategoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Paginated category list (Phase 3 contract): keyset over (createdAt, id)
   * with the shared envelope. Tenant scoping stays centralized in the Prisma
   * extension.
   */
  async listCategories(
    query: CategoryListQueryDto,
  ): Promise<Paginated<CategorySummary>> {
    this.assertTenantContext();
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const direction = query.order ?? 'asc';

    const { fingerprint, keyset } = resolveListContinuation({
      cursor: query.cursor,
      sortBy: 'createdAt',
      direction,
      equality: {},
    });

    const where = (
      keyset !== undefined ? { AND: [keyset] } : {}
    ) as Prisma.CategoryWhereInput;

    const page = await fetchPage(
      async () =>
        (await this.prisma.category.findMany({
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
      data: page.data.map((row) => this.toSummary(row as unknown as Category)),
      meta: page.meta,
    };
  }

  async getCategory(categoryId: string): Promise<CategorySummary> {
    this.assertTenantContext();
    const category = await this.findCategory(categoryId);
    if (!category) {
      throw new NotFoundException(CATEGORY_NOT_FOUND);
    }
    return this.toSummary(category);
  }

  async createCategory(dto: CreateCategoryDto): Promise<CategorySummary> {
    // The tenant identity comes ONLY from the TenantContext: server-derived
    // and never a client parameter. The Prisma extension additionally forces
    // this tenantId into the create, so it can never be overridden.
    const tenantId = this.tenantContext.requireTenantId();
    try {
      const category = await this.prisma.category.create({
        data: {
          tenantId,
          name: dto.name,
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
        },
      });
      return this.toSummary(category);
    } catch (error) {
      if (this.isP2002(error)) {
        throw new ConflictException(NAME_TAKEN);
      }
      throw error;
    }
  }

  async updateCategory(
    categoryId: string,
    dto: UpdateCategoryDto,
  ): Promise<CategorySummary> {
    this.assertTenantContext();
    const category = await this.findCategory(categoryId);
    if (!category) {
      throw new NotFoundException(CATEGORY_NOT_FOUND);
    }
    // The tenant is NEVER written here: the extension scopes the update to
    // the active TenantContext (where: tenantId), so a caller cannot point
    // this at another tenant.
    try {
      const updated = await this.prisma.category.update({
        where: { id: categoryId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
        },
      });
      return this.toSummary(updated);
    } catch (error) {
      if (this.isP2002(error)) {
        throw new ConflictException(NAME_TAKEN);
      }
      throw error;
    }
  }

  async deleteCategory(categoryId: string): Promise<{ id: string }> {
    this.assertTenantContext();
    const category = await this.findCategory(categoryId);
    if (!category) {
      throw new NotFoundException(CATEGORY_NOT_FOUND);
    }
    try {
      await this.prisma.category.delete({ where: { id: categoryId } });
    } catch (error) {
      // The Product.categoryId foreign key is RESTRICT (Phase 3 U2): a
      // category still referenced by products cannot be deleted. Map the FK
      // violation to a clear 409 instead of an opaque 500 (approved
      // "P2002/P2003 mapped to clear 409s" convention).
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new ConflictException(IN_USE);
      }
      throw error;
    }
    return { id: categoryId };
  }

  /**
   * Tenant-scoped category lookup. The extension merges the active tenantId
   * into the where clause, so an id from another tenant resolves to null.
   */
  private findCategory(categoryId: string): Promise<Category | null> {
    return this.prisma.category.findUnique({ where: { id: categoryId } });
  }

  /**
   * Defense in depth: the category methods require an active TenantContext
   * even before hitting the Prisma extension. This makes the fail-closed
   * contract explicit at the service boundary (and unit-testable without the
   * extension).
   */
  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }

  private toSummary(category: Category): CategorySummary {
    return {
      id: category.id,
      tenantId: category.tenantId,
      name: category.name,
      description: category.description,
      createdAt: category.createdAt,
      updatedAt: category.updatedAt,
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
}
