import {
  createWallClock,
  type Clock,
  type WallClock,
} from '../../domain/wall-clock.js';

/**
 * Nepal Time (NPT) offset from UTC in milliseconds (+05:45).
 * Nepal does not observe Daylight Saving Time (DST).
 */
export const NPT_OFFSET_MINUTES = 345;
export const NPT_OFFSET_MS = NPT_OFFSET_MINUTES * 60 * 1000;

/**
 * Converts a UTC Date instant into an NPT WallClock representation
 * using the fixed +05:45 offset.
 */
export function utcInstantToNptWallClock(date: Date): WallClock {
  const shifted = new Date(date.getTime() + NPT_OFFSET_MS);
  return createWallClock(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    shifted.getUTCHours(),
    shifted.getUTCMinutes(),
    shifted.getUTCSeconds(),
    shifted.getUTCMilliseconds(),
  );
}

/**
 * Converts an NPT WallClock representation back into a UTC Date instant.
 */
export function nptWallClockToUtcInstant(wc: WallClock): Date {
  const pseudoUtcMs = Date.UTC(wc.y, wc.m - 1, wc.d, wc.h, wc.mi, wc.s, wc.ms);
  return new Date(pseudoUtcMs - NPT_OFFSET_MS);
}

/**
 * Converts a database Date-only value (stored at UTC midnight) to an NPT WallClock
 * anchored at midnight (00:00:00.000).
 */
export function dateOnlyToWallClock(date: Date): WallClock {
  return createWallClock(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    0,
    0,
    0,
    0,
  );
}

/**
 * Converts an NPT WallClock calendar date into a UTC Date anchored at midnight
 * suitable for PostgreSQL DATE columns.
 */
export function wallClockToDateOnly(wc: WallClock): Date {
  return new Date(Date.UTC(wc.y, wc.m - 1, wc.d));
}

export interface SystemClockObject {
  nowWallClock: () => WallClock;
}

export type SystemClock = Clock & SystemClockObject;

/**
 * System clock configured for NPT (+05:45).
 * Can be called directly as a Clock function `systemClockUtc()` or via `.nowWallClock()`.
 */
export const systemClockUtc: SystemClock = Object.assign(
  (() => utcInstantToNptWallClock(new Date())) as Clock,
  {
    nowWallClock: () => utcInstantToNptWallClock(new Date()),
  },
);
