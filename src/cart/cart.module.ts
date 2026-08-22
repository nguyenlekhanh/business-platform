import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

@Module({
  imports: [TenantModule, RbacModule],
  controllers: [CartController],
  providers: [CartService],
})
export class CartModule {}
