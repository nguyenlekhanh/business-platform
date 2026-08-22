import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Product } from '@prisma/client';
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
  CreateProductDto,
  ProductListQueryDto,
  UpdateProductDto,
} from './dto/product.dto';

const PRODUCT_NOT_FOUND = 'Product not found';
const CODE_TAKEN = 'A product with this code already exists in the tenant';
const CATEGORY_NOT_FOUND = 'Category not found';

/** Safe product projection: all scalar fields, no relation traversal. */
export interface ProductSummary {
  id: string;
  tenantId: string;
  categoryId: string | null;
  name: string;
  code: string;
  description: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Product (catalog item) administration — Phase 3 U2.
 *
 * SECURITY CONTRACT (mirrors CategoryService/AssetService):
 * - The tenant identity is ALWAYS server-derived: each method asserts the
 *   TenantContext (requireTenantId) and fails closed (500) when it is missing.
 *   tenantId is never accepted as a method parameter or from client input.
 * - Product is a tenant-scoped model in the centralized Prisma extension, so
 *   every top-level read/write here is automatically scoped to the active
 *   tenant; a product id from another tenant resolves to null (404).
 * - The tenantId is injected by the extension into create data — the service
 *   never writes it, so callers cannot override it.
 * - An optional categoryId is validated through a tenant-scoped Category
 *   lookup (same-tenant, resolved app-side like storeId on Asset), so a
 *   cross-tenant category resolves to null -> 404; DB-level consistency is
 *   additionally backed by the composite tenant foreign key.
 * - A duplicate (tenantId, code) surfaces as Prisma P2002 -> 409.
 * - Hard delete per the approved catalog convention (no children exist until
 *   U3 variants); no raw SQL, no nested writes, no generic RolePermission CRUD.
 */
@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Paginated, filtered product list (Phase 3 contract): keyset over
   * (createdAt, id) with the shared envelope; equality filters status and
   * categoryId. Tenant scoping stays centralized in the Prisma extension; a
   * foreign categoryId filter simply matches nothing.
   */
  async listProducts(
    query: ProductListQueryDto,
  ): Promise<Paginated<ProductSummary>> {
    this.assertTenantContext();
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const direction = query.order ?? 'asc';

    const equality: Record<string, unknown> = {};
    if (query.status !== undefined) {
      equality.status = query.status;
    }
    if (query.categoryId !== undefined) {
      equality.categoryId = query.categoryId;
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
    ) as Prisma.ProductWhereInput;

    const page = await fetchPage(
      async () =>
        (await this.prisma.product.findMany({
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
      data: page.data.map((row) => this.toSummary(row as unknown as Product)),
      meta: page.meta,
    };
  }

  async getProduct(productId: string): Promise<ProductSummary> {
    this.assertTenantContext();
    const product = await this.findProduct(productId);
    if (!product) {
      throw new NotFoundException(PRODUCT_NOT_FOUND);
    }
    return this.toSummary(product);
  }

  async createProduct(dto: CreateProductDto): Promise<ProductSummary> {
    // The tenant identity comes ONLY from the TenantContext: server-derived
    // and never a client parameter. The Prisma extension additionally forces
    // this tenantId into the create, so it can never be overridden.
    const tenantId = this.tenantContext.requireTenantId();
    const categoryId = await this.resolveCategoryId(dto.categoryId);
    try {
      const product = await this.prisma.product.create({
        data: {
          tenantId,
          name: dto.name,
          code: dto.code,
          ...(categoryId !== undefined ? { categoryId } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
      return this.toSummary(product);
    } catch (error) {
      if (this.isP2002(error)) {
        throw new ConflictException(CODE_TAKEN);
      }
      throw error;
    }
  }

  async updateProduct(
    productId: string,
    dto: UpdateProductDto,
  ): Promise<ProductSummary> {
    this.assertTenantContext();
    const product = await this.findProduct(productId);
    if (!product) {
      throw new NotFoundException(PRODUCT_NOT_FOUND);
    }
    const categoryId = await this.resolveCategoryId(dto.categoryId);
    // The tenant is NEVER written here: the extension scopes the update to
    // the active TenantContext (where: tenantId), so a caller cannot point
    // this at another tenant.
    try {
      const updated = await this.prisma.product.update({
        where: { id: productId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.code !== undefined ? { code: dto.code } : {}),
          ...(categoryId !== undefined ? { categoryId } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
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

  async deleteProduct(productId: string): Promise<{ id: string }> {
    this.assertTenantContext();
    const product = await this.findProduct(productId);
    if (!product) {
      throw new NotFoundException(PRODUCT_NOT_FOUND);
    }
    await this.prisma.product.delete({ where: { id: productId } });
    return { id: productId };
  }

  /**
   * Same-tenant category resolution (storeId-on-Asset pattern). The
   * extension merges the active tenantId into the lookup, so an id from
   * another tenant resolves to null -> 404 before any write happens.
   */
  private async resolveCategoryId(
    categoryId: string | undefined,
  ): Promise<string | undefined> {
    if (categoryId === undefined) {
      return undefined;
    }
    const category = await this.prisma.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) {
      throw new NotFoundException(CATEGORY_NOT_FOUND);
    }
    return category.id;
  }

  /**
   * Tenant-scoped product lookup. The extension merges the active tenantId
   * into the where clause, so an id from another tenant resolves to null.
   */
  private findProduct(productId: string): Promise<Product | null> {
    return this.prisma.product.findUnique({ where: { id: productId } });
  }

  /**
   * Defense in depth: the product methods require an active TenantContext
   * even before hitting the Prisma extension. This makes the fail-closed
   * contract explicit at the service boundary (and unit-testable without the
   * extension).
   */
  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }

  private toSummary(product: Product): ProductSummary {
    return {
      id: product.id,
      tenantId: product.tenantId,
      categoryId: product.categoryId,
      name: product.name,
      code: product.code,
      description: product.description,
      status: product.status,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
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
