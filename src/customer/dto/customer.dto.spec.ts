import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCustomerDto, UpdateCustomerDto } from './customer.dto';

describe('Customer DTOs', () => {
  // Mirrors the controller ValidationPipe options so these unit tests verify
  // exactly what the HTTP layer enforces (whitelist + forbidNonWhitelisted).
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  const valid = {
    name: 'Alpha Construction',
    code: 'CUST-001',
  };

  describe('CreateCustomerDto', () => {
    it('accepts a minimal valid create payload', async () => {
      const errors = await validateLike(CreateCustomerDto, valid);
      expect(errors).toHaveLength(0);
    });

    it('accepts optional contact fields and status', async () => {
      const errors = await validateLike(CreateCustomerDto, {
        ...valid,
        email: 'ops@alpha.example',
        phone: '+1-555-0100',
        notes: 'Net 30',
        status: 'INACTIVE',
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects a missing name', async () => {
      const errors = await validateLike(CreateCustomerDto, {
        code: 'CUST-001',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an empty name', async () => {
      const errors = await validateLike(CreateCustomerDto, {
        ...valid,
        name: '',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a missing code', async () => {
      const errors = await validateLike(CreateCustomerDto, {
        name: 'Alpha Construction',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an invalid email', async () => {
      const errors = await validateLike(CreateCustomerDto, {
        ...valid,
        email: 'not-an-email',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an invalid status', async () => {
      const errors = await validateLike(CreateCustomerDto, {
        ...valid,
        status: 'PAUSED',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied tenantId (forbidNonWhitelisted)', async () => {
      const errors = await validateLike(CreateCustomerDto, {
        ...valid,
        tenantId: 'tenant-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied id', async () => {
      const errors = await validateLike(CreateCustomerDto, {
        ...valid,
        id: 'cust-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects arbitrary unknown fields (roleId/permissionIds/storeId)', async () => {
      const errors = await validateLike(CreateCustomerDto, {
        ...valid,
        roleId: 'role-9',
        permissionIds: ['perm-1'],
        storeId: 'store-1',
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('UpdateCustomerDto', () => {
    it('accepts a partial update', async () => {
      const errors = await validateLike(UpdateCustomerDto, {
        phone: '+1-555-0199',
        status: 'ACTIVE',
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects a non-string optional field', async () => {
      const errors = await validateLike(UpdateCustomerDto, { phone: 123 });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied tenantId', async () => {
      const errors = await validateLike(UpdateCustomerDto, {
        tenantId: 'tenant-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a client-supplied id', async () => {
      const errors = await validateLike(UpdateCustomerDto, {
        id: 'cust-9',
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an invalid status', async () => {
      const errors = await validateLike(UpdateCustomerDto, {
        status: 'ARCHIVED',
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
