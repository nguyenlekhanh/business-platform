import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { CreatePaymentDto } from './dto/payment.dto';
import { PaymentService, PaymentSummary } from './payment.service';

@ApiTags('payments')
@Controller('payments')
@UseGuards(JwtAuthGuard, TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post()
  @RequirePermission(PERMISSIONS.PAYMENT_CREATE)
  @ApiOperation({ summary: 'Create payment for order' })
  create(
    @CurrentUser() user: JwtUser,
    @Body() dto: CreatePaymentDto,
  ): Promise<PaymentSummary> {
    return this.paymentService.createPayment(dto);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.PAYMENT_READ)
  @ApiOperation({ summary: 'Get payment by id' })
  get(@Param('id') id: string): Promise<PaymentSummary> {
    return this.paymentService.getPayment(id);
  }

  @Post(':id/capture')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.PAYMENT_MANAGE)
  @ApiOperation({ summary: 'Capture payment and mark order paid' })
  capture(@Param('id') id: string): Promise<PaymentSummary> {
    return this.paymentService.capturePayment(id);
  }

  @Post(':id/fail')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.PAYMENT_MANAGE)
  @ApiOperation({ summary: 'Fail payment' })
  fail(@Param('id') id: string): Promise<PaymentSummary> {
    return this.paymentService.failPayment(id);
  }
}
