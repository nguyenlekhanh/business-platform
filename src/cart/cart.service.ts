import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Cart, Price, ProductVariant } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart.dto';

const VARIANT_NOT_FOUND = 'Variant not found';
const CART_NOT_FOUND = 'Cart not found';
const CART_ITEM_NOT_FOUND = 'Cart item not found';

export interface CartItemSummary {
  id: string;
  variantId: string;
  quantity: number;
  variant: {
    id: string;
    sku: string;
    name: string | null;
    status: string;
  } | null;
  prices: Array<{ currency: string; amountMinor: string }>;
  lineTotals: Array<{ currency: string; totalMinor: string }>;
}

export interface CartSummary {
  id: string;
  tenantId: string;
  userId: string;
  status: string;
  items: CartItemSummary[];
  totals: Array<{ currency: string; totalMinor: string }>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Cart — Phase 3 U5.
 * Owner = authenticated member User, tenant-scoped. One OPEN cart per
 * (tenant,user) find-or-create (race creates extra inert OPEN cart, tolerated).
 * Items merge by @@unique([cartId,variantId]). Prices are live from Price rows
 * at read time; totals are BigInt sums per currency (strings). No stock
 * reservation here; that happens at Order creation (U6).
 */
@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async getCart(userId: string): Promise<CartSummary> {
    this.assertTenantContext();
    const cart = await this.getOrCreateCart(userId);
    return this.enrichCart(cart);
  }

  async addItem(userId: string, dto: AddCartItemDto): Promise<CartSummary> {
    this.assertTenantContext();
    const variant = await this.findVariant(dto.variantId);
    if (!variant) {
      throw new NotFoundException(VARIANT_NOT_FOUND);
    }
    const cart = await this.getOrCreateCart(userId);
    const tenantId = this.tenantContext.requireTenantId();

    // Try merge: if item exists, increment quantity
    const existing = await this.prisma.cartItem.findFirst({
      where: { cartId: cart.id, variantId: dto.variantId },
    });

    if (existing) {
      const updated = await this.prisma.cartItem.update({
        where: { id: existing.id },
        data: { quantity: { increment: dto.quantity } },
      });
      void updated;
    } else {
      try {
        await this.prisma.cartItem.create({
          data: {
            tenantId,
            cartId: cart.id,
            variantId: dto.variantId,
            quantity: dto.quantity,
          },
        });
      } catch (error) {
        if (this.isP2002(error)) {
          // Race: another request created same [cartId,variantId] first — merge
          const raced = await this.prisma.cartItem.findFirst({
            where: { cartId: cart.id, variantId: dto.variantId },
          });
          if (!raced) {
            throw new ConflictException(CART_ITEM_NOT_FOUND);
          }
          await this.prisma.cartItem.update({
            where: { id: raced.id },
            data: { quantity: { increment: dto.quantity } },
          });
        } else {
          throw error;
        }
      }
    }
    const fresh = await this.findCartById(cart.id);
    if (!fresh) throw new NotFoundException(CART_NOT_FOUND);
    return this.enrichCart(fresh);
  }

  async updateItem(
    userId: string,
    itemId: string,
    dto: UpdateCartItemDto,
  ): Promise<CartSummary> {
    this.assertTenantContext();
    const cart = await this.getOrCreateCart(userId);
    const item = await this.prisma.cartItem.findUnique({
      where: { id: itemId },
    });
    if (!item || item.cartId !== cart.id) {
      throw new NotFoundException(CART_ITEM_NOT_FOUND);
    }
    await this.prisma.cartItem.update({
      where: { id: itemId },
      data: { quantity: dto.quantity },
    });
    const fresh = await this.findCartById(cart.id);
    if (!fresh) throw new NotFoundException(CART_NOT_FOUND);
    return this.enrichCart(fresh);
  }

  async removeItem(userId: string, itemId: string): Promise<CartSummary> {
    this.assertTenantContext();
    const cart = await this.getOrCreateCart(userId);
    const item = await this.prisma.cartItem.findUnique({
      where: { id: itemId },
    });
    if (!item || item.cartId !== cart.id) {
      throw new NotFoundException(CART_ITEM_NOT_FOUND);
    }
    await this.prisma.cartItem.delete({ where: { id: itemId } });
    const fresh = await this.findCartById(cart.id);
    if (!fresh) throw new NotFoundException(CART_NOT_FOUND);
    return this.enrichCart(fresh);
  }

  async discardCart(userId: string): Promise<void> {
    this.assertTenantContext();
    const cart = await this.prisma.cart.findFirst({
      where: { userId, status: 'OPEN' },
    });
    if (!cart) {
      throw new NotFoundException(CART_NOT_FOUND);
    }
    // Ensure cart belongs to current user and is OPEN (findFirst with userId already scoped via extension tenantId + userId)
    if (cart.userId !== userId) {
      throw new NotFoundException(CART_NOT_FOUND);
    }
    await this.prisma.cart.delete({ where: { id: cart.id } });
  }

  private async getOrCreateCart(userId: string): Promise<Cart> {
    const existing = await this.prisma.cart.findFirst({
      where: { userId, status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) return existing;
    const tenantId = this.tenantContext.requireTenantId();
    try {
      const created = await this.prisma.cart.create({
        data: { tenantId, userId, status: 'OPEN' },
      });
      return created;
    } catch (error) {
      if (this.isP2002(error)) {
        // Race created extra cart — return the first
        const raced = await this.prisma.cart.findFirst({
          where: { userId, status: 'OPEN' },
          orderBy: { createdAt: 'asc' },
        });
        if (raced) return raced;
      }
      throw error;
    }
  }

  private async findCartById(cartId: string): Promise<Cart | null> {
    return this.prisma.cart.findUnique({ where: { id: cartId } });
  }

  private async findVariant(variantId: string): Promise<ProductVariant | null> {
    return this.prisma.productVariant.findUnique({
      where: { id: variantId },
    });
  }

  private async enrichCart(cart: Cart): Promise<CartSummary> {
    const items = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id },
      orderBy: { createdAt: 'asc' },
    });

    if (items.length === 0) {
      return {
        id: cart.id,
        tenantId: cart.tenantId,
        userId: cart.userId,
        status: cart.status,
        items: [],
        totals: [],
        createdAt: cart.createdAt,
        updatedAt: cart.updatedAt,
      };
    }

    const variantIds = items.map((i) => i.variantId);
    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
    });
    const variantMap = new Map<string, ProductVariant>();
    for (const v of variants) variantMap.set(v.id, v);

    const prices = await this.prisma.price.findMany({
      where: { variantId: { in: variantIds } },
    });
    const priceMap = new Map<string, Price[]>();
    for (const p of prices) {
      const arr = priceMap.get(p.variantId) ?? [];
      arr.push(p);
      priceMap.set(p.variantId, arr);
    }

    const itemSummaries: CartItemSummary[] = items.map((item) => {
      const variant = variantMap.get(item.variantId) ?? null;
      const variantPrices = priceMap.get(item.variantId) ?? [];
      const priceEntries = variantPrices.map((pr) => ({
        currency: pr.currency,
        amountMinor: pr.amountMinor.toString(),
      }));
      const lineTotals = variantPrices.map((pr) => ({
        currency: pr.currency,
        totalMinor: (BigInt(pr.amountMinor) * BigInt(item.quantity)).toString(),
      }));
      return {
        id: item.id,
        variantId: item.variantId,
        quantity: item.quantity,
        variant: variant
          ? {
              id: variant.id,
              sku: variant.sku,
              name: variant.name,
              status: variant.status,
            }
          : null,
        prices: priceEntries,
        lineTotals,
      };
    });

    // Aggregate totals per currency across all items
    const totalsMap = new Map<string, bigint>();
    for (const item of items) {
      const vPrices = priceMap.get(item.variantId) ?? [];
      for (const pr of vPrices) {
        const cur = pr.currency;
        const existing = totalsMap.get(cur) ?? 0n;
        totalsMap.set(
          cur,
          existing + BigInt(pr.amountMinor) * BigInt(item.quantity),
        );
      }
    }
    const totals = Array.from(totalsMap.entries()).map(([currency, total]) => ({
      currency,
      totalMinor: total.toString(),
    }));

    return {
      id: cart.id,
      tenantId: cart.tenantId,
      userId: cart.userId,
      status: cart.status,
      items: itemSummaries,
      totals,
      createdAt: cart.createdAt,
      updatedAt: cart.updatedAt,
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
