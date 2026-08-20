import { InternalServerErrorException } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';

describe('TenantContextService', () => {
  let service: TenantContextService;

  beforeEach(() => {
    service = new TenantContextService();
  });

  it('exposes the tenant id inside run()', () => {
    service.run('tenant-1', () => {
      expect(service.getTenantId()).toBe('tenant-1');
      expect(service.requireTenantId()).toBe('tenant-1');
    });
  });

  it('returns the callback result', () => {
    const result = service.run('tenant-1', () => 'done');
    expect(result).toBe('done');
  });

  it('survives asynchronous operations inside the context', async () => {
    await service.run('tenant-1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(service.getTenantId()).toBe('tenant-1');
      expect(service.requireTenantId()).toBe('tenant-1');
    });
  });

  it('isolates concurrent runs from one another', async () => {
    const values = await Promise.all([
      service.run('tenant-a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return service.getTenantId();
      }),
      service.run('tenant-b', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return service.getTenantId();
      }),
    ]);
    expect(values).toEqual(['tenant-a', 'tenant-b']);
  });

  it('is not active outside run()', () => {
    expect(service.getTenantId()).toBeUndefined();
    expect(() => service.requireTenantId()).toThrow(
      InternalServerErrorException,
    );
  });
});
