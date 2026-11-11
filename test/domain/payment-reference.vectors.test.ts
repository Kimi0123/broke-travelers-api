import { describe, expect, it } from 'vitest';
import type { PaymentMethod, PaymentStatus } from '../../src/domain/enums.js';
import { normalizePaymentReference } from '../../src/domain/payment-reference.js';
import {
  hasActiveDuplicateReference,
  validatePaymentReference,
} from '../../src/domain/payment-validators.js';
import { loadVectorFile } from '../support/vector-loader.js';

interface NormalizeInput {
  reference: string;
}

interface ValidateInput {
  method: string;
  reference: string | null;
}

interface UniquenessInput {
  existingGroupId: string;
  existingMethod: string;
  existingStatus: string;
  reference: string;
  submissionGroupId: string;
  submissionMethod: string;
}

type PaymentReferenceInput = NormalizeInput | ValidateInput | UniquenessInput;

interface PaymentReferenceExpected {
  normalized?: string;
  error?: string | null;
  valid?: boolean;
  pass?: boolean;
}

describe('Payment Reference Vectors', () => {
  const vector = loadVectorFile<
    PaymentReferenceInput,
    PaymentReferenceExpected
  >('payment_reference');

  it('has 22 test cases', () => {
    expect(vector.cases).toHaveLength(22);
  });

  for (const c of vector.cases) {
    it(c.name, () => {
      if (c.name.startsWith('normalize_reference_')) {
        const input = c.input as NormalizeInput;
        const normalized = normalizePaymentReference(input.reference);
        expect(normalized).toBe(c.expected.normalized);
      } else if (c.name.startsWith('validate_')) {
        const input = c.input as ValidateInput;
        const err = validatePaymentReference(
          input.method as PaymentMethod,
          input.reference,
        );
        expect(err).toBe(c.expected.error);
        expect(err === null).toBe(c.expected.valid);
      } else if (c.name.startsWith('uniqueness_')) {
        const input = c.input as UniquenessInput;
        const isDuplicate = hasActiveDuplicateReference({
          existingSubmissions: [
            {
              groupId: input.existingGroupId,
              method: input.existingMethod as PaymentMethod,
              reference: input.reference,
              status: input.existingStatus as PaymentStatus,
            },
          ],
          groupId: input.submissionGroupId,
          method: input.submissionMethod as PaymentMethod,
          reference: input.reference,
        });

        const errorCode = isDuplicate ? 'duplicateReference' : null;
        const pass = !isDuplicate;

        expect(errorCode).toBe(c.expected.error);
        expect(pass).toBe(c.expected.pass);
      } else {
        throw new Error(`Unhandled case category: ${c.name}`);
      }
    });
  }
});
