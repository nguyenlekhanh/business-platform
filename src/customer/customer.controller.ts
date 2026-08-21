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
import { CustomerService, CustomerSummary } from './customer.service';
import {
  CreateCustomerDto,
  CustomerListQueryDto,
  UpdateCustomerDto,
} from './dto/customer.dto';

/**
 * Customer (rental counterparty) endpoints. Guard chain per route: JWT ->
 * TenantResolutionGuard -> PermissionsGuard. Authorization is enforced by
 * PermissionsGuard from @RequirePermission / @RequireAnyPermission metadata.
 * There is NO tenantId parameter anywhere: the tenant is always the one
 * resolved from the X-Tenant-ID header into the TenantContext.
 */
@ApiTags('customers')
@Controller('customers')
@UseGuards(TenantResolutionGuard, PermissionsGuard)
@UseInterceptors(TenantContextInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Get()
  @RequirePermission(PERMISSIONS.CUSTOMER_READ)
  @ApiOperation({ summary: 'List customers in the tenant (paginated)' })
  list(
    @Query() query: CustomerListQueryDto,
  ): Promise<Paginated<CustomerSummary>> {
    return this.customerService.listCustomers(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CUSTOMER_READ)
  @ApiOperation({ summary: 'Get a single customer' })
  get(@Param('id') id: string): Promise<CustomerSummary> {
    return this.customerService.getCustomer(id);
  }

  @Post()
  @RequireAnyPermission(
    PERMISSIONS.CUSTOMER_CREATE,
    PERMISSIONS.CUSTOMER_MANAGE,
  )
  @ApiOperation({ summary: 'Create a customer' })
  create(@Body() dto: CreateCustomerDto): Promise<CustomerSummary> {
    return this.customerService.createCustomer(dto);
  }

  @Put(':id')
  @RequireAnyPermission(
    PERMISSIONS.CUSTOMER_UPDATE,
    PERMISSIONS.CUSTOMER_MANAGE,
  )
  @ApiOperation({ summary: 'Update a customer' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ): Promise<CustomerSummary> {
    return this.customerService.updateCustomer(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(
    PERMISSIONS.CUSTOMER_DELETE,
    PERMISSIONS.CUSTOMER_MANAGE,
  )
  @ApiOperation({ summary: 'Delete a customer' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.customerService.deleteCustomer(id);
  }
}
