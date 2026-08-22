import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './common/database/prisma/prisma.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingModule } from './common/logging/logging.module';
import { RedisModule } from './common/redis/redis.module';
import { TenantContextModule } from './common/tenant-context/tenant-context.module';
import { HealthModule } from './health/health.module';
import { AssetModule } from './asset/asset.module';
import { CategoryModule } from './category/category.module';
import { CustomerModule } from './customer/customer.module';
import { ProductModule } from './product/product.module';
import { EquipmentModule } from './equipment/equipment.module';
import { MemberModule } from './member/member.module';
import { RbacModule } from './rbac/rbac.module';
import { ReservationModule } from './reservation/reservation.module';
import { StoreModule } from './store/store.module';
import { TenantAdminModule } from './tenant-admin/tenant-admin.module';
import { TenantModule } from './tenant/tenant.module';
import { validateEnv } from './common/config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      cache: true,
    }),
    LoggingModule,
    PrismaModule,
    RedisModule,
    TenantContextModule,
    HealthModule,
    AuthModule,
    TenantModule,
    RbacModule,
    MemberModule,
    TenantAdminModule,
    StoreModule,
    AssetModule,
    EquipmentModule,
    CustomerModule,
    ReservationModule,
    CategoryModule,
    ProductModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
