import type { WallClock } from '../domain/wall-clock.js';

const MONTH_NAMES_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const MONTH_NAMES_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * Formats an integer paisa amount as an NPR currency string adhering to the
 * Indian lakh grouping system (matching Dart Money.formatted).
 *
 * Examples:
 * - 0 paisa -> "NPR 0"
 * - 70000 paisa -> "NPR 700"
 * - 210000 paisa -> "NPR 2,100"
 * - 730000 paisa -> "NPR 7,300"
 * - -50000 paisa -> "-NPR 500"
 * - 730005 paisa -> "NPR 7,300.05"
 */
export function formatMoneyPaisa(amountPaisa: number): string {
  const isNegative = amountPaisa < 0;
  const absPaisa = Math.abs(amountPaisa);
  const rupees = Math.floor(absPaisa / 100);
  const remPaisa = absPaisa % 100;
  const formattedRupees = new Intl.NumberFormat('en-IN').format(rupees);
  const sign = isNegative ? '-' : '';

  if (remPaisa === 0) {
    return `${sign}NPR ${formattedRupees}`;
  }
  const paisaStr = remPaisa.toString().padStart(2, '0');
  return `${sign}NPR ${formattedRupees}.${paisaStr}`;
}

/**
 * Formats a WallClock or Date as "MMMM y" (e.g. "November 2026").
 */
export function formatMonthYear(wc: WallClock | Date): string {
  if (wc instanceof Date) {
    const m = wc.getUTCMonth();
    const y = wc.getUTCFullYear();
    return `${MONTH_NAMES_LONG[m]} ${y}`;
  }
  return `${MONTH_NAMES_LONG[wc.m - 1]} ${wc.y}`;
}

/**
 * Formats a Date as "d MMM y" in UTC (e.g. "5 Nov 2026").
 */
export function formatDayMonthYear(d: Date): string {
  const day = d.getUTCDate();
  const m = d.getUTCMonth();
  const y = d.getUTCFullYear();
  return `${day} ${MONTH_NAMES_SHORT[m]} ${y}`;
}

/**
 * Formats a Date as "d MMM" in UTC (e.g. "5 Nov").
 */
export function formatDayMonth(d: Date): string {
  const day = d.getUTCDate();
  const m = d.getUTCMonth();
  return `${day} ${MONTH_NAMES_SHORT[m]}`;
}

/**
 * Formats a Date as "MMMM" in UTC (e.g. "November").
 */
export function formatMonthName(d: Date): string {
  const m = d.getUTCMonth();
  return `${MONTH_NAMES_LONG[m]}`;
}
