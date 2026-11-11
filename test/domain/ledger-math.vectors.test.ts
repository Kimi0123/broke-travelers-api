import { describe, expect, it } from 'vitest';
import {
  signedPaisa,
  verifiedBalancePaisa,
} from '../../src/domain/ledger-math.js';
import {
  adaptLedgerEntry,
  adaptWallClockOrNull,
  loadVectorFile,
} from '../support/vector-loader.js';

interface SignedPaisaInput {
  entry: Parameters<typeof adaptLedgerEntry>[0];
}

interface VerifiedBalanceInput {
  asOf?: {
    y: number;
    m: number;
    d: number;
    h?: number;
    mi?: number;
    s?: number;
    ms?: number;
  } | null;
  entries: Parameters<typeof adaptLedgerEntry>[0][];
}

type LedgerMathInput = SignedPaisaInput | VerifiedBalanceInput;

interface LedgerMathExpected {
  signedPaisa?: number;
  balancePaisa?: number;
}

describe('ledger_math golden vectors', () => {
  const file = loadVectorFile<LedgerMathInput, LedgerMathExpected>(
    'ledger_math',
  );

  it('contains expected number of cases', () => {
    expect(file.cases.length).toBe(15);
  });

  it.each(file.cases)('executes case: $name', (c) => {
    if ('signedPaisa' in c.expected) {
      const input = c.input as SignedPaisaInput;
      const entry = adaptLedgerEntry(input.entry);
      const actual = signedPaisa(entry);
      expect(actual as number).toBe(c.expected.signedPaisa);
    } else if ('balancePaisa' in c.expected) {
      const input = c.input as VerifiedBalanceInput;
      const entries = input.entries.map(adaptLedgerEntry);
      const asOf = adaptWallClockOrNull(input.asOf);
      const actual = verifiedBalancePaisa(entries, { asOf });
      expect(actual as number).toBe(c.expected.balancePaisa);
    } else {
      throw new Error(`Unrecognized case shape in ledger_math: ${c.name}`);
    }
  });
});
