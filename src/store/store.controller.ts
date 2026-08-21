import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
  CreateStoreDto,
  StoreListQueryDto,
  UpdateStoreDto,
} from './dto/store.dto';
import {
  RequireAnyPermission,
  RequirePermission,
} from '../rbac/permission.decorator';
import { PERMISSIONS } from '../rbac/permission-catalog';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { StoreService, StoreSummary } from './store.service';

/**
 * Store (generic business unit) endpoints. Guard chain per route: JWT ->
 * TenantResolutionGuard -> PermissionsGuard. Authorization is enforced by
 * PermissionsGuard from the @RequirePermission / @RequireAnyPermission
 * metadata. There is NO tenantId parameter anywhere: the tenant is always the
 * one resolved from the X-Tenant-ID header into the TenantContext.
 */
@ApiTags('stores')
@Controller('stores')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  @Get()
  @RequirePermission(PERMISSIONS.STORE_READ)
  @ApiOperation({ summary: 'List stores in the tenant (paginated)' })
  list(@Query() query: StoreListQueryDto): Promise<Paginated<StoreSummary>> {
    return this.storeService.listStores(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.STORE_READ)
  @ApiOperation({ summary: 'Get a single store' })
  get(@Param('id') id: string): Promise<StoreSummary> {
    return this.storeService.getStore(id);
  }

  @Post()
  @RequireAnyPermission(PERMISSIONS.STORE_CREATE, PERMISSIONS.STORE_MANAGE)
  @ApiOperation({ summary: 'Create a store' })
  create(@Body() dto: CreateStoreDto): Promise<StoreSummary> {
    return this.storeService.createStore(dto);
  }

  @Put(':id')
  @RequireAnyPermission(PERMISSIONS.STORE_UPDATE, PERMISSIONS.STORE_MANAGE)
  @ApiOperation({ summary: 'Update a store' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateStoreDto,
  ): Promise<StoreSummary> {
    return this.storeService.updateStore(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(PERMISSIONS.STORE_DELETE, PERMISSIONS.STORE_MANAGE)
  @ApiOperation({ summary: 'Delete a store' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.storeService.deleteStore(id);
  }
}
