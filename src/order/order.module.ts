import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

@Module({
  imports: [TenantModule, RbacModule],
  controllers: [OrderController],
  providers: [OrderService],
})
export class OrderModule {}
