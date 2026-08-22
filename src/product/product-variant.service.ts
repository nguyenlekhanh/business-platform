import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Price, Product, ProductVariant } from '@prisma/client';
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
  CreateProductVariantDto,
  ProductVariantListQueryDto,
  PutPriceDto,
  UpdateProductVariantDto,
} from './dto/product-variant.dto';

const VARIANT_NOT_FOUND = 'Variant not found';
const SKU_TAKEN = 'A variant with this SKU already exists in the tenant';
const PRODUCT_NOT_FOUND = 'Product not found';

/**
 * Current price projection. BigInt amounts are serialized as STRINGS in JSON
 * (approved money convention: exact minor units, no float precision loss).
 */
export interface PriceSummary {
  id: string;
  variantId: string;
  currency: string;
  amountMinor: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Safe variant projection with its CURRENT prices embedded. */
export interface ProductVariantSummary {
  id: string;
  tenantId: string;
  productId: string;
  sku: string;
  name: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  prices: Array<{ currency: string; amountMinor: string }>;
}

/**
 * Product variants + their current prices — Phase 3 U3.
 *
 * SECURITY CONTRACT (mirrors ProductService):
 * - The tenant identity is ALWAYS server-derived (requireTenantId) and fails
 *   closed when missing; tenantId is never a client parameter.
 * - Both models are tenant-scoped in the centralized Prisma extension, so
 *   every top-level read/write is scoped to the active tenant; a foreign
 *   product or variant id resolves to null (404).
 * - The parent product is resolved app-side through a tenant-scoped lookup
 *   BEFORE any write (Asset storeId / U2 categoryId pattern), so a cross-
 *   tenant productId on create/list is an indistinguishable 404.
 * - A duplicate (tenantId, sku) surfaces as Prisma P2002 -> 409.
 * - Price upsert overwrites the current row for its (variant, currency)
 *   pair; there is NO price history by design (order-time snapshots arrive
 *   with OrderItem in U6). A first-write race falls back to the update path.
 * - Deletes are hard deletes; DB cascades remove prices under a deleted
 *   variant and variants under a deleted product (approved model).
 */
@Injectable()
export class ProductVariantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Paginated variant list of ONE parent product: keyset over (createdAt,
   * id) with the shared envelope. Prices for the page are batch-loaded with
   * one extra tenant-scoped query and embedded as { currency, amountMinor }.
   */
  async listVariants(
    productId: string,
    query: ProductVariantListQueryDto,
  ): Promise<Paginated<ProductVariantSummary>> {
    this.assertTenantContext();
    const product = await this.findProduct(productId);
    if (!product) {
      throw new NotFoundException(PRODUCT_NOT_FOUND);
    }
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const direction = query.order ?? 'asc';

    const equality: Record<string, unknown> = { productId };
    const { fingerprint, keyset } = resolveListContinuation({
      cursor: query.cursor,
      sortBy: 'createdAt',
      direction,
      equality,
    });

    const predicates: Record<string, unknown>[] = [equality];
    if (keyset !== undefined) {
      predicates.push(keyset);
    }
    const where = { AND: predicates } as Prisma.ProductVariantWhereInput;

    const page = await fetchPage(
      async () =>
        (await this.prisma.productVariant.findMany({
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

    const rows = page.data as unknown as ProductVariant[];
    return {
      data: await this.attachPrices(rows),
      meta: page.meta,
    };
  }

  async createVariant(
    productId: string,
    dto: CreateProductVariantDto,
  ): Promise<ProductVariantSummary> {
    this.assertTenantContext();
    // Same-tenant parent resolution BEFORE any write: a foreign/unknown
    // product id is an indistinguishable 404.
    const product = await this.findProduct(productId);
    if (!product) {
      throw new NotFoundException(PRODUCT_NOT_FOUND);
    }
    // tenantId is server-derived (extension also enforces it); including it
    // here keeps Prisma's create types happy and makes the intent explicit.
    const tenantId = this.tenantContext.requireTenantId();
    try {
      const variant = await this.prisma.productVariant.create({
        data: {
          tenantId,
          productId,
          sku: dto.sku,
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
      return this.toSummary(variant, []);
    } catch (error) {
      if (this.isP2002(error)) {
        throw new ConflictException(SKU_TAKEN);
      }
      throw error;
    }
  }

  async updateVariant(
    variantId: string,
    dto: UpdateProductVariantDto,
  ): Promise<ProductVariantSummary> {
    this.assertTenantContext();
    const variant = await this.findVariant(variantId);
    if (!variant) {
      throw new NotFoundException(VARIANT_NOT_FOUND);
    }
    try {
      const updated = await this.prisma.productVariant.update({
        where: { id: variantId },
        data: {
          ...(dto.sku !== undefined ? { sku: dto.sku } : {}),
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
      return await this.toSummaryWithPrices(updated);
    } catch (error) {
      if (this.isP2002(error)) {
        throw new ConflictException(SKU_TAKEN);
      }
      throw error;
    }
  }

  async deleteVariant(variantId: string): Promise<{ id: string }> {
    this.assertTenantContext();
    const variant = await this.findVariant(variantId);
    if (!variant) {
      throw new NotFoundException(VARIANT_NOT_FOUND);
    }
    await this.prisma.productVariant.delete({ where: { id: variantId } });
    return { id: variantId };
  }

  /**
   * Upsert of the CURRENT price for one (variant, currency) pair:
   * PUT semantics = full replace of that pair's row, overwrite without
   * history. Read-then-write with a P2002 fallback covers the concurrent
   * first-write race (both see "missing", one insert wins, loser updates).
   */
  async putPrice(variantId: string, dto: PutPriceDto): Promise<PriceSummary> {
    this.assertTenantContext();
    const variant = await this.findVariant(variantId);
    if (!variant) {
      throw new NotFoundException(VARIANT_NOT_FOUND);
    }
    const amountMinor = BigInt(dto.amountMinor);
    const pairWhere = {
      variantId_currency: { variantId, currency: dto.currency },
    };
    const existing = await this.prisma.price.findUnique({
      where: pairWhere,
    });
    try {
      if (existing) {
        const updated = await this.prisma.price.update({
          where: pairWhere,
          data: { amountMinor },
        });
        return this.toPriceSummary(updated);
      }
      const tenantId = this.tenantContext.requireTenantId();
      const created = await this.prisma.price.create({
        data: { tenantId, variantId, currency: dto.currency, amountMinor },
      });
      return this.toPriceSummary(created);
    } catch (error) {
      // Lost a create race: another request inserted the same pair first.
      if (this.isP2002(error)) {
        const updated = await this.prisma.price.update({
          where: pairWhere,
          data: { amountMinor },
        });
        return this.toPriceSummary(updated);
      }
      throw error;
    }
  }

  /** Tenant-scoped parent product resolution (404 pattern). */
  private findProduct(productId: string): Promise<Product | null> {
    return this.prisma.product.findUnique({ where: { id: productId } });
  }

  /** Tenant-scoped variant resolution: foreign ids resolve to null. */
  private findVariant(variantId: string): Promise<ProductVariant | null> {
    return this.prisma.productVariant.findUnique({
      where: { id: variantId },
    });
  }

  /**
   * One extra batched query per page: loads the CURRENT prices for exactly
   * the listed variants (extension scopes it to the active tenant) and
   * embeds them into each summary.
   */
  private async attachPrices(
    rows: ProductVariant[],
  ): Promise<ProductVariantSummary[]> {
    if (rows.length === 0) {
      return [];
    }
    const prices = await this.prisma.price.findMany({
      where: { variantId: { in: rows.map((row) => row.id) } },
    });
    const grouped = new Map<string, Price[]>();
    for (const price of prices) {
      const list = grouped.get(price.variantId) ?? [];
      list.push(price);
      grouped.set(price.variantId, list);
    }
    return rows.map((row) => this.toSummary(row, grouped.get(row.id) ?? []));
  }

  private async toSummaryWithPrices(
    variant: ProductVariant,
  ): Promise<ProductVariantSummary> {
    const prices = await this.prisma.price.findMany({
      where: { variantId: variant.id },
    });
    return this.toSummary(variant, prices);
  }

  private toSummary(
    variant: ProductVariant,
    prices: Price[],
  ): ProductVariantSummary {
    return {
      id: variant.id,
      tenantId: variant.tenantId,
      productId: variant.productId,
      sku: variant.sku,
      name: variant.name,
      status: variant.status,
      createdAt: variant.createdAt,
      updatedAt: variant.updatedAt,
      prices: prices.map((price) => ({
        currency: price.currency,
        amountMinor: price.amountMinor.toString(),
      })),
    };
  }

  private toPriceSummary(price: Price): PriceSummary {
    return {
      id: price.id,
      variantId: price.variantId,
      currency: price.currency,
      amountMinor: price.amountMinor.toString(),
      createdAt: price.createdAt,
      updatedAt: price.updatedAt,
    };
  }

  /**
   * Defense in depth: every method requires an active TenantContext even
   * before hitting the Prisma extension (fail-closed service boundary,
   * unit-testable without the extension).
   */
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
