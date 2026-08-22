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
  CreateProductDto,
  ProductListQueryDto,
  UpdateProductDto,
} from './dto/product.dto';
import {
  RequireAnyPermission,
  RequirePermission,
} from '../rbac/permission.decorator';
import { PERMISSIONS } from '../rbac/permission-catalog';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProductService, ProductSummary } from './product.service';

/**
 * Product (catalog item) endpoints — Phase 3 Commerce conventions:
 * PATCH is used for partial updates (approved D2; the status field carries
 * the archive flow). Guard chain per route: JWT -> TenantResolutionGuard ->
 * PermissionsGuard. Authorization is enforced by PermissionsGuard from the
 * @RequirePermission / @RequireAnyPermission metadata. There is NO tenantId
 * parameter anywhere: the tenant is always the one resolved from the
 * X-Tenant-ID header into the TenantContext.
 */
@ApiTags('products')
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
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  @RequirePermission(PERMISSIONS.PRODUCT_READ)
  @ApiOperation({ summary: 'List products in the tenant (paginated)' })
  list(
    @Query() query: ProductListQueryDto,
  ): Promise<Paginated<ProductSummary>> {
    return this.productService.listProducts(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.PRODUCT_READ)
  @ApiOperation({ summary: 'Get a single product' })
  get(@Param('id') id: string): Promise<ProductSummary> {
    return this.productService.getProduct(id);
  }

  @Post()
  @RequireAnyPermission(PERMISSIONS.PRODUCT_CREATE, PERMISSIONS.PRODUCT_MANAGE)
  @ApiOperation({ summary: 'Create a product' })
  create(@Body() dto: CreateProductDto): Promise<ProductSummary> {
    return this.productService.createProduct(dto);
  }

  @Patch(':id')
  @RequireAnyPermission(PERMISSIONS.PRODUCT_UPDATE, PERMISSIONS.PRODUCT_MANAGE)
  @ApiOperation({ summary: 'Partially update a product' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<ProductSummary> {
    return this.productService.updateProduct(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(PERMISSIONS.PRODUCT_DELETE, PERMISSIONS.PRODUCT_MANAGE)
  @ApiOperation({ summary: 'Delete a product' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.productService.deleteProduct(id);
  }
}
