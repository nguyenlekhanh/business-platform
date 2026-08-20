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

  it('provides a per-request memo inside run() and clears it', () => {
    service.run('tenant-1', () => {
      const memo = service.getMemo();
      expect(memo).toBeDefined();
      memo?.set('k', 'v');
      expect(service.getMemo()?.get('k')).toBe('v');
      service.clearMemo();
      expect(service.getMemo()?.has('k')).toBe(false);
    });
  });

  it('returns the same memo within one request and different memos across requests', () => {
    service.run('tenant-1', () => {
      const first = service.getMemo();
      const second = service.getMemo();
      expect(first).toBe(second);
    });
    service.run('tenant-2', () => {
      expect(service.getMemo()?.size ?? 0).toBe(0);
    });
  });

  it('is undefined outside run()', () => {
    expect(service.getMemo()).toBeUndefined();
  });
});
