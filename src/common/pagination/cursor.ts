import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * Opaque, versioned keyset cursor.
 *
 * Wire format: base64url(JSON) of
 *   { v, s, d, k, f } where
 *   v = cursor format version,
 *   s = primary sort field name,
 *   d = sort direction ('asc' | 'desc'),
 *   k = last-page key tuple [primarySortValue, id] (id tiebreaker),
 *   f = 8-hex fingerprint of the normalized filter set.
 *
 * SECURITY CONTRACTS:
 * - The cursor NEVER contains tenantId. Tenant scoping is applied by the
 *   centralized Prisma extension from the server-derived TenantContext, so a
 *   forged cursor can only add column predicates INSIDE the caller's tenant.
 * - The cursor is treated as fully untrusted input: decoding is strict and
 *   every validation failure maps to HTTP 400 (BadRequestException) via the
 *   shared INVALID_CURSOR message - never a 500.
 * - The embedded sort/direction/fingerprint are compared against what the
 *   service computed for THIS request; reusing a cursor across different
 *   filters or sorts is rejected (400) instead of silently returning wrong
 *   pages.
 */
export const CURSOR_VERSION = 1;
export const INVALID_CURSOR = 'Invalid pagination cursor';

export type SortDirection = 'asc' | 'desc';
export type CursorKeyValue = string | number;

interface CursorPayload {
  v: number;
  s: string;
  d: SortDirection;
  k: [CursorKeyValue, string];
  f: string;
}

/** What the service expects the cursor to agree on for this request. */
export interface CursorExpectation {
  sortBy: string;
  direction: SortDirection;
  fingerprint: string;
}

/** Validated contents of a decoded cursor (the continuation point). */
export interface DecodedCursor {
  primaryValue: CursorKeyValue;
  idValue: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Serializes the continuation point into an opaque client-facing token. */
export function encodeCursor(
  sortBy: string,
  direction: SortDirection,
  primaryValue: CursorKeyValue,
  idValue: string,
  fingerprint: string,
): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    s: sortBy,
    d: direction,
    k: [primaryValue, idValue],
    f: fingerprint,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Parses and validates a client-supplied cursor against this request's
 *  expectations. Throws BadRequestException(INVALID_CURSOR) on ANY failure:
 *  malformed base64url, invalid JSON, unknown version, mismatched sort,
 *  direction or filter fingerprint, or a malformed key tuple. */
export function decodeCursor(
  cursor: string,
  expected: CursorExpectation,
): DecodedCursor {
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new BadRequestException(INVALID_CURSOR);
  }
  if (!isRecord(parsed)) {
    throw new BadRequestException(INVALID_CURSOR);
  }
  if (parsed.v !== CURSOR_VERSION) {
    throw new BadRequestException(INVALID_CURSOR);
  }
  if (parsed.s !== expected.sortBy || parsed.d !== expected.direction) {
    throw new BadRequestException(INVALID_CURSOR);
  }
  if (parsed.f !== expected.fingerprint) {
    throw new BadRequestException(INVALID_CURSOR);
  }
  if (!Array.isArray(parsed.k) || parsed.k.length !== 2) {
    throw new BadRequestException(INVALID_CURSOR);
  }
  const [primaryValue, idValue] = parsed.k as unknown[];
  const primaryKeyValid =
    typeof primaryValue === 'string' ||
    (typeof primaryValue === 'number' && Number.isFinite(primaryValue));
  if (!primaryKeyValid || typeof idValue !== 'string' || idValue === '') {
    throw new BadRequestException(INVALID_CURSOR);
  }
  return { primaryValue, idValue };
}

/**
 * Deterministic 8-hex fingerprint of a normalized filter set. Undefined/null
 * values are dropped and keys are sorted, so semantically identical filters
 * always produce the same fingerprint regardless of construction order.
 * Callers must pass values already normalized to their query form (e.g. dates
 * as canonical ISO strings) so equivalent inputs hash identically.
 */
export function filterFingerprint(filters: Record<string, unknown>): string {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(filters).sort()) {
    const value = filters[key];
    if (value !== undefined && value !== null) {
      normalized[key] = value;
    }
  }
  return createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex')
    .slice(0, 8);
}

/**
 * Extracts the cursor key value from a fetched row. Date instants are encoded
 * as epoch milliseconds so they survive JSON round-trips unambiguously.
 */
export function keyValueFromRow(
  row: Record<string, unknown>,
  field: string,
): CursorKeyValue {
  const value = row[field];
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  throw new Error(`Unsupported cursor key field: ${field}`);
}
