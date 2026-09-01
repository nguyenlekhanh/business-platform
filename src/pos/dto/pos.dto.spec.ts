import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreatePosDeviceDto,
  CreatePosSaleDto,
  OpenPosSessionDto,
  PosDeviceListQueryDto,
  RecordOfflineSaleIntentDto,
  UpdatePosDeviceDto,
} from './pos.dto';

describe('POS DTOs', () => {
  const validateLike = (dtoClass: object, value: Record<string, unknown>) =>
    validate(plainToInstance(dtoClass as never, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false },
    });

  describe('CreatePosDeviceDto', () => {
    it('accepts valid storeId and name', async () => {
      expect(
        await validateLike(CreatePosDeviceDto, {
          storeId: 'store-1',
          name: 'Front counter',
        }),
      ).toHaveLength(0);
    });

    it('rejects missing storeId or name', async () => {
      expect(
        (await validateLike(CreatePosDeviceDto, { name: 'x' })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(CreatePosDeviceDto, { storeId: 's' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects empty strings', async () => {
      expect(
        (await validateLike(CreatePosDeviceDto, { storeId: '', name: 'x' }))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(CreatePosDeviceDto, { storeId: 's', name: '' }))
          .length,
      ).toBeGreaterThan(0);
    });

    it('rejects name exceeding max length', async () => {
      expect(
        (
          await validateLike(CreatePosDeviceDto, {
            storeId: 's',
            name: 'x'.repeat(201),
          })
        ).length,
      ).toBeGreaterThan(0);
    });

    it('rejects tenantId, status, credentialHash, id, timestamps, unknown fields', async () => {
      const injections = [
        { storeId: 's', name: 'x', tenantId: 't' },
        { storeId: 's', name: 'x', status: 'ACTIVE' },
        { storeId: 's', name: 'x', credentialHash: 'h' },
        { storeId: 's', name: 'x', credential: 'c' },
        { storeId: 's', name: 'x', id: 'd' },
        { storeId: 's', name: 'x', createdAt: new Date().toISOString() },
        { storeId: 's', name: 'x', bogus: true },
      ];
      for (const payload of injections) {
        expect(
          (await validateLike(CreatePosDeviceDto, payload)).length,
        ).toBeGreaterThan(0);
      }
    });
  });

  describe('UpdatePosDeviceDto', () => {
    it('accepts a name-only patch', async () => {
      expect(
        await validateLike(UpdatePosDeviceDto, { name: 'Renamed' }),
      ).toHaveLength(0);
    });

    it('accepts an empty patch', async () => {
      expect(await validateLike(UpdatePosDeviceDto, {})).toHaveLength(0);
    });

    it('rejects storeId (A5: permanent binding)', async () => {
      expect(
        (await validateLike(UpdatePosDeviceDto, { storeId: 'other' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects status (lifecycle endpoints only)', async () => {
      expect(
        (await validateLike(UpdatePosDeviceDto, { status: 'RETIRED' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects unknown fields', async () => {
      expect(
        (await validateLike(UpdatePosDeviceDto, { bogus: 1 })).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('PosDeviceListQueryDto', () => {
    it('accepts empty and valid status filter', async () => {
      expect(await validateLike(PosDeviceListQueryDto, {})).toHaveLength(0);
      expect(
        await validateLike(PosDeviceListQueryDto, { status: 'ACTIVE' }),
      ).toHaveLength(0);
    });

    it('rejects invalid status and unknown fields', async () => {
      expect(
        (await validateLike(PosDeviceListQueryDto, { status: 'BAD' })).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(PosDeviceListQueryDto, { bogus: 1 })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects tenantId injection', async () => {
      expect(
        (await validateLike(PosDeviceListQueryDto, { tenantId: 't' })).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('OpenPosSessionDto', () => {
    it('accepts valid deviceId', async () => {
      expect(
        await validateLike(OpenPosSessionDto, { deviceId: 'd' }),
      ).toHaveLength(0);
    });

    it('rejects missing or empty deviceId', async () => {
      expect(
        (await validateLike(OpenPosSessionDto, {})).length,
      ).toBeGreaterThan(0);
      expect(
        (await validateLike(OpenPosSessionDto, { deviceId: '' })).length,
      ).toBeGreaterThan(0);
    });

    it('rejects storeId, tenantId, userId, status, timestamps, unknown fields', async () => {
      const injections = [
        { deviceId: 'd', storeId: 's' },
        { deviceId: 'd', tenantId: 't' },
        { deviceId: 'd', userId: 'u' },
        { deviceId: 'd', status: 'OPEN' },
        { deviceId: 'd', openedAt: new Date().toISOString() },
        { deviceId: 'd', bogus: true },
      ];
      for (const payload of injections) {
        expect(
          (await validateLike(OpenPosSessionDto, payload)).length,
        ).toBeGreaterThan(0);
      }
    });
  });

  describe('CreatePosSaleDto', () => {
    it('accepts sessionId + items (+ optional method/customerId)', async () => {
      expect(
        await validateLike(CreatePosSaleDto, {
          sessionId: 's',
          items: [{ variantId: 'v', quantity: 1 }],
        }),
      ).toHaveLength(0);
      expect(
        await validateLike(CreatePosSaleDto, {
          sessionId: 's',
          items: [{ variantId: 'v', quantity: 2 }],
          method: 'CASH',
          customerId: 'c',
        }),
      ).toHaveLength(0);
    });

    it('rejects missing/empty items and bad quantities', async () => {
      const cases: Array<Record<string, unknown>> = [
        { sessionId: 's' },
        { sessionId: 's', items: [] },
        { sessionId: '', items: [{ variantId: 'v', quantity: 1 }] },
        { sessionId: 's', items: [{ quantity: 1 }] },
        { sessionId: 's', items: [{ variantId: 'v' }] },
        { sessionId: 's', items: [{ variantId: 'v', quantity: 0 }] },
        { sessionId: 's', items: [{ variantId: 'v', quantity: 1.5 }] },
        { sessionId: 's', items: [{ variantId: 'v', quantity: '1' }] },
        { sessionId: 's', items: [{ variantId: 'v', quantity: 1000001 }] },
      ];
      for (const payload of cases) {
        expect(
          (await validateLike(CreatePosSaleDto, payload)).length,
        ).toBeGreaterThan(0);
      }
    });

    it('rejects invalid method', async () => {
      expect(
        (
          await validateLike(CreatePosSaleDto, {
            sessionId: 's',
            items: [{ variantId: 'v', quantity: 1 }],
            method: 'WIRE',
          })
        ).length,
      ).toBeGreaterThan(0);
    });

    it('rejects authority-field injections with 400', async () => {
      const injections = [
        {
          sessionId: 's',
          items: [{ variantId: 'v', quantity: 1 }],
          tenantId: 't',
        },
        {
          sessionId: 's',
          items: [{ variantId: 'v', quantity: 1 }],
          storeId: 'st',
        },
        {
          sessionId: 's',
          items: [{ variantId: 'v', quantity: 1 }],
          deviceId: 'd',
        },
        {
          sessionId: 's',
          items: [{ variantId: 'v', quantity: 1 }],
          cashierId: 'u',
        },
        {
          sessionId: 's',
          items: [{ variantId: 'v', quantity: 1 }],
          orderId: 'o',
        },
        {
          sessionId: 's',
          items: [{ variantId: 'v', quantity: 1 }],
          paymentId: 'p',
        },
        {
          sessionId: 's',
          items: [{ variantId: 'v', quantity: 1 }],
          status: 'PAID',
        },
        { sessionId: 's', items: [{ variantId: 'v', quantity: 1 }], bogus: 1 },
      ];
      for (const payload of injections) {
        expect(
          (await validateLike(CreatePosSaleDto, payload)).length,
        ).toBeGreaterThan(0);
      }
    });
  });

  describe('RecordOfflineSaleIntentDto', () => {
    const validItem = {
      variantId: 'variant-1',
      quantity: 2,
      currency: 'USD',
      observedUnitAmountMinor: 1250,
    };

    it('accepts a valid intent payload', async () => {
      expect(
        await validateLike(RecordOfflineSaleIntentDto, {
          sessionId: 'session-1',
          clientUuid: '11111111-1111-4111-8111-111111111111',
          seq: 1,
          items: [validItem],
        }),
      ).toHaveLength(0);
    });

    it('rejects a non-UUID clientUuid', async () => {
      expect(
        (
          await validateLike(RecordOfflineSaleIntentDto, {
            sessionId: 'session-1',
            clientUuid: 'not-a-uuid',
            seq: 1,
            items: [validItem],
          })
        ).length,
      ).toBeGreaterThan(0);
    });

    it('rejects seq <= 0 and non-integer seq', async () => {
      for (const seq of [0, -1, 1.5, '1']) {
        expect(
          (
            await validateLike(RecordOfflineSaleIntentDto, {
              sessionId: 'session-1',
              clientUuid: '11111111-1111-4111-8111-111111111111',
              seq,
              items: [validItem],
            })
          ).length,
        ).toBeGreaterThan(0);
      }
    });

    it('rejects missing/empty items and bad item fields', async () => {
      const base = {
        sessionId: 'session-1',
        clientUuid: '11111111-1111-4111-8111-111111111111',
        seq: 1,
      };
      const cases: Array<Record<string, unknown>> = [
        { ...base }, // no items
        { ...base, items: [] },
        { ...base, items: [{ ...validItem, quantity: 0 }] },
        { ...base, items: [{ ...validItem, quantity: 1.5 }] },
        { ...base, items: [{ ...validItem, quantity: '2' }] },
        { ...base, items: [{ ...validItem, currency: 'usd' }] },
        { ...base, items: [{ ...validItem, currency: 'USDD' }] },
        { ...base, items: [{ ...validItem, observedUnitAmountMinor: -1 }] },
        { ...base, items: [{ ...validItem, observedUnitAmountMinor: 1.5 }] },
        { ...base, items: [{ ...validItem, variantId: '' }] },
      ];
      for (const payload of cases) {
        expect(
          (await validateLike(RecordOfflineSaleIntentDto, payload)).length,
        ).toBeGreaterThan(0);
      }
    });

    it('rejects authority-field injections with 400', async () => {
      const base = {
        sessionId: 'session-1',
        clientUuid: '11111111-1111-4111-8111-111111111111',
        seq: 1,
        items: [validItem],
      };
      const injections = [
        { ...base, tenantId: 't' },
        { ...base, deviceId: 'd' },
        { ...base, storeId: 's' },
        { ...base, cashierId: 'u' },
        { ...base, userId: 'u' },
        { ...base, status: 'ACCEPTED' },
        { ...base, resultCode: 'PRICE_CHANGED' },
        { ...base, resultOrderId: 'o' },
        { ...base, resultPaymentId: 'p' },
        { ...base, id: 'op-1' },
        { ...base, createdAt: new Date().toISOString() },
        { ...base, bogus: true },
      ];
      for (const payload of injections) {
        expect(
          (await validateLike(RecordOfflineSaleIntentDto, payload)).length,
        ).toBeGreaterThan(0);
      }
    });
  });
});
