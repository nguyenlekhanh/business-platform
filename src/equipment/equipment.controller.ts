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
import { EquipmentService, EquipmentSummary } from './equipment.service';
import {
  CreateEquipmentDto,
  EquipmentListQueryDto,
  UpdateEquipmentDto,
} from './dto/equipment.dto';

/**
 * Equipment (rentable equipment identity) endpoints. Guard chain per route:
 * JWT -> TenantResolutionGuard -> PermissionsGuard. Authorization is enforced
 * by PermissionsGuard from @RequirePermission / @RequireAnyPermission metadata.
 * There is NO tenantId parameter anywhere: the tenant is always the one
 * resolved from the X-Tenant-ID header into the TenantContext.
 */
@ApiTags('equipment')
@Controller('equipment')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class EquipmentController {
  constructor(private readonly equipmentService: EquipmentService) {}

  @Get()
  @RequirePermission(PERMISSIONS.EQUIPMENT_READ)
  @ApiOperation({ summary: 'List equipment records in the tenant (paginated)' })
  list(
    @Query() query: EquipmentListQueryDto,
  ): Promise<Paginated<EquipmentSummary>> {
    return this.equipmentService.listEquipment(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.EQUIPMENT_READ)
  @ApiOperation({ summary: 'Get a single equipment record' })
  get(@Param('id') id: string): Promise<EquipmentSummary> {
    return this.equipmentService.getEquipment(id);
  }

  @Post()
  @RequireAnyPermission(
    PERMISSIONS.EQUIPMENT_CREATE,
    PERMISSIONS.EQUIPMENT_MANAGE,
  )
  @ApiOperation({ summary: 'Create an equipment record for an existing asset' })
  create(@Body() dto: CreateEquipmentDto): Promise<EquipmentSummary> {
    return this.equipmentService.createEquipment(dto);
  }

  @Put(':id')
  @RequireAnyPermission(
    PERMISSIONS.EQUIPMENT_UPDATE,
    PERMISSIONS.EQUIPMENT_MANAGE,
  )
  @ApiOperation({ summary: 'Update an equipment record' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateEquipmentDto,
  ): Promise<EquipmentSummary> {
    return this.equipmentService.updateEquipment(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(
    PERMISSIONS.EQUIPMENT_DELETE,
    PERMISSIONS.EQUIPMENT_MANAGE,
  )
  @ApiOperation({ summary: 'Delete an equipment record' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.equipmentService.deleteEquipment(id);
  }
}
