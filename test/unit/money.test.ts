import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import { paisa } from '../../src/domain/money.js';
import {
  bigintToPaisa,
  paisaToBigint,
} from '../../src/infrastructure/db/money.js';

describe('db money helpers', () => {
  describe('bigintToPaisa', () => {
    it('converts safe bigint values to Paisa branded numbers', () => {
      expect(bigintToPaisa(0n)).toBe(0);
      expect(bigintToPaisa(50000n)).toBe(50000);
      expect(bigintToPaisa(-125000n)).toBe(-125000);
      expect(bigintToPaisa(1_000_000_000n)).toBe(1_000_000_000);
    });

    it('converts boundary safe integer values', () => {
      const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
      expect(bigintToPaisa(maxSafe)).toBe(Number.MAX_SAFE_INTEGER);

      const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
      expect(bigintToPaisa(minSafe)).toBe(Number.MIN_SAFE_INTEGER);
    });

    it('throws DomainError when value exceeds safe integer bounds', () => {
      const unsafePositive = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
      expect(() => bigintToPaisa(unsafePositive)).toThrow(DomainError);

      const unsafeNegative = BigInt(Number.MIN_SAFE_INTEGER) - 1n;
      expect(() => bigintToPaisa(unsafeNegative)).toThrow(DomainError);

      const huge = 10n ** 20n;
      expect(() => bigintToPaisa(huge)).toThrow(DomainError);
    });
  });

  describe('paisaToBigint', () => {
    it('converts Paisa numbers to BigInt', () => {
      expect(paisaToBigint(paisa(0))).toBe(0n);
      expect(paisaToBigint(paisa(75000))).toBe(75000n);
      expect(paisaToBigint(paisa(-5000))).toBe(-5000n);
      expect(paisaToBigint(paisa(10_000_000))).toBe(10_000_000n);
    });
  });
});
