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
  CategoryListQueryDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './dto/category.dto';
import {
  RequireAnyPermission,
  RequirePermission,
} from '../rbac/permission.decorator';
import { PERMISSIONS } from '../rbac/permission-catalog';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { CategoryService, CategorySummary } from './category.service';

/**
 * Category (product taxonomy) endpoints — Phase 3 Commerce conventions:
 * PATCH is used for partial updates (approved D2; existing non-commerce
 * domains keep their PUT convention and are NOT rewritten). Guard chain per
 * route: JWT -> TenantResolutionGuard -> PermissionsGuard. Authorization is
 * enforced by PermissionsGuard from the @RequirePermission /
 * @RequireAnyPermission metadata. There is NO tenantId parameter anywhere:
 * the tenant is always the one resolved from the X-Tenant-ID header into the
 * TenantContext.
 */
@ApiTags('categories')
@Controller('categories')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @Get()
  @RequirePermission(PERMISSIONS.CATEGORY_READ)
  @ApiOperation({ summary: 'List categories in the tenant (paginated)' })
  list(
    @Query() query: CategoryListQueryDto,
  ): Promise<Paginated<CategorySummary>> {
    return this.categoryService.listCategories(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CATEGORY_READ)
  @ApiOperation({ summary: 'Get a single category' })
  get(@Param('id') id: string): Promise<CategorySummary> {
    return this.categoryService.getCategory(id);
  }

  @Post()
  @RequireAnyPermission(
    PERMISSIONS.CATEGORY_CREATE,
    PERMISSIONS.CATEGORY_MANAGE,
  )
  @ApiOperation({ summary: 'Create a category' })
  create(@Body() dto: CreateCategoryDto): Promise<CategorySummary> {
    return this.categoryService.createCategory(dto);
  }

  @Patch(':id')
  @RequireAnyPermission(
    PERMISSIONS.CATEGORY_UPDATE,
    PERMISSIONS.CATEGORY_MANAGE,
  )
  @ApiOperation({ summary: 'Partially update a category' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategorySummary> {
    return this.categoryService.updateCategory(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(
    PERMISSIONS.CATEGORY_DELETE,
    PERMISSIONS.CATEGORY_MANAGE,
  )
  @ApiOperation({ summary: 'Delete a category' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.categoryService.deleteCategory(id);
  }
}
