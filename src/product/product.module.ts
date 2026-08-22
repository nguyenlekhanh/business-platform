import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';

/**
 * Phase 3 U2: products. Guard/interceptor wiring is applied at the
 * controller level (JWT is global); the module only provides the service and
 * imports the tenant/RBAC infrastructure it depends on.
 */
@Module({
  imports: [TenantModule, RbacModule],
  controllers: [ProductController],
  providers: [ProductService],
})
export class ProductModule {}
