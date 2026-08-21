import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';

/**
 * Customer (rental counterparty) administration. Imports TenantModule for the
 * guard/interceptor and RbacModule for PermissionsGuard (customer:* permission
 * evaluation). No cross-domain imports are needed: the customer model has no
 * relations beyond its tenant.
 */
@Module({
  imports: [TenantModule, RbacModule],
  controllers: [CustomerController],
  providers: [CustomerService],
})
export class CustomerModule {}
