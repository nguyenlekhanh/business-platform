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
import { AdjustInventoryDto } from './dto/inventory.dto';
import { InventoryService, InventorySummary } from './inventory.service';

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
}
