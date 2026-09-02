import {
  Body,
  Controller,
  Get,
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
  RequireAnyPermission,
  RequirePermission,
} from '../rbac/permission.decorator';
import { PERMISSIONS } from '../rbac/permission-catalog';
import { PermissionsGuard } from '../rbac/permissions.guard';
import {
  CreateServiceDto,
  ServiceListQueryDto,
  UpdateServiceDto,
} from './dto/service.dto';
import { ServiceService, ServiceSummary } from './service.service';

/**
 * Service catalog endpoints — Phase 5 P5-U1 (B2: catalog definition only).
 *
 * PATCH is used for partial updates (the Phase-3+ Commerce convention on
 * new domains, approved D2). Guard chain per route: JWT (global) ->
 * TenantResolutionGuard -> PermissionsGuard; authorization is enforced by
 * PermissionsGuard from the @RequirePermission / @RequireAnyPermission
 * metadata. There is NO tenantId parameter anywhere: the tenant is always
 * the one resolved from the X-Tenant-ID header into the TenantContext.
 *
 * Deliberately NO delete route: the approved P5-U1 scope has no deletion
 * semantics (soft-retirement via PATCH status=ARCHIVED is the established
 * catalog convention; a future Booking FK will govern deletion the way
 * Product's does for Category).
 *
 * Approved B21 mapping on the three keys:
 *   GET  -> service:read
 *   POST -> service:create OR service:manage
 *   PATCH-> service:manage
 */
@ApiTags('services')
@Controller('services')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class ServiceController {
  constructor(private readonly serviceService: ServiceService) {}

  @Get()
  @RequirePermission(PERMISSIONS.SERVICE_READ)
  @ApiOperation({ summary: 'List services in the tenant (paginated)' })
  list(
    @Query() query: ServiceListQueryDto,
  ): Promise<Paginated<ServiceSummary>> {
    return this.serviceService.listServices(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.SERVICE_READ)
  @ApiOperation({ summary: 'Get a single service' })
  get(@Param('id') id: string): Promise<ServiceSummary> {
    return this.serviceService.getService(id);
  }

  @Post()
  @RequireAnyPermission(PERMISSIONS.SERVICE_CREATE, PERMISSIONS.SERVICE_MANAGE)
  @ApiOperation({ summary: 'Create a service catalog entry' })
  create(@Body() dto: CreateServiceDto): Promise<ServiceSummary> {
    return this.serviceService.createService(dto);
  }

  @Patch(':id')
  @RequireAnyPermission(PERMISSIONS.SERVICE_MANAGE)
  @ApiOperation({ summary: 'Partially update a service catalog entry' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateServiceDto,
  ): Promise<ServiceSummary> {
    return this.serviceService.updateService(id, dto);
  }
}
