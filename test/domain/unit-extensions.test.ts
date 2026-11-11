import { describe, expect, it, vi } from 'vitest';
import { DomainError, err, ok } from '../../src/domain/errors.js';
import {
  addPaisa,
  multiplyPaisa,
  negatePaisa,
  paisa,
  subtractPaisa,
  ZERO_PAISA,
} from '../../src/domain/money.js';
import { monthStart, nextMonthStart } from '../../src/domain/month-math.js';
import { maskPaymentReference } from '../../src/domain/reference-masking.js';
import {
  addDays,
  createWallClock,
  daysInMonth,
  fromEpochMs,
  isAfter,
  isBefore,
  isEqual,
  isLeapYear,
  startOfNextDay,
  toEpochMs,
} from '../../src/domain/wall-clock.js';

describe('Unit Extensions Suite', () => {
  describe('Reference Masking (maskPaymentReference)', () => {
    it('returns empty string for null, undefined, or empty string', () => {
      expect(maskPaymentReference(null)).toBe('');
      expect(maskPaymentReference(undefined)).toBe('');
      expect(maskPaymentReference('')).toBe('');
    });

    it('returns "Ref ••••" for references of 4 characters or fewer (never reveals short refs)', () => {
      expect(maskPaymentReference('   ')).toBe('Ref ••••');
      expect(maskPaymentReference('A')).toBe('Ref ••••');
      expect(maskPaymentReference('AB')).toBe('Ref ••••');
      expect(maskPaymentReference('123')).toBe('Ref ••••');
      expect(maskPaymentReference('1234')).toBe('Ref ••••');
    });

    it('returns "Ref ••••" + last 4 characters for references longer than 4 characters', () => {
      expect(maskPaymentReference('12345')).toBe('Ref ••••2345');
      expect(maskPaymentReference('TXN-9876543210')).toBe('Ref ••••3210');
      expect(maskPaymentReference('123456789012')).toBe('Ref ••••9012');
    });

    it('trims whitespace before calculating length and mask', () => {
      expect(maskPaymentReference('   1234   ')).toBe('Ref ••••');
      expect(maskPaymentReference('   12345678   ')).toBe('Ref ••••5678');
    });
  });

  describe('Civil Calendar Arithmetic (WallClock)', () => {
    it('identifies leap years correctly', () => {
      expect(isLeapYear(2024)).toBe(true);
      expect(isLeapYear(2000)).toBe(true);
      expect(isLeapYear(2023)).toBe(false);
      expect(isLeapYear(2100)).toBe(false);
      expect(isLeapYear(1900)).toBe(false);
    });

    it('returns correct days in month for regular and leap years', () => {
      expect(daysInMonth(2024, 2)).toBe(29);
      expect(daysInMonth(2023, 2)).toBe(28);
      expect(daysInMonth(2026, 1)).toBe(31);
      expect(daysInMonth(2026, 4)).toBe(30);
      expect(daysInMonth(2026, 12)).toBe(31);
    });

    it('throws on invalid calendar dates in createWallClock', () => {
      expect(() => createWallClock(2023, 2, 29)).toThrow(DomainError);
      expect(() => createWallClock(2024, 2, 30)).toThrow(DomainError);
      expect(() => createWallClock(2026, 4, 31)).toThrow(DomainError);
      expect(() => createWallClock(2026, 0, 1)).toThrow(DomainError);
      expect(() => createWallClock(2026, 13, 1)).toThrow(DomainError);
      expect(() => createWallClock(2026, 1, 0)).toThrow(DomainError);
      expect(() => createWallClock(2026, 1, 32)).toThrow(DomainError);
      expect(() => createWallClock(2026, 1, 1, 24, 0, 0)).toThrow(DomainError);
      expect(() => createWallClock(2026, 1, 1, 0, 60, 0)).toThrow(DomainError);
      expect(() => createWallClock(2026, 1, 1, 0, 0, 60)).toThrow(DomainError);
      expect(() => createWallClock(2026, 1, 1, 0, 0, 0, 1000)).toThrow(
        DomainError,
      );
    });

    it('performs pure civil addDays across month and year boundaries', () => {
      const dec31 = createWallClock(2025, 12, 31, 12, 0, 0);
      const jan1 = addDays(dec31, 1);
      expect(jan1.y).toBe(2026);
      expect(jan1.m).toBe(1);
      expect(jan1.d).toBe(1);
      expect(jan1.h).toBe(12);

      const feb28Leap = createWallClock(2024, 2, 28, 10, 30, 0);
      const feb29 = addDays(feb28Leap, 1);
      expect(feb29.m).toBe(2);
      expect(feb29.d).toBe(29);

      const mar1 = addDays(feb28Leap, 2);
      expect(mar1.m).toBe(3);
      expect(mar1.d).toBe(1);

      const jan1_2026 = createWallClock(2026, 1, 1);
      const prevDec31 = addDays(jan1_2026, -1);
      expect(prevDec31.y).toBe(2025);
      expect(prevDec31.m).toBe(12);
      expect(prevDec31.d).toBe(31);
    });

    it('startOfNextDay resets time components to 00:00:00.000 of next day', () => {
      const evening = createWallClock(2026, 5, 15, 23, 59, 59, 999);
      const nextDay = startOfNextDay(evening);
      expect(nextDay.y).toBe(2026);
      expect(nextDay.m).toBe(5);
      expect(nextDay.d).toBe(16);
      expect(nextDay.h).toBe(0);
      expect(nextDay.mi).toBe(0);
      expect(nextDay.s).toBe(0);
      expect(nextDay.ms).toBe(0);
    });

    it('toEpochMs and fromEpochMs round-trip accurately', () => {
      const original = createWallClock(2026, 11, 15, 14, 30, 45, 123);
      const epochMs = toEpochMs(original);
      const restored = fromEpochMs(epochMs);
      expect(isEqual(original, restored)).toBe(true);
    });

    it('evaluates comparison operators correctly', () => {
      const t1 = createWallClock(2026, 1, 1, 10, 0, 0);
      const t2 = createWallClock(2026, 1, 1, 10, 0, 1);
      const t3 = createWallClock(2026, 1, 1, 10, 0, 0);

      expect(isBefore(t1, t2)).toBe(true);
      expect(isBefore(t2, t1)).toBe(false);
      expect(isAfter(t2, t1)).toBe(true);
      expect(isAfter(t1, t2)).toBe(false);
      expect(isEqual(t1, t3)).toBe(true);
      expect(isEqual(t1, t2)).toBe(false);
    });

    it('monthStart and nextMonthStart compute civil boundaries', () => {
      const midMonth = createWallClock(2026, 2, 15, 15, 45, 0);
      const start = monthStart(midMonth);
      expect(start).toEqual(createWallClock(2026, 2, 1, 0, 0, 0, 0));

      const next = nextMonthStart(midMonth);
      expect(next).toEqual(createWallClock(2026, 3, 1, 0, 0, 0, 0));

      const decMid = createWallClock(2026, 12, 20);
      const nextYear = nextMonthStart(decMid);
      expect(nextYear).toEqual(createWallClock(2027, 1, 1, 0, 0, 0, 0));
    });
  });

  describe('Paisa Safe Integer Arithmetic & Guards', () => {
    it('creates branded Paisa from safe integers', () => {
      const amount = paisa(5000);
      expect(amount).toBe(5000);
      expect(ZERO_PAISA).toBe(0);
    });

    it('rejects non-integer values', () => {
      expect(() => paisa(12.34)).toThrow(DomainError);
      expect(() => paisa(0.1)).toThrow(DomainError);
    });

    it('rejects NaN and +/-Infinity', () => {
      expect(() => paisa(Number.NaN)).toThrow(DomainError);
      expect(() => paisa(Number.POSITIVE_INFINITY)).toThrow(DomainError);
      expect(() => paisa(Number.NEGATIVE_INFINITY)).toThrow(DomainError);
    });

    it('rejects integers exceeding Number.MAX_SAFE_INTEGER', () => {
      expect(() => paisa(Number.MAX_SAFE_INTEGER + 1)).toThrow(DomainError);
      expect(() => paisa(Number.MIN_SAFE_INTEGER - 1)).toThrow(DomainError);
    });

    it('handles addPaisa, subtractPaisa, multiplyPaisa, negatePaisa correctly', () => {
      const a = paisa(100);
      const b = paisa(50);

      expect(addPaisa(a, b)).toBe(150);
      expect(subtractPaisa(a, b)).toBe(50);
      expect(multiplyPaisa(a, 3)).toBe(300);
      expect(negatePaisa(a)).toBe(-100);
      expect(negatePaisa(paisa(0)) + 0).toBe(0);
    });

    it('guards against arithmetic overflow in multiplyPaisa', () => {
      expect(() => multiplyPaisa(paisa(Number.MAX_SAFE_INTEGER), 2)).toThrow(
        DomainError,
      );
    });
  });

  describe('DomainError and Result Monad', () => {
    it('creates DomainError with correct code, name, and message', () => {
      const errorCodes = [
        'invalidInput',
        'groupAccess',
        'permissionDenied',
        'insufficientBalance',
        'duplicateReference',
        'conflict',
        'notFound',
        'unknown',
      ];

      for (const code of errorCodes) {
        const err = new DomainError(code, `Test error for ${code}`);
        expect(err.code).toBe(code);
        expect(err.name).toBe('DomainError');
        expect(err.message).toBe(`Test error for ${code}`);
        expect(err instanceof Error).toBe(true);
      }
    });

    it('creates and checks Result.ok', () => {
      const result = ok(42);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    it('creates and checks Result.err', () => {
      const dErr = new DomainError('notFound', 'Item not found');
      const result = err(dErr);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('notFound');
      }
    });
  });

  describe('Determinism Check', () => {
    it('domain functions do not read global Date or Date.now', () => {
      const dateSpy = vi.spyOn(Date, 'now');

      const wc = createWallClock(2026, 11, 15, 12, 0, 0);
      const nextDay = addDays(wc, 5);
      const ms = toEpochMs(nextDay);
      const fromMs = fromEpochMs(ms);
      const start = monthStart(fromMs);
      const nextMonth = nextMonthStart(fromMs);
      const p = paisa(1000);
      const sum = addPaisa(p, paisa(500));
      const masked = maskPaymentReference('TXN-12345678');

      expect(nextDay.d).toBe(20);
      expect(start.d).toBe(1);
      expect(nextMonth.m).toBe(12);
      expect(sum).toBe(1500);
      expect(masked).toBe('Ref ••••5678');

      expect(dateSpy).not.toHaveBeenCalled();
      dateSpy.mockRestore();
    });
  });
});
