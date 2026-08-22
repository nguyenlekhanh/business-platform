import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Paginated } from '../common/pagination/paginate';
import { TenantContextInterceptor } from '../tenant/tenant-context.interceptor';
import { TenantResolutionGuard } from '../tenant/tenant-resolution.guard';
import {
  CreateProductVariantDto,
  ProductVariantListQueryDto,
  PutPriceDto,
  UpdateProductVariantDto,
} from './dto/product-variant.dto';
import {
  RequireAnyPermission,
  RequirePermission,
} from '../rbac/permission.decorator';
import { PERMISSIONS } from '../rbac/permission-catalog';
import { PermissionsGuard } from '../rbac/permissions.guard';
import {
  PriceSummary,
  ProductVariantService,
  ProductVariantSummary,
} from './product-variant.service';

/**
 * Variant/price endpoints — Phase 3 U3. Variants and prices are product
 * internals (approved bounded context): they reuse the product:* permission
 * keys — NO new catalog entries. Guard chain per route: JWT ->
 * TenantResolutionGuard -> PermissionsGuard. PATCH carries the archive flow
 * (D2); PUT /variants/:id/price is the approved upsert of the CURRENT price
 * for one (variant, currency) pair. No tenantId/id in any body.
 */
@ApiTags('product-variants')
@Controller('products')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class ProductVariantsController {
  constructor(private readonly variantService: ProductVariantService) {}

  @Get(':id/variants')
  @RequirePermission(PERMISSIONS.PRODUCT_READ)
  @ApiOperation({ summary: 'List variants of a product (paginated)' })
  list(
    @Param('id') id: string,
    @Query() query: ProductVariantListQueryDto,
  ): Promise<Paginated<ProductVariantSummary>> {
    return this.variantService.listVariants(id, query);
  }

  @Post(':id/variants')
  @RequireAnyPermission(PERMISSIONS.PRODUCT_CREATE, PERMISSIONS.PRODUCT_MANAGE)
  @ApiOperation({ summary: 'Create a variant under a product' })
  create(
    @Param('id') id: string,
    @Body() dto: CreateProductVariantDto,
  ): Promise<ProductVariantSummary> {
    return this.variantService.createVariant(id, dto);
  }
}

@ApiTags('product-variants')
@Controller('variants')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class VariantItemController {
  constructor(private readonly variantService: ProductVariantService) {}

  @Patch(':id')
  @RequireAnyPermission(PERMISSIONS.PRODUCT_UPDATE, PERMISSIONS.PRODUCT_MANAGE)
  @ApiOperation({ summary: 'Partially update a variant' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductVariantDto,
  ): Promise<ProductVariantSummary> {
    return this.variantService.updateVariant(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(PERMISSIONS.PRODUCT_DELETE, PERMISSIONS.PRODUCT_MANAGE)
  @ApiOperation({ summary: 'Delete a variant (cascades its prices)' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.variantService.deleteVariant(id);
  }

  @Put(':id/price')
  @RequireAnyPermission(PERMISSIONS.PRODUCT_UPDATE, PERMISSIONS.PRODUCT_MANAGE)
  @ApiOperation({
    summary:
      'Upsert the current price for one (variant, currency) pair (overwrite, no history)',
  })
  putPrice(
    @Param('id') id: string,
    @Body() dto: PutPriceDto,
  ): Promise<PriceSummary> {
    return this.variantService.putPrice(id, dto);
  }
}
