import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { EquipmentController } from './equipment.controller';
import { EquipmentService } from './equipment.service';

/**
 * Equipment (rentable equipment identity) administration. Imports TenantModule
 * for the guard/interceptor and RbacModule for PermissionsGuard (equipment:*
 * permission evaluation). EquipmentModule does NOT import AssetModule or
 * StoreModule to avoid circular dependencies: assetId is validated through the
 * tenant-scoped Prisma Asset lookup (the extension enforces tenant scoping),
 * which is sufficient and keeps the module graph acyclic.
 */
@Module({
  imports: [TenantModule, RbacModule],
  controllers: [EquipmentController],
  providers: [EquipmentService],
})
export class EquipmentModule {}
