import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantContextInterceptor } from '../tenant/tenant-context.interceptor';
import { TenantResolutionGuard } from '../tenant/tenant-resolution.guard';
import { RequirePermission } from '../rbac/permission.decorator';
import { PERMISSIONS } from '../rbac/permission-catalog';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { CartService, CartSummary } from './cart.service';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart.dto';

@ApiTags('cart')
@Controller('cart')
@UseGuards(JwtAuthGuard, TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  @RequirePermission(PERMISSIONS.CART_MANAGE)
  @ApiOperation({ summary: 'Get own open cart with live totals' })
  get(@CurrentUser() user: JwtUser): Promise<CartSummary> {
    return this.cartService.getCart(user.userId);
  }

  @Post('items')
  @RequirePermission(PERMISSIONS.CART_MANAGE)
  @ApiOperation({
    summary: 'Add item to own cart (merge if variant already present)',
  })
  addItem(
    @CurrentUser() user: JwtUser,
    @Body() dto: AddCartItemDto,
  ): Promise<CartSummary> {
    return this.cartService.addItem(user.userId, dto);
  }

  @Patch('items/:itemId')
  @RequirePermission(PERMISSIONS.CART_MANAGE)
  @ApiOperation({ summary: 'Update quantity of own cart item' })
  updateItem(
    @CurrentUser() user: JwtUser,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateCartItemDto,
  ): Promise<CartSummary> {
    return this.cartService.updateItem(user.userId, itemId, dto);
  }

  @Delete('items/:itemId')
  @RequirePermission(PERMISSIONS.CART_MANAGE)
  @ApiOperation({ summary: 'Remove item from own cart' })
  removeItem(
    @CurrentUser() user: JwtUser,
    @Param('itemId') itemId: string,
  ): Promise<CartSummary> {
    return this.cartService.removeItem(user.userId, itemId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(PERMISSIONS.CART_MANAGE)
  @ApiOperation({ summary: 'Discard own open cart' })
  async discard(@CurrentUser() user: JwtUser): Promise<void> {
    await this.cartService.discardCart(user.userId);
  }
}
