import { createWallClock, daysInMonth, type WallClock } from './wall-clock.js';

/**
 * Pure integer truncation division equivalent to Dart ~/
 */
function intDiv(n: number, d: number): number {
  return (n - (n % d)) / d;
}

/**
 * Returns the due date for [month] in [year], clamping [dueDay] to the last
 * calendar day of that month (e.g. 28/29 for February, 30 for April) to
 * prevent month overflow. Clamps minimum day to 1.
 *
 * Ports Dart lib/shared/utils/calendar_date_utils.dart:dueDateFor
 */
export function dueDateFor(
  year: number,
  month: number,
  dueDay: number,
): WallClock {
  let normalizedY = year;
  let normalizedM = month;

  if (month < 1 || month > 12) {
    const totalMonths = year * 12 + (month - 1);
    normalizedY = intDiv(totalMonths, 12);
    normalizedM = (((totalMonths % 12) + 12) % 12) + 1;
  }

  const lastDay = daysInMonth(normalizedY, normalizedM);
  const clampedDay = dueDay < 1 ? 1 : dueDay > lastDay ? lastDay : dueDay;

  return createWallClock(normalizedY, normalizedM, clampedDay, 0, 0, 0, 0);
}
