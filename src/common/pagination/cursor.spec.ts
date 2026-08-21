import {
  CURSOR_VERSION,
  decodeCursor,
  encodeCursor,
  filterFingerprint,
  keyValueFromRow,
} from './cursor';

describe('pagination cursor codec', () => {
  const expectation = {
    sortBy: 'createdAt',
    direction: 'asc' as const,
    fingerprint: 'abcd1234',
  };

  describe('roundtrip', () => {
    it('encodes and decodes a string primary key', () => {
      const cursor = encodeCursor(
        expectation.sortBy,
        expectation.direction,
        'row-id-1',
        'id-2',
        expectation.fingerprint,
      );
      expect(cursor).not.toContain('createdAt');
      expect(decodeCursor(cursor, expectation)).toEqual({
        primaryValue: 'row-id-1',
        idValue: 'id-2',
      });
    });

    it('encodes and decodes a numeric (epoch millis) primary key', () => {
      const cursor = encodeCursor(
        'startAt',
        'desc',
        1720000000000,
        'id-9',
        'ff12',
      );
      expect(
        decodeCursor(cursor, {
          sortBy: 'startAt',
          direction: 'desc',
          fingerprint: 'ff12',
        }),
      ).toEqual({ primaryValue: 1720000000000, idValue: 'id-9' });
    });

    it('is opaque: base64url without raw JSON braces', () => {
      const cursor = encodeCursor('createdAt', 'asc', 'a', 'b', 'x');
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('decode rejections -> BadRequestException(INVALID_CURSOR)', () => {
    const expectRejected = (cursor: string) => {
      try {
        decodeCursor(cursor, expectation);
        throw new Error(`expected rejection of: ${cursor}`);
      } catch (error) {
        expect((error as { getStatus?: () => number }).getStatus?.()).toBe(400);
        expect((error as { message?: unknown }).message).toContain(
          'Invalid pagination cursor',
        );
      }
    };

    it('rejects garbage that is not base64url JSON', () => {
      expectRejected('!!!not-a-cursor!!!');
    });

    it('rejects valid base64url that is not JSON', () => {
      expectRejected(Buffer.from('plain text', 'utf8').toString('base64url'));
    });

    it('rejects an empty cursor', () => {
      expectRejected('');
    });

    it('rejects a JSON non-object', () => {
      expectRejected(Buffer.from('[1,2]', 'utf8').toString('base64url'));
    });

    it('rejects an unknown cursor version', () => {
      const future = encodeCursor('createdAt', 'asc', 'a', 'b', 'abcd1234');
      const payload = JSON.parse(
        Buffer.from(future, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      payload.v = CURSOR_VERSION + 1;
      expectRejected(
        Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'),
      );
    });

    it('rejects a mismatched sort field', () => {
      const cursor = encodeCursor('startAt', 'asc', 'a', 'b', 'abcd1234');
      expectRejected(cursor);
    });

    it('rejects a mismatched direction', () => {
      const cursor = encodeCursor('createdAt', 'desc', 'a', 'b', 'abcd1234');
      expectRejected(cursor);
    });

    it('rejects a reused cursor with different filters', () => {
      const cursor = encodeCursor('createdAt', 'asc', 'a', 'b', 'deadbeef');
      expectRejected(cursor);
    });

    it('rejects malformed key tuples (length/type)', () => {
      const badTuple = {
        v: 1,
        s: 'createdAt',
        d: 'asc',
        k: ['only'],
        f: 'abcd1234',
      };
      expectRejected(
        Buffer.from(JSON.stringify(badTuple), 'utf8').toString('base64url'),
      );

      const badTypes = {
        v: 1,
        s: 'createdAt',
        d: 'asc',
        k: [{ nested: true }, 'id'],
        f: 'abcd1234',
      };
      expectRejected(
        Buffer.from(JSON.stringify(badTypes), 'utf8').toString('base64url'),
      );

      const emptyId = {
        v: 1,
        s: 'createdAt',
        d: 'asc',
        k: [1, ''],
        f: 'abcd1234',
      };
      expectRejected(
        Buffer.from(JSON.stringify(emptyId), 'utf8').toString('base64url'),
      );
    });
  });

  describe('filterFingerprint', () => {
    it('is stable across key order', () => {
      const a = filterFingerprint({ status: 'RESERVED', customerId: 'c1' });
      const b = filterFingerprint({ customerId: 'c1', status: 'RESERVED' });
      expect(a).toBe(b);
    });

    it('drops undefined and null values', () => {
      const a = filterFingerprint({
        status: 'RESERVED',
        from: undefined,
        to: null,
      });
      const b = filterFingerprint({ status: 'RESERVED' });
      expect(a).toBe(b);
    });

    it('differs when filters differ', () => {
      const a = filterFingerprint({ status: 'RESERVED' });
      const b = filterFingerprint({ status: 'ACTIVE' });
      expect(a).not.toBe(b);
    });

    it('returns 8 hex characters', () => {
      expect(filterFingerprint({})).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe('keyValueFromRow', () => {
    it('converts Date instants to epoch millis', () => {
      const at = new Date('2026-01-02T03:04:05.000Z');
      expect(keyValueFromRow({ createdAt: at }, 'createdAt')).toBe(
        at.getTime(),
      );
    });

    it('passes strings and numbers through', () => {
      expect(keyValueFromRow({ id: 'abc' }, 'id')).toBe('abc');
      expect(keyValueFromRow({ n: 5 }, 'n')).toBe(5);
    });
  });
});
