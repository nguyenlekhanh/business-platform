import { Controller, Get, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Tenant } from '@prisma/client';
import { CurrentTenant } from './current-tenant.decorator';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantResolutionGuard } from './tenant-resolution.guard';

/**
 * TEST-ONLY endpoint that exercises the full tenant resolution stack:
 * JWT authentication -> tenant resolution -> AsyncLocalStorage context.
 * It exists only to prove the architecture in tests and must not be used as a
 * reference for production routes.
 */
@ApiTags('tenant')
@Controller('tenant/_test')
export class TenantTestController {
  constructor(private readonly tenantContext: TenantContextService) {}

  @Get('context')
  @UseGuards(TenantResolutionGuard)
  @UseInterceptors(TenantContextInterceptor)
  @ApiOperation({ summary: 'TEST-ONLY: return the resolved tenant context' })
  context(@CurrentTenant() tenant: Tenant): {
    tenantId: string;
    tenantName: string;
    contextTenantId: string;
  } {
    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      contextTenantId: this.tenantContext.requireTenantId(),
    };
  }
}
