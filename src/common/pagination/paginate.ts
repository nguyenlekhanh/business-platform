import { BadRequestException } from '@nestjs/common';
import type { CursorKeyValue, SortDirection } from './cursor';
import {
  decodeCursor,
  encodeCursor,
  filterFingerprint,
  INVALID_CURSOR,
  keyValueFromRow,
} from './cursor';

/**
 * Pure keyset-pagination building blocks shared by all tenant-scoped list
 * services. Deliberately framework-agnostic and free of Prisma generics:
 * services compose these explicit functions so the query shapes stay visible
 * and type-safe at each call site.
 *
 * Ordering contract (approved): deterministic total order of
 * (primarySortColumn, id) with `id` following the SAME direction as the
 * primary sort. The tiebreaker is appended server-side and is never
 * client-controllable.
 */

/** Envelope returned by every paginated tenant-scoped list endpoint.
 *  Intentionally NO totalCount: a per-page COUNT(*) would negate the keyset
 *  cost model. `nextCursor === null` marks the last page. */
export interface Paginated<T> {
  data: T[];
  meta: { nextCursor: string | null };
}

/** Builds the Prisma orderBy clause for the deterministic two-key order. */
export function buildOrderBy(
  primaryField: string,
  direction: SortDirection,
): Array<Record<string, SortDirection>> {
  return [{ [primaryField]: direction }, { id: direction }];
}

/**
 * Builds the keyset continuation predicate for rows strictly AFTER
 * (primaryValue, idValue) in the given direction:
 *   asc  -> (p > c1) OR (p = c1 AND id > c2)
 *   desc -> (p < c1) OR (p = c1 AND id < c2)
 * Row-value comparison `(p, id) > (c1, c2)` is not expressible in Prisma, so
 * the OR-expansion is used; PostgreSQL satisfies it efficiently with the
 * matching composite index. Compose this with the request's filters via AND.
 */
export function buildKeysetWhere(
  primaryField: string,
  primaryValue: Date | CursorKeyValue,
  idValue: string,
  direction: SortDirection,
): Record<string, unknown> {
  const op = direction === 'asc' ? 'gt' : 'lt';
  return {
    OR: [
      { [primaryField]: { [op]: primaryValue } },
      { [primaryField]: { equals: primaryValue }, id: { [op]: idValue } },
    ],
  };
}

/**
 * Runs one keyset page against a caller-supplied executor and builds the
 * response envelope. The executor MUST apply take = limit + 1 internally;
 * this function detects the extra row, trims it, and encodes nextCursor from
 * the LAST RETAINED row (never from the probe row).
 */
export async function fetchPage<T extends Record<string, unknown>>(
  findRows: () => Promise<T[]>,
  limit: number,
  cursorFor: (
    lastRow: T,
    sortBy: string,
    direction: SortDirection,
    fingerprint: string,
  ) => string,
  sortBy: string,
  direction: SortDirection,
  fingerprint: string,
): Promise<Paginated<T>> {
  const found = await findRows();
  const hasNext = found.length > limit;
  const rows = hasNext ? found.slice(0, limit) : found;
  const nextCursor = hasNext
    ? cursorFor(rows[rows.length - 1], sortBy, direction, fingerprint)
    : null;
  return { data: rows, meta: { nextCursor } };
}

/**
 * Converts a decoded cursor primary value for a DateTime sort column back
 * into a Date instant. Cursor keys are stored as epoch millis; semantically
 * invalid values (unparseable strings, NaN) are rejected with 400 so a
 * crafted cursor can never produce a 500.
 */
export function dateKeyFromCursor(value: CursorKeyValue): Date {
  const date =
    typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(INVALID_CURSOR);
  }
  return date;
}

/**
 * Shared continuation resolution for the simple equality-filtered list
 * endpoints: computes the filter fingerprint, decodes/validates an optional
 * cursor against it, and builds the keyset predicate. The result composes
 * with the caller's filters via AND. `dateSortColumn` (default true) converts
 * the cursor key for DateTime sort columns.
 */
export interface ListContinuation {
  fingerprint: string;
  keyset?: Record<string, unknown>;
}

export function resolveListContinuation(params: {
  cursor?: string;
  sortBy: string;
  direction: SortDirection;
  equality: Record<string, unknown>;
  dateSortColumn?: boolean;
}): ListContinuation {
  const fingerprint = filterFingerprint(params.equality);
  if (params.cursor === undefined) {
    return { fingerprint };
  }
  const decoded = decodeCursor(params.cursor, {
    sortBy: params.sortBy,
    direction: params.direction,
    fingerprint,
  });
  const primary =
    params.dateSortColumn === false
      ? decoded.primaryValue
      : dateKeyFromCursor(decoded.primaryValue);
  return {
    fingerprint,
    keyset: buildKeysetWhere(
      params.sortBy,
      primary,
      decoded.idValue,
      params.direction,
    ),
  };
}

/**
 * Convenience cursor encoder bound to a row shape: extracts the continuation
 * tuple (primary sort value + id) from the row and serializes the cursor.
 */
export function encodeRowCursor<T extends Record<string, unknown>>(
  lastRow: T,
  sortBy: string,
  direction: SortDirection,
  fingerprint: string,
): string {
  return encodeCursor(
    sortBy,
    direction,
    keyValueFromRow(lastRow, sortBy),
    String(lastRow['id']),
    fingerprint,
  );
}
