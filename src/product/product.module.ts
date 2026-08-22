import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import {
  ProductVariantsController,
  VariantItemController,
} from './product-variant.controller';
import { ProductVariantService } from './product-variant.service';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';

/**
 * Phase 3 U2/U3: products + their variants/prices (one bounded context).
 * Guard/interceptor wiring is applied at the controller level (JWT is
 * global); the module only provides the services and imports the tenant/RBAC
 * infrastructure they depend on.
 */
@Module({
  imports: [TenantModule, RbacModule],
  controllers: [
    ProductController,
    ProductVariantsController,
    VariantItemController,
  ],
  providers: [ProductService, ProductVariantService],
})
export class ProductModule {}
