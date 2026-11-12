import { HttpError } from '../errors.js';

export interface KeysetCursor {
  readonly occurredAt: string; // ISO 8601 string
  readonly id: string;
}

/**
 * Encodes keyset tuple (occurredAt, id) into an opaque base64url string.
 */
export function encodeCursor(cursor: KeysetCursor): string {
  const payload = [cursor.occurredAt, cursor.id];
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes an opaque base64url keyset cursor.
 * Throws HttpError(400, 'invalid_cursor') on any malformed or corrupted input.
 */
export function decodeCursor(cursorStr: string): KeysetCursor {
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      throw new Error('Cursor must be a 2-element array');
    }
    const [occurredAtStr, id] = parsed as [unknown, unknown];
    if (typeof occurredAtStr !== 'string' || typeof id !== 'string' || !id) {
      throw new Error('Invalid cursor tuple elements');
    }
    const date = new Date(occurredAtStr);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid timestamp in cursor');
    }
    return {
      occurredAt: date.toISOString(),
      id,
    };
  } catch {
    throw new HttpError(400, 'invalid_cursor');
  }
}

/**
 * Parses and validates query params `limit` and `cursor`.
 * Limit defaults to 20, max 50.
 */
export function parsePaginationParams(query: Record<string, unknown>): {
  readonly limit: number;
  readonly cursor: KeysetCursor | null;
} {
  let limit = 20;
  if (query['limit'] !== undefined) {
    const parsedLimit = Number(query['limit']);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new HttpError(400, 'invalid_request');
    }
    limit = Math.min(parsedLimit, 50);
  }

  let cursor: KeysetCursor | null = null;
  if (
    typeof query['cursor'] === 'string' &&
    query['cursor'].trim().length > 0
  ) {
    cursor = decodeCursor(query['cursor'].trim());
  }

  return { limit, cursor };
}
