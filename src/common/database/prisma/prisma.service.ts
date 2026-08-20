import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantContextService } from '../../tenant-context/tenant-context.service';
import { applyTenantScoping } from './tenant-scoping.extension';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(tenantContext: TenantContextService) {
    super();
    // Prisma 6 exposes $extends only as an instance method, so the extension
    // is built here and its scoped operations are copied onto this instance.
    // Model namespaces are plain own properties on the extended client.
    applyTenantScoping(this, tenantContext);
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('PostgreSQL connection established');
    } catch (error) {
      this.logger.warn(
        `PostgreSQL connection failed at startup: ${(error as Error).message}. ` +
          'The database health check will report it as down.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('PostgreSQL connection closed');
  }
}
