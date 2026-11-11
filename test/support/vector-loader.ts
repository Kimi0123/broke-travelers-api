import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ActivityKind,
  PaymentMethod,
  PaymentStatus,
} from '../../src/domain/enums.js';
import { paisa } from '../../src/domain/money.js';
import type {
  LedgerLine,
  ReportMember,
} from '../../src/domain/report-types.js';
import type { LedgerEntry } from '../../src/domain/types.js';
import {
  createWallClock,
  type WallClock,
} from '../../src/domain/wall-clock.js';

export interface RawVectorCase<TInput = unknown, TExpected = unknown> {
  readonly name: string;
  readonly input: TInput;
  readonly expected: TExpected;
}

export interface RawVectorFile<TInput = unknown, TExpected = unknown> {
  readonly schemaVersion: number;
  readonly domain: string;
  readonly source: string;
  readonly cases: readonly RawVectorCase<TInput, TExpected>[];
}

function assertNoFloats(node: unknown, currentPath: string): void {
  if (typeof node === 'number') {
    if (!Number.isInteger(node)) {
      throw new Error(
        `Forbidden floating point number found at ${currentPath}: ${node} (vectors must use integer paisa only)`,
      );
    }
  } else if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      assertNoFloats(node[i], `${currentPath}[${i}]`);
    }
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      assertNoFloats(value, `${currentPath}.${key}`);
    }
  }
}

/**
 * Loads and structurally verifies a golden test vector file from test/vectors/<domain>.json.
 */
export function loadVectorFile<TInput = unknown, TExpected = unknown>(
  domain: string,
): RawVectorFile<TInput, TExpected> {
  const filePath = path.resolve(
    process.cwd(),
    'test',
    'vectors',
    `${domain}.json`,
  );

  if (!fs.existsSync(filePath)) {
    throw new Error(`Vector file not found at ${filePath}`);
  }

  const rawJson = fs.readFileSync(filePath, 'utf-8');

  // Verify file ends with trailing newline
  if (!rawJson.endsWith('\n')) {
    throw new Error(
      `Vector file ${domain}.json must end with a trailing newline`,
    );
  }

  const parsed = JSON.parse(rawJson) as RawVectorFile<TInput, TExpected>;

  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `Vector file ${domain}.json has unexpected schemaVersion: ${parsed.schemaVersion} (expected 1)`,
    );
  }

  if (parsed.domain !== domain) {
    throw new Error(
      `Vector file ${domain}.json has mismatched domain: ${parsed.domain} (expected ${domain})`,
    );
  }

  assertNoFloats(parsed, domain);

  // Assert case names are unique
  const seenNames = new Set<string>();
  for (const c of parsed.cases) {
    if (seenNames.has(c.name)) {
      throw new Error(
        `Duplicate case name '${c.name}' in vector file ${domain}.json`,
      );
    }
    seenNames.add(c.name);
  }

  return parsed;
}

/**
 * Adapts raw JSON wall-clock object to typed WallClock.
 */
export function adaptWallClock(raw: {
  y: number;
  m: number;
  d: number;
  h?: number;
  mi?: number;
  s?: number;
  ms?: number;
}): WallClock {
  return createWallClock(
    raw.y,
    raw.m,
    raw.d,
    raw.h ?? 0,
    raw.mi ?? 0,
    raw.s ?? 0,
    raw.ms ?? 0,
  );
}

export function adaptWallClockOrNull(
  raw?: {
    y: number;
    m: number;
    d: number;
    h?: number;
    mi?: number;
    s?: number;
    ms?: number;
  } | null,
): WallClock | null {
  return raw ? adaptWallClock(raw) : null;
}

/**
 * Adapts raw JSON ledger entry to domain LedgerEntry.
 */
export function adaptLedgerEntry(raw: {
  id: string;
  kind: string;
  magnitudePaisa: number;
  occurredAt: {
    y: number;
    m: number;
    d: number;
    h?: number;
    mi?: number;
    s?: number;
    ms?: number;
  };
  status: string;
  title: string;
  memberId?: string | null;
  paymentMethod?: string | null;
  note?: string | null;
  periodMonth?: {
    y: number;
    m: number;
    d: number;
    h?: number;
    mi?: number;
    s?: number;
    ms?: number;
  } | null;
  reversesEntryId?: string | null;
}): LedgerEntry {
  return {
    id: raw.id,
    kind: raw.kind as ActivityKind,
    magnitudePaisa: paisa(raw.magnitudePaisa),
    occurredAt: adaptWallClock(raw.occurredAt),
    status: raw.status as PaymentStatus,
    title: raw.title,
    memberId: raw.memberId ?? null,
    paymentMethod: (raw.paymentMethod as PaymentMethod | undefined) ?? null,
    note: raw.note ?? null,
    periodMonth: adaptWallClockOrNull(raw.periodMonth),
    reversesEntryId: raw.reversesEntryId ?? null,
  };
}

/**
 * Adapts raw JSON ledger line to domain LedgerLine.
 */
export function adaptLedgerLine(raw: {
  id: string;
  kind: string;
  status: string;
  amount: number;
  signed: number;
  occurredAt: {
    y: number;
    m: number;
    d: number;
    h?: number;
    mi?: number;
    s?: number;
    ms?: number;
  };
  periodMonth?: {
    y: number;
    m: number;
    d: number;
    h?: number;
    mi?: number;
    s?: number;
    ms?: number;
  } | null;
  memberId?: string | null;
  title: string;
  reversesId?: string | null;
}): LedgerLine {
  return {
    id: raw.id,
    kind: raw.kind as ActivityKind,
    status: raw.status as PaymentStatus,
    amount: paisa(raw.amount),
    signed: paisa(raw.signed),
    occurredAt: adaptWallClock(raw.occurredAt),
    periodMonth: adaptWallClockOrNull(raw.periodMonth),
    memberId: raw.memberId ?? null,
    title: raw.title,
    reversesId: raw.reversesId ?? null,
  };
}

/**
 * Adapts raw JSON report member to domain ReportMember.
 */
export function adaptReportMember(raw: {
  id: string;
  name: string;
  joinedAt: {
    y: number;
    m: number;
    d: number;
    h?: number;
    mi?: number;
    s?: number;
    ms?: number;
  };
  leftAt?: {
    y: number;
    m: number;
    d: number;
    h?: number;
    mi?: number;
    s?: number;
    ms?: number;
  } | null;
}): ReportMember {
  return {
    id: raw.id,
    name: raw.name,
    joinedAt: adaptWallClock(raw.joinedAt),
    leftAt: adaptWallClockOrNull(raw.leftAt),
  };
}
