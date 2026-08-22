import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [TenantModule, RbacModule],
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
