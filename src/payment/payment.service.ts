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
const PAYMENT_NOT_FOUND = 'Payment not found';
const NOT_PROCESSING = 'Payment is not in processing state';
const ALREADY_CAPTURED = 'Payment already captured';
const ALREADY_FAILED = 'Payment already failed';
const FAILED_CANNOT_CAPTURE = 'Failed payment cannot be captured';
const CAPTURED_CANNOT_FAIL = 'Captured payment cannot be failed';

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

  async getPayment(paymentId: string): Promise<PaymentSummary> {
    this.assertTenantContext();
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) throw new NotFoundException(PAYMENT_NOT_FOUND);
    return this.toSummary(payment);
  }

  async capturePayment(paymentId: string): Promise<PaymentSummary> {
    this.assertTenantContext();

    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
      });
      if (!payment) throw new NotFoundException(PAYMENT_NOT_FOUND);

      if (payment.status === 'CAPTURED') {
        return this.toSummary(payment);
      }

      if (payment.status === 'FAILED') {
        throw new ConflictException(FAILED_CANNOT_CAPTURE);
      }

      if (payment.status !== 'PROCESSING') {
        throw new ConflictException(NOT_PROCESSING);
      }

      const updatedPayment = await tx.payment.updateMany({
        where: { id: paymentId, status: 'PROCESSING' },
        data: { status: 'CAPTURED' },
      });
      if (updatedPayment.count === 0) {
        throw new ConflictException(ALREADY_CAPTURED);
      }

      const updatedOrder = await tx.order.updateMany({
        where: { id: payment.orderId, status: 'PENDING' },
        data: { status: 'PAID' },
      });
      if (updatedOrder.count === 0) {
        throw new ConflictException(NOT_PENDING);
      }

      const updated = await tx.payment.findUnique({ where: { id: paymentId } });
      return this.toSummary(updated!);
    });
  }

  async failPayment(paymentId: string): Promise<PaymentSummary> {
    this.assertTenantContext();

    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
      });
      if (!payment) throw new NotFoundException(PAYMENT_NOT_FOUND);

      if (payment.status === 'FAILED') {
        return this.toSummary(payment);
      }

      if (payment.status === 'CAPTURED') {
        throw new ConflictException(CAPTURED_CANNOT_FAIL);
      }

      if (payment.status !== 'PROCESSING') {
        throw new ConflictException(NOT_PROCESSING);
      }

      const updated = await tx.payment.updateMany({
        where: { id: paymentId, status: 'PROCESSING' },
        data: { status: 'FAILED' },
      });
      if (updated.count === 0) {
        throw new ConflictException(ALREADY_FAILED);
      }

      const updatedPayment = await tx.payment.findUnique({
        where: { id: paymentId },
      });
      return this.toSummary(updatedPayment!);
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
