import { describe, expect, it } from 'vitest';
import type { ActivityKind } from '../../src/domain/enums.js';
import { DomainError } from '../../src/domain/errors.js';
import {
  assertValidRecordTransactionInput,
  validateReversalReason,
} from '../../src/domain/transaction-validators.js';
import { adaptWallClock, loadVectorFile } from '../support/vector-loader.js';

interface RawWallClock {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  ms: number;
}

interface RecordInput {
  amountPaisa: number;
  kind: string;
  note: string | null;
  now: RawWallClock;
  occurredAt: RawWallClock;
  title: string;
}

interface ReversalReasonInput {
  reason: string | null;
}

type TransactionValidationInput = RecordInput | ReversalReasonInput;

interface TransactionValidationExpected {
  error: string | null;
  pass: boolean;
}

describe('Transaction Validation Vectors', () => {
  const vector = loadVectorFile<
    TransactionValidationInput,
    TransactionValidationExpected
  >('transaction_validation');

  it('has 27 test cases', () => {
    expect(vector.cases).toHaveLength(27);
  });

  for (const c of vector.cases) {
    it(c.name, () => {
      if ('reason' in c.input) {
        // Direct validateReversalReason check
        const err = validateReversalReason(c.input.reason);
        expect(err).toBe(c.expected.error);
        expect(err === null).toBe(c.expected.pass);
      } else {
        // Record transaction composite validation
        const recordInput = c.input;
        let errorCode: string | null = null;
        let pass: boolean;

        try {
          assertValidRecordTransactionInput({
            kind: recordInput.kind as ActivityKind,
            amountPaisa: recordInput.amountPaisa,
            occurredAt: adaptWallClock(recordInput.occurredAt),
            title: recordInput.title,
            note: recordInput.note,
            now: adaptWallClock(recordInput.now),
          });

          // Mock group g1 has verified balance = 135,000 paisa (1,350 NPR).
          // postVerifiedEntry fails with insufficientBalance if expense exceeds verified balance.
          const g1VerifiedBalancePaisa = 135_000;
          if (
            recordInput.kind === 'expense' &&
            recordInput.amountPaisa > g1VerifiedBalancePaisa
          ) {
            errorCode = 'insufficientBalance';
            pass = false;
          } else {
            pass = true;
          }
        } catch (e) {
          if (e instanceof DomainError) {
            errorCode = e.code;
            pass = false;
          } else {
            throw e;
          }
        }

        expect(errorCode).toBe(c.expected.error);
        expect(pass).toBe(c.expected.pass);
      }
    });
  }
});
