import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { ServiceController } from './service.controller';
import { ServiceService } from './service.service';

/**
 * Phase 5 P5-U1: the Service catalog (tenant-scoped bookable-service
 * DEFINITION only). Guard/interceptor wiring is applied at the controller
 * level (JWT is global); the module only provides the service and imports
 * the tenant/RBAC infrastructure it depends on.
 */
@Module({
  imports: [TenantModule, RbacModule],
  controllers: [ServiceController],
  providers: [ServiceService],
})
export class ServiceModule {}
