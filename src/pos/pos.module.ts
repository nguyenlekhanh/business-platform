import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { TenantModule } from '../tenant/tenant.module';
import { PosDeviceService } from './pos-device.service';
import { PosSessionService } from './pos-session.service';
import { PosController } from './pos.controller';

@Module({
  imports: [TenantModule, RbacModule],
  controllers: [PosController],
  providers: [PosDeviceService, PosSessionService],
  exports: [PosDeviceService, PosSessionService],
})
export class PosModule {}
