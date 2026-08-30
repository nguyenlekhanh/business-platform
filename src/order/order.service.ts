import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { Order, OrderItem } from '@prisma/client';
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
import { CreateOrderDto, OrderListQueryDto } from './dto/order.dto';

const ORDER_NOT_FOUND = 'Order not found';
const VARIANT_NOT_FOUND = 'Variant not found';
const VARIANT_NOT_ACTIVE = 'Variant is not active';
const PRICE_NOT_FOUND = 'Price not found for variant';
const CURRENCY_MISMATCH = 'All items must have the same currency';
const INSUFFICIENT_STOCK = 'Insufficient stock';
const CART_EMPTY = 'Cart is empty';
const CUSTOMER_NOT_FOUND = 'Customer not found';
const NOT_PENDING = 'Only pending orders can be cancelled';

export interface OrderItemSummary {
  id: string;
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string;
  quantity: number;
  currency: string;
  unitAmountMinor: string;
  lineTotalMinor: string;
}

export interface OrderSummary {
  id: string;
  tenantId: string;
  userId: string;
  customerId: string | null;
  status: string;
  currency: string;
  subtotalMinor: string;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  items: OrderItemSummary[];
}

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async createOrder(
    userId: string,
    dto: CreateOrderDto,
  ): Promise<OrderSummary> {
    this.assertTenantContext();
    const tenantId = this.tenantContext.requireTenantId();
    let itemsInput: Array<{ variantId: string; quantity: number }>;
    let cartToConvertId: string | null = null;

    if (dto.items && dto.items.length > 0) {
      itemsInput = dto.items.map((i) => ({
        variantId: i.variantId,
        quantity: i.quantity,
      }));
    } else {
      const cart = await this.prisma.cart.findFirst({
        where: { userId, status: 'OPEN' },
        orderBy: { createdAt: 'asc' },
      });
      if (!cart) throw new BadRequestException(CART_EMPTY);
      const cartItems = await this.prisma.cartItem.findMany({
        where: { cartId: cart.id },
      });
      if (cartItems.length === 0) throw new BadRequestException(CART_EMPTY);
      itemsInput = cartItems.map((ci) => ({
        variantId: ci.variantId,
        quantity: ci.quantity,
      }));
      cartToConvertId = cart.id;
    }

    if (dto.customerId !== undefined) {
      const customer = await this.prisma.customer.findUnique({
        where: { id: dto.customerId },
      });
      if (!customer) throw new NotFoundException(CUSTOMER_NOT_FOUND);
    }

    const aggregated = this.aggregateItems(itemsInput);

    return this.prisma.$transaction(async (tx) => {
      const variantIds = Array.from(aggregated.keys());
      const variants = await tx.productVariant.findMany({
        where: { id: { in: variantIds } },
      });
      if (variants.length !== variantIds.length)
        throw new NotFoundException(VARIANT_NOT_FOUND);
      for (const v of variants) {
        if (v.status !== 'ACTIVE')
          throw new ConflictException(VARIANT_NOT_ACTIVE);
      }
      const variantMap = new Map(variants.map((v) => [v.id, v]));
      const prices = await tx.price.findMany({
        where: { variantId: { in: variantIds } },
      });
      const priceMap = new Map<string, typeof prices>();
      for (const p of prices) {
        const arr = priceMap.get(p.variantId) ?? [];
        arr.push(p);
        priceMap.set(p.variantId, arr);
      }
      let targetCurrency: string | null = null;
      const unitPrices = new Map<string, bigint>();
      const unitPriceRows = new Map<string, any>();
      for (const vid of variantIds) {
        const vPrices = priceMap.get(vid) ?? [];
        if (vPrices.length === 0) throw new ConflictException(PRICE_NOT_FOUND);
        if (targetCurrency === null) {
          targetCurrency = vPrices[0].currency;
        }
        const found = vPrices.find((p) => p.currency === targetCurrency);
        if (!found) throw new ConflictException(CURRENCY_MISMATCH);
        unitPrices.set(vid, BigInt(found.amountMinor));
        unitPriceRows.set(vid, found);
      }
      if (!targetCurrency) throw new ConflictException(PRICE_NOT_FOUND);

      const productIds = variants.map((v) => v.productId);
      const products = await tx.product.findMany({
        where: { id: { in: productIds } },
      });
      const productMap = new Map(products.map((p) => [p.id, p]));

      for (const [vid, qty] of aggregated.entries()) {
        const res = await tx.inventory.updateMany({
          where: { variantId: vid, quantityOnHand: { gte: qty } },
          data: { quantityOnHand: { decrement: qty } },
        });
        if (res.count === 0) throw new ConflictException(INSUFFICIENT_STOCK);
      }

      let subtotal = 0n;
      const lineTotals = new Map<string, bigint>();
      for (const [vid, qty] of aggregated.entries()) {
        const unit = unitPrices.get(vid)!;
        const line = unit * BigInt(qty);
        lineTotals.set(vid, line);
        subtotal += line;
      }

      const order = await tx.order.create({
        data: {
          tenantId,
          userId,
          customerId: dto.customerId ?? null,
          status: 'PENDING',
          currency: targetCurrency,
          subtotalMinor: subtotal,
        },
      });

      for (const [vid, qty] of aggregated.entries()) {
        const variant = variantMap.get(vid)!;
        const product = productMap.get(variant.productId);
        const unit = unitPrices.get(vid)!;
        const line = lineTotals.get(vid)!;
        await tx.orderItem.create({
          data: {
            tenantId,
            orderId: order.id,
            variantId: vid,
            productName: product ? product.name : '',
            variantName: variant.name,
            sku: variant.sku,
            quantity: qty,
            currency: targetCurrency,
            unitAmountMinor: unit,
            lineTotalMinor: line,
          },
        });
      }

      if (cartToConvertId) {
        await tx.cart.update({
          where: { id: cartToConvertId },
          data: { status: 'CONVERTED' },
        });
      }

      const items = await tx.orderItem.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: 'asc' },
      });
      return this.toSummary(order, items);
    });
  }

  async getOrder(orderId: string): Promise<OrderSummary> {
    this.assertTenantContext();
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException(ORDER_NOT_FOUND);
    const items = await this.prisma.orderItem.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
    });
    return this.toSummary(order, items);
  }

  async listOrders(query: OrderListQueryDto): Promise<Paginated<OrderSummary>> {
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
    ) as Prisma.OrderWhereInput;
    const page = await fetchPage(
      async () =>
        (await this.prisma.order.findMany({
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
    const orders = page.data as unknown as Order[];
    const summaries: OrderSummary[] = [];
    for (const o of orders) {
      const items = await this.prisma.orderItem.findMany({
        where: { orderId: o.id },
        orderBy: { createdAt: 'asc' },
      });
      summaries.push(this.toSummary(o, items));
    }
    return { data: summaries, meta: page.meta };
  }

  async cancelOrder(orderId: string): Promise<OrderSummary> {
    this.assertTenantContext();
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException(ORDER_NOT_FOUND);
    if (order.status !== 'PENDING') throw new ConflictException(NOT_PENDING);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: { id: orderId, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      if (updated.count === 0) throw new ConflictException(NOT_PENDING);
      const items = await tx.orderItem.findMany({ where: { orderId } });
      const agg = new Map<string, number>();
      for (const it of items) {
        agg.set(it.variantId, (agg.get(it.variantId) ?? 0) + it.quantity);
      }
      for (const [vid, qty] of agg.entries()) {
        const existing = await tx.inventory.findUnique({
          where: { variantId: vid },
        });
        if (!existing) {
          const tenantId = this.tenantContext.requireTenantId();
          await tx.inventory.create({
            data: { tenantId, variantId: vid, quantityOnHand: qty },
          });
        } else {
          await tx.inventory.updateMany({
            where: { variantId: vid },
            data: { quantityOnHand: { increment: qty } },
          });
        }
      }
      const fresh = await tx.order.findUnique({ where: { id: orderId } });
      if (!fresh) throw new NotFoundException(ORDER_NOT_FOUND);
      const freshItems = await tx.orderItem.findMany({
        where: { orderId },
        orderBy: { createdAt: 'asc' },
      });
      return this.toSummary(fresh, freshItems);
    });
  }

  private aggregateItems(
    items: Array<{ variantId: string; quantity: number }>,
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const it of items) {
      map.set(it.variantId, (map.get(it.variantId) ?? 0) + it.quantity);
    }
    return map;
  }

  private toSummary(order: Order, items: OrderItem[]): OrderSummary {
    return {
      id: order.id,
      tenantId: order.tenantId,
      userId: order.userId,
      customerId: order.customerId,
      status: order.status,
      currency: order.currency,
      subtotalMinor: order.subtotalMinor.toString(),
      cancelledAt: order.cancelledAt,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      items: items.map((it) => ({
        id: it.id,
        variantId: it.variantId,
        productName: it.productName,
        variantName: it.variantName,
        sku: it.sku,
        quantity: it.quantity,
        currency: it.currency,
        unitAmountMinor: it.unitAmountMinor.toString(),
        lineTotalMinor: it.lineTotalMinor.toString(),
      })),
    };
  }

  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }
}
