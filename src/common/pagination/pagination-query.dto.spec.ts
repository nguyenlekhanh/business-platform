import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PageQueryDto,
} from './pagination-query.dto';

describe('PageQueryDto', () => {
  // Mirrors the controller ValidationPipe options so these unit tests verify
  // exactly what the HTTP layer enforces (whitelist + forbidNonWhitelisted).
  const validateLike = (value: Record<string, unknown>) =>
    validate(plainToInstance(PageQueryDto, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  it('accepts an empty query (all params optional)', async () => {
    expect(await validateLike({})).toHaveLength(0);
  });

  it('accepts a full valid query', async () => {
    const errors = await validateLike({
      limit: 50,
      cursor: 'abc123',
      order: 'desc',
    });
    expect(errors).toHaveLength(0);
  });

  it('coerces a string limit from query-string form', async () => {
    const instance = plainToInstance(PageQueryDto, { limit: '25' });
    expect(instance.limit).toBe(25);
    expect(await validate(instance)).toHaveLength(0);
  });

  it('rejects limit above the hard maximum', async () => {
    const errors = await validateLike({ limit: MAX_PAGE_SIZE + 1 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.property).toBe('limit');
  });

  it('rejects limit below 1', async () => {
    const errors = await validateLike({ limit: 0 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.property).toBe('limit');
  });

  it('rejects a non-integer limit', async () => {
    const errors = await validateLike({ limit: 2.5 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-numeric limit', async () => {
    const errors = await validateLike({ limit: 'many' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an invalid order direction', async () => {
    const errors = await validateLike({ order: 'up' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.property).toBe('order');
  });

  it('rejects unknown query fields (forbidNonWhitelisted)', async () => {
    const errors = await validateLike({ tenantId: 'tenant-9' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('documents the pagination constants contract', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(20);
    expect(MAX_PAGE_SIZE).toBe(100);
  });
});
