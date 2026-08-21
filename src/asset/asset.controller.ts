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
import { PERMISSIONS } from '../rbac/permission-catalog';
import {
  RequireAnyPermission,
  RequirePermission,
} from '../rbac/permission.decorator';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { TenantContextInterceptor } from '../tenant/tenant-context.interceptor';
import { TenantResolutionGuard } from '../tenant/tenant-resolution.guard';
import { AssetService, AssetSummary } from './asset.service';
import {
  AssetListQueryDto,
  CreateAssetDto,
  UpdateAssetDto,
} from './dto/asset.dto';

/**
 * Asset (generic equipment/resource) endpoints. Guard chain per route: JWT ->
 * TenantResolutionGuard -> PermissionsGuard. Authorization is enforced by
 * PermissionsGuard from @RequirePermission / @RequireAnyPermission metadata.
 * There is NO tenantId parameter anywhere: the tenant is always the one
 * resolved from the X-Tenant-ID header into the TenantContext.
 */
@ApiTags('assets')
@Controller('assets')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class AssetController {
  constructor(private readonly assetService: AssetService) {}

  @Get()
  @RequirePermission(PERMISSIONS.ASSET_READ)
  @ApiOperation({ summary: 'List assets in the tenant (paginated)' })
  list(@Query() query: AssetListQueryDto): Promise<Paginated<AssetSummary>> {
    return this.assetService.listAssets(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.ASSET_READ)
  @ApiOperation({ summary: 'Get a single asset' })
  get(@Param('id') id: string): Promise<AssetSummary> {
    return this.assetService.getAsset(id);
  }

  @Post()
  @RequireAnyPermission(PERMISSIONS.ASSET_CREATE, PERMISSIONS.ASSET_MANAGE)
  @ApiOperation({ summary: 'Create an asset' })
  create(@Body() dto: CreateAssetDto): Promise<AssetSummary> {
    return this.assetService.createAsset(dto);
  }

  @Put(':id')
  @RequireAnyPermission(PERMISSIONS.ASSET_UPDATE, PERMISSIONS.ASSET_MANAGE)
  @ApiOperation({ summary: 'Update an asset' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAssetDto,
  ): Promise<AssetSummary> {
    return this.assetService.updateAsset(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(PERMISSIONS.ASSET_DELETE, PERMISSIONS.ASSET_MANAGE)
  @ApiOperation({ summary: 'Delete an asset' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.assetService.deleteAsset(id);
  }
}
