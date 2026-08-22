import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { CategoryController } from './category.controller';
import { CategoryService } from './category.service';

/**
 * Phase 3 U1: product categories. Guard/interceptor wiring is applied at the
 * controller level (JWT is global); the module only provides the service and
 * imports the tenant/RBAC infrastructure it depends on.
 */
@Module({
  imports: [TenantModule, RbacModule],
  controllers: [CategoryController],
  providers: [CategoryService],
})
export class CategoryModule {}
