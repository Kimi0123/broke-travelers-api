import { isOutflow, type ActivityKind } from './enums.js';
import { DomainError } from './errors.js';
import { verifiedBalancePaisa } from './ledger-math.js';
import {
  addPaisa,
  multiplyPaisa,
  paisa,
  subtractPaisa,
  ZERO_PAISA,
  type Paisa,
} from './money.js';
import { monthStart, nextMonthStart } from './month-math.js';
import { deriveObligationStatus } from './obligation-status.js';
import type {
  AnnualMonthRow,
  AnnualReport,
  LedgerLine,
  MemberReport,
  MemberReportRow,
  MonthlyReport,
  OutflowMonthTotal,
  OutflowReport,
  OutflowRow,
  ReportMember,
} from './report-types.js';
import type { LedgerEntry } from './types.js';
import {
  addMonths,
  createWallClock,
  daysInMonth,
  endOfDayInclusive,
  isAfter,
  isBefore,
  isEqual,
  type WallClock,
} from './wall-clock.js';

/**
 * Converts a report LedgerLine into a domain LedgerEntry.
 */
export function lineToLedgerEntry(line: LedgerLine): LedgerEntry {
  return {
    id: line.id,
    kind: line.kind,
    status: line.status,
    magnitudePaisa: line.amount,
    occurredAt: line.occurredAt,
    periodMonth: line.periodMonth,
    memberId: line.memberId,
    title: line.title,
    reversesEntryId: line.reversesId,
  };
}

/**
 * Returns the inclusive end of [month] (e.g. 23:59:59.999 on the last calendar day).
 */
function monthEnd(month: WallClock): WallClock {
  const lastDay = daysInMonth(month.y, month.m);
  return endOfDayInclusive(createWallClock(month.y, month.m, lastDay));
}

/**
 * Returns whether [member] was active and obligated for contributions in [month].
 *
 * Ports Dart lib/features/reports/domain/report_builders.dart:_obligated
 */
export function isObligated(member: ReportMember, month: WallClock): boolean {
  const end = monthEnd(month);
  const nextStart = nextMonthStart(month);
  return (
    isBefore(member.joinedAt, nextStart) &&
    (member.leftAt == null || !isBefore(member.leftAt, end))
  );
}

/**
 * Returns the verified balance at the inclusive end of a date.
 *
 * Ports Dart lib/features/reports/domain/report_builders.dart:balanceAsOf
 */
export function balanceAsOf(
  lines: readonly LedgerLine[],
  endOfDay: WallClock,
): Paisa {
  return verifiedBalancePaisa(lines.map(lineToLedgerEntry), {
    asOf: endOfDay,
  });
}

/**
 * Builds a monthly report. Contributions use effective period month, while
 * opening and closing balances use the ledger occurredAt timeline.
 *
 * Ports Dart lib/features/reports/domain/report_builders.dart:buildMonthlyReport
 */
export function buildMonthlyReport(params: {
  readonly lines: readonly LedgerLine[];
  readonly members: readonly ReportMember[];
  readonly expectedPerMember: Paisa;
  readonly month: WallClock;
  readonly anchorMonth?: WallClock | null;
}): MonthlyReport {
  const { lines, members, expectedPerMember, month, anchorMonth } = params;
  const normalized = monthStart(month);
  const nextStart = nextMonthStart(normalized);

  // Verified entries whose occurredAt falls inside this calendar month
  const verifiedInMonth = lines.filter(
    (l) =>
      l.status === 'verified' &&
      !isBefore(l.occurredAt, normalized) &&
      isBefore(l.occurredAt, nextStart),
  );

  // Contributions whose effective period month equals normalized month
  const contributionsForPeriod = lines.filter((l) => {
    const period = monthStart(l.periodMonth ?? l.occurredAt);
    return (
      l.kind === 'contribution' &&
      l.status === 'verified' &&
      isEqual(period, normalized)
    );
  });

  // Pending contributions for this period
  const pendingForPeriod = lines.filter((l) => {
    const period = monthStart(l.periodMonth ?? l.occurredAt);
    return (
      l.kind === 'contribution' &&
      l.status === 'pendingVerification' &&
      isEqual(period, normalized)
    );
  });

  const obligated = members.filter((m) => isObligated(m, normalized));
  const entries = lines.map(lineToLedgerEntry);

  const verifiedMembers = obligated.filter(
    (m) =>
      deriveObligationStatus({
        entries,
        memberId: m.id,
        periodStart: normalized,
        anchorPeriodStart: anchorMonth ?? normalized,
      }) === 'verified',
  );

  const prevMonth = addMonths(normalized, -1);
  const openingPaisa = balanceAsOf(lines, monthEnd(prevMonth));
  const closingPaisa = balanceAsOf(lines, monthEnd(normalized));

  const interestLines = verifiedInMonth.filter((l) => l.kind === 'interest');
  const expenseLines = verifiedInMonth.filter((l) => l.kind === 'expense');
  const withdrawalLines = verifiedInMonth.filter(
    (l) => l.kind === 'withdrawal',
  );

  const sumSignedRaw = (items: readonly LedgerLine[]): number =>
    items.reduce((acc, l) => acc + (l.signed as number), 0);

  const sumAmountRaw = (items: readonly LedgerLine[]): number =>
    items.reduce((acc, l) => acc + (l.amount as number), 0);

  const contributionsRaw = sumSignedRaw(contributionsForPeriod);
  const interestRaw = sumSignedRaw(interestLines);
  const expensesRaw = -sumSignedRaw(expenseLines);
  const withdrawalsRaw = -sumSignedRaw(withdrawalLines);
  const pendingRaw = sumAmountRaw(pendingForPeriod);

  const expectedTotalPaisa = multiplyPaisa(expectedPerMember, obligated.length);
  const verifiedContribRaw = contributionsForPeriod
    .filter((l) => l.memberId != null)
    .reduce((acc, l) => acc + (l.signed as number), 0);

  const expectedRaw = expectedTotalPaisa as number;
  const outstandingRaw = expectedRaw - verifiedContribRaw;
  const clampedOutstanding =
    outstandingRaw < 0
      ? 0
      : outstandingRaw > expectedRaw
        ? expectedRaw
        : outstandingRaw;

  return {
    month: normalized,
    openingPaisa,
    contributionsPaisa:
      contributionsRaw === 0 ? ZERO_PAISA : paisa(contributionsRaw),
    interestPaisa: interestRaw === 0 ? ZERO_PAISA : paisa(interestRaw),
    expensesPaisa: expensesRaw === 0 ? ZERO_PAISA : paisa(expensesRaw),
    withdrawalsPaisa: withdrawalsRaw === 0 ? ZERO_PAISA : paisa(withdrawalsRaw),
    closingPaisa,
    pendingPaisa: pendingRaw === 0 ? ZERO_PAISA : paisa(pendingRaw),
    obligatedCount: obligated.length,
    verifiedCount: verifiedMembers.length,
    expectedTotalPaisa,
    outstandingPaisa:
      clampedOutstanding === 0 ? ZERO_PAISA : paisa(clampedOutstanding),
  };
}

/**
 * Builds member contribution rows for one month.
 *
 * Ports Dart lib/features/reports/domain/report_builders.dart:buildMemberReport
 */
export function buildMemberReport(params: {
  readonly lines: readonly LedgerLine[];
  readonly members: readonly ReportMember[];
  readonly expectedPerMember: Paisa;
  readonly month: WallClock;
  readonly anchorMonth?: WallClock | null;
}): MemberReport {
  const { lines, members, expectedPerMember, month, anchorMonth } = params;
  const normalized = monthStart(month);
  const entries = lines.map(lineToLedgerEntry);
  const rows: MemberReportRow[] = [];

  const obligated = members.filter((m) => isObligated(m, normalized));

  for (const member of obligated) {
    const matching = lines.filter((l) => {
      const period = monthStart(l.periodMonth ?? l.occurredAt);
      return (
        l.kind === 'contribution' &&
        l.memberId === member.id &&
        isEqual(period, normalized)
      );
    });

    const verifiedRaw = matching
      .filter((l) => l.status === 'verified')
      .reduce((acc, l) => acc + (l.amount as number), 0);

    const pendingRaw = matching
      .filter((l) => l.status === 'pendingVerification')
      .reduce((acc, l) => acc + (l.amount as number), 0);

    const expRaw = expectedPerMember as number;
    const outstandingRaw = expRaw - verifiedRaw;
    const clampedOutstanding =
      outstandingRaw < 0
        ? 0
        : outstandingRaw > expRaw
          ? expRaw
          : outstandingRaw;

    const status = deriveObligationStatus({
      entries,
      memberId: member.id,
      periodStart: normalized,
      anchorPeriodStart: anchorMonth ?? normalized,
    });

    rows.push({
      memberId: member.id,
      name: member.name,
      expectedPaisa: expectedPerMember,
      verifiedPaisa: verifiedRaw === 0 ? ZERO_PAISA : paisa(verifiedRaw),
      pendingPaisa: pendingRaw === 0 ? ZERO_PAISA : paisa(pendingRaw),
      outstandingPaisa:
        clampedOutstanding === 0 ? ZERO_PAISA : paisa(clampedOutstanding),
      status,
    });
  }

  const sumField = (fn: (r: MemberReportRow) => Paisa): Paisa => {
    const total = rows.reduce((acc, r) => acc + (fn(r) as number), 0);
    return total === 0 ? ZERO_PAISA : paisa(total);
  };

  return {
    month: normalized,
    rows,
    expectedTotalPaisa: sumField((r) => r.expectedPaisa),
    verifiedTotalPaisa: sumField((r) => r.verifiedPaisa),
    pendingTotalPaisa: sumField((r) => r.pendingPaisa),
    outstandingTotalPaisa: sumField((r) => r.outstandingPaisa),
  };
}

/**
 * Builds monthly ledger totals for a calendar year up to lastMonth.
 *
 * Ports Dart lib/features/reports/domain/report_builders.dart:buildAnnualReport
 */
export function buildAnnualReport(params: {
  readonly lines: readonly LedgerLine[];
  readonly year: number;
  readonly lastMonth: WallClock;
}): AnnualReport {
  const { lines, year, lastMonth } = params;

  const verifiedInYear = lines.filter(
    (l) => l.status === 'verified' && l.occurredAt.y === year,
  );

  let firstMonth: WallClock;
  if (verifiedInYear.length === 0) {
    firstMonth = createWallClock(year, 1, 1);
  } else {
    let earliest = verifiedInYear[0]!.occurredAt;
    for (const l of verifiedInYear) {
      if (isBefore(l.occurredAt, earliest)) {
        earliest = l.occurredAt;
      }
    }
    firstMonth = monthStart(earliest);
  }

  const endMonth = createWallClock(year, lastMonth.m, 1);
  const months: AnnualMonthRow[] = [];

  for (
    let cur = firstMonth;
    !isAfter(cur, endMonth);
    cur = nextMonthStart(cur)
  ) {
    const monthly = buildMonthlyReport({
      lines,
      members: constEmptyMembers,
      expectedPerMember: ZERO_PAISA,
      month: cur,
    });

    const net = subtractPaisa(
      subtractPaisa(
        addPaisa(monthly.contributionsPaisa, monthly.interestPaisa),
        monthly.expensesPaisa,
      ),
      monthly.withdrawalsPaisa,
    );

    months.push({
      month: cur,
      contributionsPaisa: monthly.contributionsPaisa,
      interestPaisa: monthly.interestPaisa,
      expensesPaisa: monthly.expensesPaisa,
      withdrawalsPaisa: monthly.withdrawalsPaisa,
      netPaisa: net,
      closingPaisa: monthly.closingPaisa,
    });
  }

  const sumMonths = (fn: (m: AnnualMonthRow) => Paisa): Paisa => {
    const raw = months.reduce((acc, m) => acc + (fn(m) as number), 0);
    return raw === 0 ? ZERO_PAISA : paisa(raw);
  };

  const contributionsPaisa = sumMonths((m) => m.contributionsPaisa);
  const interestPaisa = sumMonths((m) => m.interestPaisa);
  const expensesPaisa = sumMonths((m) => m.expensesPaisa);
  const withdrawalsPaisa = sumMonths((m) => m.withdrawalsPaisa);

  const netPaisa = subtractPaisa(
    subtractPaisa(addPaisa(contributionsPaisa, interestPaisa), expensesPaisa),
    withdrawalsPaisa,
  );

  const closingPaisa =
    months.length === 0 ? ZERO_PAISA : months[months.length - 1]!.closingPaisa;

  return {
    year,
    months,
    contributionsPaisa,
    interestPaisa,
    expensesPaisa,
    withdrawalsPaisa,
    netPaisa,
    closingPaisa,
  };
}

const constEmptyMembers: readonly ReportMember[] = [];

/**
 * Builds an annual report for one outflow kind with reversal-adjusted totals.
 *
 * Ports Dart lib/features/reports/domain/report_builders.dart:buildOutflowReport
 */
export function buildOutflowReport(params: {
  readonly lines: readonly LedgerLine[];
  readonly year: number;
  readonly kind: ActivityKind;
}): OutflowReport {
  const { lines, year, kind } = params;

  if (!isOutflow(kind)) {
    throw new DomainError(
      'invalidInput',
      'Outflow reports require an outflow kind (expense or withdrawal)',
    );
  }

  const relevant = lines.filter(
    (l) =>
      l.kind === kind && l.occurredAt.y === year && l.status === 'verified',
  );

  const rows: OutflowRow[] = relevant.map((line) => ({
    id: line.id,
    title: line.title,
    date: line.occurredAt,
    amountPaisa: line.amount,
    isReversed: lines.some((other) => other.reversesId === line.id),
    isReversal: line.reversesId != null,
  }));

  const signedTotalRaw = relevant.reduce(
    (sum, line) => sum + (line.signed as number),
    0,
  );
  const totalPaisa = paisa(
    signedTotalRaw < 0 ? -signedTotalRaw : signedTotalRaw,
  );

  const monthTotals: OutflowMonthTotal[] = [];
  for (let m = 1; m <= 12; m++) {
    const monthLines = relevant.filter((l) => l.occurredAt.m === m);
    const monthRaw = monthLines.reduce(
      (sum, l) => sum + (l.signed as number),
      0,
    );
    const monthTotalPaisa =
      monthRaw === 0 ? ZERO_PAISA : paisa(monthRaw < 0 ? -monthRaw : monthRaw);

    monthTotals.push({
      month: createWallClock(year, m, 1),
      totalPaisa: monthTotalPaisa,
    });
  }

  return {
    year,
    kind,
    rows,
    totalPaisa,
    monthTotals,
  };
}
