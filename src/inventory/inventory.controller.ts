import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantContextInterceptor } from '../tenant/tenant-context.interceptor';
import { TenantResolutionGuard } from '../tenant/tenant-resolution.guard';
import { RequirePermission } from '../rbac/permission.decorator';
import { PERMISSIONS } from '../rbac/permission-catalog';
import { PermissionsGuard } from '../rbac/permissions.guard';
import {
  AdjustInventoryDto,
  AdjustStoreInventoryDto,
} from './dto/inventory.dto';
import { InventoryService, InventorySummary } from './inventory.service';

/**
 * Inventory — Phase 3 U4 endpoints (global pool, unchanged) plus the
 * Phase 4 P4-U3 store-scoped pool endpoints.
 *
 * Store context for the store endpoints is the PATH PARAM storeId of an
 * existing same-tenant Store — validated through a tenant-scoped lookup
 * (foreign/unknown store -> uniform 404 'Store not found', the Asset.storeId
 * precedent). The Phase 3 routes keep their exact contracts (global pool).
 */
@ApiTags('inventory')
@Controller('inventory')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  // ---- Phase 3 routes (tenant-global pool; contracts unchanged) --------

  @Get(':variantId')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  @ApiOperation({
    summary: 'Get inventory for a variant (0 if never adjusted)',
  })
  get(@Param('variantId') variantId: string): Promise<InventorySummary> {
    return this.inventoryService.getInventory(variantId);
  }

  @Post('adjust')
  @RequirePermission(PERMISSIONS.INVENTORY_MANAGE)
  @ApiOperation({
    summary: 'Adjust inventory (atomic, guarded against negative stock)',
  })
  adjust(@Body() dto: AdjustInventoryDto): Promise<InventorySummary> {
    return this.inventoryService.adjust(dto);
  }

  // ---- Phase 4 P4-U3 routes (store-scoped pools) ------------------------

  @Get('stores/:storeId/variants/:variantId')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  @ApiOperation({
    summary: "Get a store's inventory for a variant (0 if none)",
  })
  getStoreInventory(
    @Param('storeId') storeId: string,
    @Param('variantId') variantId: string,
  ): Promise<InventorySummary> {
    return this.inventoryService.getScopedInventory(
      { kind: 'store', storeId },
      variantId,
    );
  }

  @Post('stores/:storeId/adjust')
  @RequirePermission(PERMISSIONS.INVENTORY_MANAGE)
  @ApiOperation({
    summary: "Adjust a store's inventory (atomic, guarded, store-isolated)",
  })
  adjustStoreInventory(
    @Param('storeId') storeId: string,
    @Body() dto: AdjustStoreInventoryDto,
  ): Promise<InventorySummary> {
    return this.inventoryService.adjustScoped({ kind: 'store', storeId }, dto);
  }
}
