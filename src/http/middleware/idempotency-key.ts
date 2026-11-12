import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../errors.js';

/**
 * Validates that the Idempotency-Key header is 8 to 100 characters consisting
 * exclusively of ASCII alphanumeric characters, underscores, and hyphens ([A-Za-z0-9_-]).
 */
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Extracts and validates the Idempotency-Key header from the request.
 * - If missing (undefined) -> throws HttpError(400, 'idempotency_key_required')
 * - If present but does not match format -> throws HttpError(400, 'invalid_idempotency_key')
 */
export function extractIdempotencyKey(req: Request): string {
  const rawKey = req.header('idempotency-key');
  if (rawKey === undefined) {
    throw new HttpError(400, 'idempotency_key_required');
  }
  if (!IDEMPOTENCY_KEY_REGEX.test(rawKey)) {
    throw new HttpError(400, 'invalid_idempotency_key');
  }
  return rawKey;
}

/**
 * Express middleware to enforce valid Idempotency-Key presence on mutating endpoints.
 */
export function requireIdempotencyKey(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  extractIdempotencyKey(req);
  next();
}
