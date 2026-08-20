import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateTenantDto } from './dto/tenant-admin.dto';

describe('UpdateTenantDto', () => {
  // Mirrors the controller ValidationPipe options so these unit tests verify
  // exactly what the HTTP layer enforces (whitelist + forbidNonWhitelisted).
  const validateLike = (value: Record<string, unknown>) =>
    validate(plainToInstance(UpdateTenantDto, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  it('accepts a valid full update (name, slug, settings)', async () => {
    const errors = await validateLike({
      name: 'Acme Inc',
      slug: 'acme-inc',
      settings: { theme: 'dark', currency: 'USD' },
    });

    expect(errors).toHaveLength(0);
  });

  it('accepts a partial update (single field)', async () => {
    const errors = await validateLike({ name: 'Acme Inc' });

    expect(errors).toHaveLength(0);
  });

  it('accepts an empty payload (no-op update)', async () => {
    const errors = await validateLike({});

    expect(errors).toHaveLength(0);
  });

  it('rejects a client-supplied id', async () => {
    const errors = await validateLike({ id: 'tenant-9', name: 'Acme' });

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a client-supplied status', async () => {
    const errors = await validateLike({ status: 'DISABLED' });

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a client-supplied tenantId', async () => {
    const errors = await validateLike({ tenantId: 'tenant-9', name: 'Acme' });

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an empty name', async () => {
    const errors = await validateLike({ name: '' });

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an over-long name', async () => {
    const errors = await validateLike({ name: 'x'.repeat(201) });

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a slug with invalid characters', async () => {
    const errors = await validateLike({ slug: 'Bad Slug!' });

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an uppercase slug', async () => {
    const errors = await validateLike({ slug: 'AcmeInc' });

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects non-object settings', async () => {
    const errors = await validateLike({ settings: 'nope' });

    expect(errors.length).toBeGreaterThan(0);
  });
});
