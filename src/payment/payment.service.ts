import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Payment } from '@prisma/client';
import { PrismaService } from '../common/database/prisma/prisma.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { CreatePaymentDto } from './dto/payment.dto';

const ORDER_NOT_FOUND = 'Order not found';
const NOT_PENDING = 'Order is not pending';
const CAPTURED_EXISTS = 'Payment already captured for this order';

export interface PaymentSummary {
  id: string;
  tenantId: string;
  orderId: string;
  status: string;
  method: string;
  amountMinor: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async createPayment(dto: CreatePaymentDto): Promise<PaymentSummary> {
    this.assertTenantContext();

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: dto.orderId },
      });
      if (!order) throw new NotFoundException(ORDER_NOT_FOUND);

      if (order.status !== 'PENDING') throw new ConflictException(NOT_PENDING);

      const existingCaptured = await tx.payment.findFirst({
        where: { orderId: dto.orderId, status: 'CAPTURED' },
      });
      if (existingCaptured) throw new ConflictException(CAPTURED_EXISTS);

      const payment = await tx.payment.create({
        data: {
          tenantId: order.tenantId,
          orderId: dto.orderId,
          status: 'PROCESSING',
          method: dto.method,
          amountMinor: order.subtotalMinor,
          currency: order.currency,
        },
      });

      return this.toSummary(payment);
    });
  }

  private toSummary(payment: Payment): PaymentSummary {
    return {
      id: payment.id,
      tenantId: payment.tenantId,
      orderId: payment.orderId,
      status: payment.status,
      method: payment.method,
      amountMinor: payment.amountMinor.toString(),
      currency: payment.currency,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    };
  }

  private assertTenantContext(): void {
    this.tenantContext.requireTenantId();
  }
}
