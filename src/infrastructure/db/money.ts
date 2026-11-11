import { DomainError } from '../../domain/errors.js';
import { assertPaisa, type Paisa } from '../../domain/money.js';

/**
 * Converts a database BIGINT representation to the domain Paisa branded safe integer.
 * Throws a DomainError('invalidInput') if the BIGINT cannot be safely represented
 * as a JavaScript safe integer.
 */
export function bigintToPaisa(val: bigint): Paisa {
  const num = Number(val);
  if (!Number.isSafeInteger(num)) {
    throw new DomainError(
      'invalidInput',
      `Database monetary value exceeds JavaScript safe integer limits: ${val.toString()}`,
    );
  }
  return assertPaisa(num);
}

/**
 * Converts a domain Paisa branded safe integer to a database BIGINT.
 */
export function paisaToBigint(p: Paisa): bigint {
  assertPaisa(p);
  return BigInt(p);
}
