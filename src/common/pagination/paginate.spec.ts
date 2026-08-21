import {
  buildKeysetWhere,
  buildOrderBy,
  encodeRowCursor,
  fetchPage,
} from './paginate';

describe('keyset pagination helpers', () => {
  describe('buildOrderBy', () => {
    it('appends the id tiebreaker in the same direction', () => {
      expect(buildOrderBy('createdAt', 'asc')).toEqual([
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
      expect(buildOrderBy('startAt', 'desc')).toEqual([
        { startAt: 'desc' },
        { id: 'desc' },
      ]);
    });
  });

  describe('buildKeysetWhere', () => {
    it('expands ascending continuation to (p > c1) OR (p = c1 AND id > c2)', () => {
      expect(buildKeysetWhere('createdAt', 1000, 'row-2', 'asc')).toEqual({
        OR: [
          { createdAt: { gt: 1000 } },
          { createdAt: { equals: 1000 }, id: { gt: 'row-2' } },
        ],
      });
    });

    it('expands descending continuation to (p < c1) OR (p = c1 AND id < c2)', () => {
      expect(buildKeysetWhere('createdAt', 1000, 'row-2', 'desc')).toEqual({
        OR: [
          { createdAt: { lt: 1000 } },
          { createdAt: { equals: 1000 }, id: { lt: 'row-2' } },
        ],
      });
    });
  });

  describe('fetchPage', () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `r${i}`, createdAt: i }));

    it('returns all rows and null cursor on the last page', async () => {
      const page = await fetchPage(
        async () => await Promise.resolve(rows(2)),
        5,
        encodeRowCursor,
        'createdAt',
        'asc',
        'fp',
      );
      expect(page.data).toHaveLength(2);
      expect(page.meta.nextCursor).toBeNull();
    });

    it('trims the limit+1 probe row and encodes nextCursor from the last retained row', async () => {
      const page = await fetchPage(
        async () => await Promise.resolve(rows(4)),
        3,
        encodeRowCursor,
        'createdAt',
        'asc',
        'fp01',
      );
      expect(page.data).toHaveLength(3);
      expect(page.data.map((r) => r.id)).toEqual(['r0', 'r1', 'r2']);
      // Cursor must reference r2 (last retained), not the probe row r3.
      expect(page.meta.nextCursor).toBe(
        encodeRowCursor({ id: 'r2', createdAt: 2 }, 'createdAt', 'asc', 'fp01'),
      );
    });

    it('propagates executor failures untouched', async () => {
      await expect(
        fetchPage(
          async () => {
            await Promise.reject(new Error('db down'));
            return [];
          },
          3,
          encodeRowCursor,
          'createdAt',
          'asc',
          'fp',
        ),
      ).rejects.toThrow('db down');
    });
  });

  describe('encodeRowCursor', () => {
    it('extracts epoch millis from Date fields and stringifies ids', () => {
      const at = new Date('2026-03-04T05:06:07.000Z');
      const cursor = encodeRowCursor(
        { id: 42 as unknown as string, startAt: at },
        'startAt',
        'desc',
        'ab12cd34',
      );
      expect(cursor).toBeDefined();
      const payload = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      ) as { k: [number, string]; s: string; d: string; f: string };
      expect(payload.k[0]).toBe(at.getTime());
      expect(payload.k[1]).toBe('42');
      expect(payload.s).toBe('startAt');
      expect(payload.d).toBe('desc');
      expect(payload.f).toBe('ab12cd34');
    });
  });
});
