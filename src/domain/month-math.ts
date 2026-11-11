import type { WallClock } from './wall-clock.js';
import { createWallClock } from './wall-clock.js';

/**
 * Returns the first day of date's calendar month at midnight (00:00:00.000).
 * Ports Dart lib/core/mock/month_math.dart:monthStart
 */
export function monthStart(date: WallClock): WallClock {
  return createWallClock(date.y, date.m, 1, 0, 0, 0, 0);
}

/**
 * Returns the first day of the calendar month after date's month at midnight.
 * Handles the December-to-January year rollover.
 * Ports Dart lib/core/mock/month_math.dart:nextMonthStart
 */
export function nextMonthStart(date: WallClock): WallClock {
  const nextM = date.m === 12 ? 1 : date.m + 1;
  const nextY = date.m === 12 ? date.y + 1 : date.y;
  return createWallClock(nextY, nextM, 1, 0, 0, 0, 0);
}
