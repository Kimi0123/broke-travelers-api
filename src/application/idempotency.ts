import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { generateId } from '../infrastructure/db/ids.js';
import { IdempotencyConflictError } from './errors.js';

/**
 * Serializes an arbitrary JavaScript object or primitive into deterministic canonical JSON
 * where object keys are lexicographically sorted at all depths.
 */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  const record = obj as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const entries: string[] = [];
  for (const k of sortedKeys) {
    const val = record[k];
    if (val !== undefined) {
      entries.push(`${JSON.stringify(k)}:${canonicalJsonStringify(val)}`);
    }
  }
  return `{${entries.join(',')}}`;
}

/**
 * Computes a SHA-256 hexadecimal hash over the canonical JSON representation of the payload.
 */
export function computeRequestHash(payload: unknown): string {
  const canonical = canonicalJsonStringify(payload);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface CachedIdempotencyResponse<T> {
  readonly cached: true;
  readonly status: number;
  readonly data: T;
}

export interface IdempotencyCheckResult<T> {
  readonly existing: CachedIdempotencyResponse<T> | null;
  readonly requestHash: string;
}

/**
 * Checks if an idempotency key has already been recorded within the current transaction.
 *
 * If matching key is found:
 *  - with matching requestHash -> returns cached response
 *  - with differing requestHash -> throws IdempotencyConflictError
 * If not found -> returns { existing: null, requestHash }
 */
export async function checkIdempotency<T>(
  tx: Prisma.TransactionClient,
  params: {
    readonly idempotencyKey: string;
    readonly operation: string;
    readonly groupId?: string | null | undefined;
    readonly actorUserId?: string | undefined;
    readonly payload: unknown;
  },
): Promise<IdempotencyCheckResult<T>> {
  const requestHash = computeRequestHash(params.payload);
  const record = await tx.idempotencyKey.findFirst({
    where: {
      idempotencyKey: params.idempotencyKey,
      operation: params.operation,
      ...(params.groupId !== undefined ? { groupId: params.groupId } : {}),
      ...(params.actorUserId ? { actorUserId: params.actorUserId } : {}),
    },
  });

  if (!record) {
    return { existing: null, requestHash };
  }

  if (record.requestHash !== requestHash) {
    throw new IdempotencyConflictError(
      `Idempotency key '${params.idempotencyKey}' was already used with a different request payload`,
    );
  }

  const parsedData = record.responseBody as T;
  return {
    existing: {
      cached: true,
      status: record.responseStatus,
      data: parsedData,
    },
    requestHash,
  };
}

/**
 * Records an idempotency entry inside the current transaction with a 48-hour default expiration.
 */
export async function saveIdempotency(
  tx: Prisma.TransactionClient,
  params: {
    readonly idempotencyKey: string;
    readonly operation: string;
    readonly groupId?: string | null | undefined;
    readonly actorUserId: string;
    readonly requestHash: string;
    readonly responseStatus: number;
    readonly responseBody: unknown;
    readonly ttlHours?: number | undefined;
  },
): Promise<void> {
  const ttlMs = (params.ttlHours ?? 48) * 3600 * 1000;
  await tx.idempotencyKey.create({
    data: {
      id: generateId(),
      idempotencyKey: params.idempotencyKey,
      operation: params.operation,
      groupId: params.groupId ?? null,
      actorUserId: params.actorUserId,
      requestHash: params.requestHash,
      responseStatus: params.responseStatus,
      responseBody: params.responseBody as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
}
