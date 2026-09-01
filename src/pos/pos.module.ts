import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { OrderModule } from '../order/order.module';
import { PaymentModule } from '../payment/payment.module';
import { PosDeviceService } from './pos-device.service';
import { PosSessionService } from './pos-session.service';
import { PosSaleService } from './pos-sale.service';
import { PosOperationService } from './pos-operation.service';
import { PosSyncService } from './pos-sync.service';
import { PosController } from './pos.controller';

@Module({
  imports: [TenantModule, RbacModule, OrderModule, PaymentModule],
  controllers: [PosController],
  providers: [
    PosDeviceService,
    PosSessionService,
    PosSaleService,
    PosOperationService,
    PosSyncService,
  ],
  exports: [
    PosDeviceService,
    PosSessionService,
    PosSaleService,
    PosOperationService,
    PosSyncService,
  ],
})
export class PosModule {}
