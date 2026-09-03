import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

/**
 * Phase 5 P5-U4: the Service Booking lifecycle (Architecture A:
 * Service-Catalog Booking). Guard/interceptor wiring is applied at the
 * controller level (JWT is global); the module only provides the service
 * and imports the tenant/RBAC infrastructure it depends on.
 */
@Module({
  imports: [TenantModule, RbacModule],
  controllers: [BookingController],
  providers: [BookingService],
})
export class BookingModule {}