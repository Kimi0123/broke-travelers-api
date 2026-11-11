import type { ActivityKind, PaymentStatus } from './enums.js';
import type { Paisa } from './money.js';
import type { WallClock } from './wall-clock.js';

/**
 * Read-only, normalized ledger line used by report builders.
 * Ports Dart lib/features/reports/domain/ledger_line.dart:LedgerLine
 */
export interface LedgerLine {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly status: PaymentStatus;
  readonly amount: Paisa;
  readonly signed: Paisa;
  readonly occurredAt: WallClock;
  readonly periodMonth?: WallClock | null | undefined;
  readonly memberId?: string | null | undefined;
  readonly title: string;
  readonly reversesId?: string | null | undefined;
}

/**
 * Read-only roster member data used to derive member obligations.
 * Ports Dart lib/features/reports/domain/member_line.dart:ReportMember
 */
export interface ReportMember {
  readonly id: string;
  readonly name: string;
  readonly joinedAt: WallClock;
  readonly leftAt?: WallClock | null | undefined;
}

/**
 * Monthly ledger and contribution obligation report.
 * Ports Dart lib/features/reports/domain/report_entities.dart:MonthlyReport
 */
export interface MonthlyReport {
  readonly month: WallClock;
  readonly openingPaisa: Paisa;
  readonly contributionsPaisa: Paisa;
  readonly interestPaisa: Paisa;
  readonly expensesPaisa: Paisa;
  readonly withdrawalsPaisa: Paisa;
  readonly closingPaisa: Paisa;
  readonly pendingPaisa: Paisa;
  readonly obligatedCount: number;
  readonly verifiedCount: number;
  readonly expectedTotalPaisa: Paisa;
  readonly outstandingPaisa: Paisa;
}

/**
 * Per-member contribution obligation row for one month.
 * Ports Dart lib/features/reports/domain/report_entities.dart:MemberReportRow
 */
export interface MemberReportRow {
  readonly memberId: string;
  readonly name: string;
  readonly expectedPaisa: Paisa;
  readonly verifiedPaisa: Paisa;
  readonly pendingPaisa: Paisa;
  readonly outstandingPaisa: Paisa;
  readonly status: PaymentStatus;
}

/**
 * Member contribution report for one month.
 * Ports Dart lib/features/reports/domain/report_entities.dart:MemberReport
 */
export interface MemberReport {
  readonly month: WallClock;
  readonly rows: readonly MemberReportRow[];
  readonly expectedTotalPaisa: Paisa;
  readonly verifiedTotalPaisa: Paisa;
  readonly pendingTotalPaisa: Paisa;
  readonly outstandingTotalPaisa: Paisa;
}

/**
 * One month in an annual ledger report.
 * Ports Dart lib/features/reports/domain/report_entities.dart:AnnualMonthRow
 */
export interface AnnualMonthRow {
  readonly month: WallClock;
  readonly contributionsPaisa: Paisa;
  readonly interestPaisa: Paisa;
  readonly expensesPaisa: Paisa;
  readonly withdrawalsPaisa: Paisa;
  readonly netPaisa: Paisa;
  readonly closingPaisa: Paisa;
}

/**
 * Annual ledger report spanning all months of a calendar year up to lastMonth.
 * Ports Dart lib/features/reports/domain/report_entities.dart:AnnualReport
 */
export interface AnnualReport {
  readonly year: number;
  readonly months: readonly AnnualMonthRow[];
  readonly contributionsPaisa: Paisa;
  readonly interestPaisa: Paisa;
  readonly expensesPaisa: Paisa;
  readonly withdrawalsPaisa: Paisa;
  readonly netPaisa: Paisa;
  readonly closingPaisa: Paisa;
}

/**
 * One outflow ledger line in an outflow report.
 * Ports Dart lib/features/reports/domain/report_entities.dart:OutflowRow
 */
export interface OutflowRow {
  readonly id: string;
  readonly title: string;
  readonly date: WallClock;
  readonly amountPaisa: Paisa;
  readonly isReversed: boolean;
  readonly isReversal: boolean;
}

/**
 * Net outflow total for one calendar month.
 * Ports Dart lib/features/reports/domain/report_entities.dart:OutflowMonthTotal
 */
export interface OutflowMonthTotal {
  readonly month: WallClock;
  readonly totalPaisa: Paisa;
}

/**
 * Annual report for one outflow kind with reversal-adjusted totals.
 * Ports Dart lib/features/reports/domain/report_entities.dart:OutflowReport
 */
export interface OutflowReport {
  readonly year: number;
  readonly kind: ActivityKind;
  readonly rows: readonly OutflowRow[];
  readonly totalPaisa: Paisa;
  readonly monthTotals: readonly OutflowMonthTotal[];
}
