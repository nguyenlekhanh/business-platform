import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
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
import { CreateOrderDto, OrderListQueryDto } from './dto/order.dto';
import { OrderService, OrderSummary } from './order.service';
import { Paginated } from '../common/pagination/paginate';

@ApiTags('orders')
@Controller('orders')
@UseGuards(JwtAuthGuard, TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Post()
  @RequirePermission(PERMISSIONS.ORDER_CREATE)
  @ApiOperation({ summary: 'Create order from items or checkout cart' })
  create(
    @CurrentUser() user: JwtUser,
    @Body() dto: CreateOrderDto,
  ): Promise<OrderSummary> {
    return this.orderService.createOrder(user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.ORDER_READ)
  @ApiOperation({ summary: 'List orders (paginated, filter status)' })
  list(@Query() query: OrderListQueryDto): Promise<Paginated<OrderSummary>> {
    return this.orderService.listOrders(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.ORDER_READ)
  @ApiOperation({ summary: 'Get order by id' })
  get(@Param('id') id: string): Promise<OrderSummary> {
    return this.orderService.getOrder(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.ORDER_DELETE)
  @ApiOperation({ summary: 'Cancel pending order and restock' })
  cancel(@Param('id') id: string): Promise<OrderSummary> {
    return this.orderService.cancelOrder(id);
  }
}
