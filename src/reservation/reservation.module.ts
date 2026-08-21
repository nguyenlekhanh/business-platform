import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { ReservationController } from './reservation.controller';
import { ReservationService } from './reservation.service';

/**
 * Reservation (time-bound hold on rentable equipment) administration. Imports
 * TenantModule for the guard/interceptor and RbacModule for PermissionsGuard
 * (reservation:* permission evaluation). Customer/Equipment references are
 * validated through tenant-scoped Prisma lookups (the extension enforces
 * tenant scoping), so no cross-domain module imports are needed and the
 * module graph stays acyclic.
 */
@Module({
  imports: [TenantModule, RbacModule],
  controllers: [ReservationController],
  providers: [ReservationService],
})
export class ReservationModule {}
