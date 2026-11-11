import { describe, expect, it } from 'vitest';
import { deriveObligationStatus } from '../../src/domain/obligation-status.js';
import {
  adaptLedgerEntry,
  adaptWallClock,
  loadVectorFile,
} from '../support/vector-loader.js';

interface ObligationInput {
  clock: Parameters<typeof adaptWallClock>[0];
  entries: Parameters<typeof adaptLedgerEntry>[0][];
  member: { id: string };
  period: Parameters<typeof adaptWallClock>[0];
}

interface ObligationExpected {
  status: string;
}

describe('obligation_status golden vectors', () => {
  const file = loadVectorFile<ObligationInput, ObligationExpected>(
    'obligation_status',
  );

  it('contains expected number of cases', () => {
    expect(file.cases.length).toBe(14);
  });

  it.each(file.cases)('executes case: $name', (c) => {
    const entries = c.input.entries.map(adaptLedgerEntry);
    const periodStart = adaptWallClock(c.input.period);
    const anchorPeriodStart = adaptWallClock(c.input.clock);
    const memberId = c.input.member.id;

    const actual = deriveObligationStatus({
      entries,
      memberId,
      periodStart,
      anchorPeriodStart,
    });

    expect(actual).toBe(c.expected.status);
  });
});
