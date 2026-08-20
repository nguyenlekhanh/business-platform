import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { MemberController } from './member.controller';
import { MemberService } from './member.service';

/**
 * Membership administration: listing/getting tenant members and updating
 * membership status. Imports TenantModule for the guard/interceptor and
 * RbacModule for PermissionService (member:read / member:manage evaluation).
 */
@Module({
  imports: [TenantModule, RbacModule],
  controllers: [MemberController],
  providers: [MemberService],
})
export class MemberModule {}
