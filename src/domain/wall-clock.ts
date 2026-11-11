import { DomainError } from './errors.js';

/**
 * Representation of a calendar point in time using wall-clock components.
 * Independent of machine timezones and daylight saving transitions.
 */
export interface WallClock {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly h: number;
  readonly mi: number;
  readonly s: number;
  readonly ms: number;
}

/**
 * Injected clock function returning the current wall-clock time.
 * Pure domain logic never calls system Date directly.
 */
export type Clock = () => WallClock;

/**
 * Pure integer truncation division: (n - (n % d)) / d.
 * Equivalent to Dart's ~/ operator.
 */
function intDiv(n: number, d: number): number {
  return (n - (n % d)) / d;
}

/**
 * Returns whether [year] is a leap year in the Gregorian calendar.
 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Returns the number of days in [month] (1..12) for [year].
 */
export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      throw new DomainError('invalidInput', `Invalid month: ${month}`);
  }
}

/**
 * Creates and validates a WallClock instance from integer components.
 */
export function createWallClock(
  y: number,
  m: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
  ms = 0,
): WallClock {
  if (
    !Number.isInteger(y) ||
    !Number.isInteger(m) ||
    !Number.isInteger(d) ||
    !Number.isInteger(h) ||
    !Number.isInteger(mi) ||
    !Number.isInteger(s) ||
    !Number.isInteger(ms)
  ) {
    throw new DomainError(
      'invalidInput',
      'WallClock components must all be integers',
    );
  }
  if (m < 1 || m > 12) {
    throw new DomainError('invalidInput', `Month out of range (1..12): ${m}`);
  }
  const maxDay = daysInMonth(y, m);
  if (d < 1 || d > maxDay) {
    throw new DomainError(
      'invalidInput',
      `Day out of range (1..${maxDay}) for ${y}-${m}: ${d}`,
    );
  }
  if (h < 0 || h > 23) {
    throw new DomainError('invalidInput', `Hour out of range (0..23): ${h}`);
  }
  if (mi < 0 || mi > 59) {
    throw new DomainError('invalidInput', `Minute out of range (0..59): ${mi}`);
  }
  if (s < 0 || s > 59) {
    throw new DomainError('invalidInput', `Second out of range (0..59): ${s}`);
  }
  if (ms < 0 || ms > 999) {
    throw new DomainError(
      'invalidInput',
      `Millisecond out of range (0..999): ${ms}`,
    );
  }
  return { y, m, d, h, mi, s, ms };
}

/**
 * Computes civil calendar days from Unix epoch (1970-01-01) using Howard Hinnant's algorithm.
 */
function daysFromCivil(y: number, m: number, d: number): number {
  const yAdjusted = m <= 2 ? y - 1 : y;
  const era = intDiv(yAdjusted >= 0 ? yAdjusted : yAdjusted - 399, 400);
  const yoe = yAdjusted - era * 400;
  const mAdjusted = m <= 2 ? m + 9 : m - 3;
  const doy = intDiv(153 * mAdjusted + 2, 5) + d - 1;
  const doe = yoe * 365 + intDiv(yoe, 4) - intDiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * Converts civil days from Unix epoch back to civil date {y, m, d}.
 */
function civilFromDays(z: number): { y: number; m: number; d: number } {
  const zShifted = z + 719468;
  const era = intDiv(zShifted >= 0 ? zShifted : zShifted - 146096, 146097);
  const doe = zShifted - era * 146097;
  const yoe = intDiv(
    doe - intDiv(doe, 1460) + intDiv(doe, 36524) - intDiv(doe, 146096),
    365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + intDiv(yoe, 4) - intDiv(yoe, 100));
  const mp = intDiv(5 * doy + 2, 153);
  const d = doy - intDiv(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: m <= 2 ? y + 1 : y, m, d };
}

/**
 * Converts a WallClock into linear milliseconds from 1970-01-01 00:00:00.000.
 * Pure mathematical projection treating components as UTC-agnostic timeline.
 */
export function toEpochMs(wc: WallClock): number {
  const days = daysFromCivil(wc.y, wc.m, wc.d);
  return (
    days * 86_400_000 + wc.h * 3_600_000 + wc.mi * 60_000 + wc.s * 1_000 + wc.ms
  );
}

/**
 * Converts linear milliseconds back into a WallClock.
 */
export function fromEpochMs(epochMs: number): WallClock {
  let days = intDiv(epochMs, 86_400_000);
  let remMs = epochMs % 86_400_000;
  if (remMs < 0) {
    days -= 1;
    remMs += 86_400_000;
  }
  const { y, m, d } = civilFromDays(days);
  const h = intDiv(remMs, 3_600_000);
  remMs %= 3_600_000;
  const mi = intDiv(remMs, 60_000);
  remMs %= 60_000;
  const s = intDiv(remMs, 1_000);
  const ms = remMs % 1_000;
  return createWallClock(y, m, d, h, mi, s, ms);
}

/**
 * Compares two WallClock instances chronologically.
 * Returns -1 if a < b, 1 if a > b, 0 if identical.
 */
export function compareWallClock(a: WallClock, b: WallClock): number {
  if (a.y !== b.y) return a.y < b.y ? -1 : 1;
  if (a.m !== b.m) return a.m < b.m ? -1 : 1;
  if (a.d !== b.d) return a.d < b.d ? -1 : 1;
  if (a.h !== b.h) return a.h < b.h ? -1 : 1;
  if (a.mi !== b.mi) return a.mi < b.mi ? -1 : 1;
  if (a.s !== b.s) return a.s < b.s ? -1 : 1;
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  return 0;
}

export function isBefore(a: WallClock, b: WallClock): boolean {
  return compareWallClock(a, b) < 0;
}

export function isAfter(a: WallClock, b: WallClock): boolean {
  return compareWallClock(a, b) > 0;
}

export function isEqual(a: WallClock, b: WallClock): boolean {
  return compareWallClock(a, b) === 0;
}

/**
 * Returns true if both WallClock instances fall on the same calendar date.
 */
export function isSameDay(a: WallClock, b: WallClock): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d;
}

/**
 * Returns midnight (00:00:00.000) of the given WallClock's calendar day.
 */
export function startOfDay(wc: WallClock): WallClock {
  return createWallClock(wc.y, wc.m, wc.d, 0, 0, 0, 0);
}

/**
 * Returns midnight (00:00:00.000) of the next calendar day.
 */
export function startOfNextDay(wc: WallClock): WallClock {
  return addDays(startOfDay(wc), 1);
}

/**
 * Returns the inclusive end of the calendar day (23:59:59.999).
 */
export function endOfDayInclusive(wc: WallClock): WallClock {
  return createWallClock(wc.y, wc.m, wc.d, 23, 59, 59, 999);
}

/**
 * Adds whole calendar days to a WallClock.
 */
export function addDays(wc: WallClock, days: number): WallClock {
  if (!Number.isInteger(days)) {
    throw new DomainError('invalidInput', 'Days must be an integer');
  }
  const currentCivilDays = daysFromCivil(wc.y, wc.m, wc.d);
  const targetCivilDays = currentCivilDays + days;
  const { y, m, d } = civilFromDays(targetCivilDays);
  return createWallClock(y, m, d, wc.h, wc.mi, wc.s, wc.ms);
}

/**
 * Adds seconds to a WallClock.
 */
export function addSeconds(wc: WallClock, seconds: number): WallClock {
  if (!Number.isInteger(seconds)) {
    throw new DomainError('invalidInput', 'Seconds must be an integer');
  }
  const epochMs = toEpochMs(wc) + seconds * 1_000;
  return fromEpochMs(epochMs);
}

/**
 * Adds months to a WallClock, clamping the day to the last valid day of the target month.
 */
export function addMonths(wc: WallClock, months: number): WallClock {
  if (!Number.isInteger(months)) {
    throw new DomainError('invalidInput', 'Months must be an integer');
  }
  const totalMonths = wc.y * 12 + (wc.m - 1) + months;
  const targetY = intDiv(totalMonths, 12);
  const targetM = (((totalMonths % 12) + 12) % 12) + 1;
  const maxDay = daysInMonth(targetY, targetM);
  const targetD = wc.d > maxDay ? maxDay : wc.d;
  return createWallClock(targetY, targetM, targetD, wc.h, wc.mi, wc.s, wc.ms);
}
