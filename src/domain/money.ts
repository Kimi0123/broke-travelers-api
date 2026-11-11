import { DomainError } from './errors.js';

declare const PaisaBrand: unique symbol;

/**
 * Monetary amount denominated in integer paisa (1 NPR = 100 paisa).
 *
 * Implemented as a TypeScript branded safe integer (`number`). Safe integers
 * in JavaScript represent integers precisely up to 2^53 - 1 (approx 9e15 paisa).
 * Since transaction amounts in Broke Travelers are capped at 1,000,000,000 paisa
 * (10 million NPR) and serialized as standard JSON numbers on the wire, safe
 * integers provide complete precision without floating-point inaccuracies.
 */
export type Paisa = number & { readonly [PaisaBrand]: typeof PaisaBrand };

export const ZERO_PAISA = 0 as Paisa;
export const MAX_PAISA = 1_000_000_000 as Paisa;

/**
 * Asserts that a number is a valid safe integer representing monetary paisa.
 * Throws a typed DomainError('invalidInput') if the value is non-integer, NaN,
 * infinite, or outside JavaScript safe integer limits.
 */
export function assertPaisa(value: number): Paisa {
  if (
    typeof value !== 'number' ||
    Number.isNaN(value) ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value)
  ) {
    throw new DomainError(
      'invalidInput',
      `Monetary amount must be a safe integer paisa, got: ${String(value)}`,
    );
  }
  return value as Paisa;
}

/**
 * Convenience alias to construct a validated Paisa value.
 */
export const paisa = (value: number): Paisa => assertPaisa(value);

/**
 * Adds two Paisa amounts, ensuring safe integer results.
 */
export function addPaisa(a: Paisa, b: Paisa): Paisa {
  return assertPaisa(a + b);
}

/**
 * Subtracts b from a, ensuring safe integer results.
 */
export function subtractPaisa(a: Paisa, b: Paisa): Paisa {
  return assertPaisa(a - b);
}

/**
 * Multiplies a Paisa amount by an integer factor (e.g. member count).
 */
export function multiplyPaisa(amount: Paisa, factor: number): Paisa {
  if (
    typeof factor !== 'number' ||
    !Number.isInteger(factor) ||
    !Number.isSafeInteger(factor)
  ) {
    throw new DomainError(
      'invalidInput',
      `Multiplication factor must be an integer, got: ${String(factor)}`,
    );
  }
  return assertPaisa(amount * factor);
}

/**
 * Negates a Paisa amount.
 */
export function negatePaisa(amount: Paisa): Paisa {
  return assertPaisa(-(amount as number));
}

/**
 * Returns the absolute value of a Paisa amount.
 */
export function absPaisa(amount: Paisa): Paisa {
  return amount < 0 ? negatePaisa(amount) : amount;
}
