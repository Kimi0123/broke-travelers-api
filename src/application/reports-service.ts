import type { PrismaClient } from '@prisma/client';
import type { ActivityKind, PaymentStatus } from '../domain/enums.js';
import { paisa, ZERO_PAISA } from '../domain/money.js';
import { monthStart, nextMonthStart } from '../domain/month-math.js';
import {
  buildAnnualReport,
  buildMemberReport,
  buildMonthlyReport,
  buildOutflowReport,
} from '../domain/report-builders.js';
import {
  createWallClock,
  isBefore,
  type WallClock,
} from '../domain/wall-clock.js';
import { HttpError } from '../http/errors.js';
import { loadGroupSnapshot, type GroupSnapshot } from './read-models.js';

export interface ReportMonthsDto {
  readonly earliestMonth: string;
  readonly anchorMonth: string;
  readonly selectableMonths: readonly string[];
  readonly selectableYears: readonly number[];
}

export interface MonthlyReportDto {
  readonly month: string;
  readonly openingPaisa: number;
  readonly contributionsPaisa: number;
  readonly interestPaisa: number;
  readonly expensesPaisa: number;
  readonly withdrawalsPaisa: number;
  readonly closingPaisa: number;
  readonly pendingPaisa: number;
  readonly obligatedCount: number;
  readonly verifiedCount: number;
  readonly expectedTotalPaisa: number;
  readonly outstandingPaisa: number;
}

export interface MemberReportRowDto {
  readonly memberId: string;
  readonly name: string;
  readonly expectedPaisa: number;
  readonly verifiedPaisa: number;
  readonly pendingPaisa: number;
  readonly outstandingPaisa: number;
  readonly status: PaymentStatus;
}

export interface MemberReportDto {
  readonly month: string;
  readonly rows: readonly MemberReportRowDto[];
  readonly expectedTotalPaisa: number;
  readonly verifiedTotalPaisa: number;
  readonly pendingTotalPaisa: number;
  readonly outstandingTotalPaisa: number;
}

export interface AnnualMonthRowDto {
  readonly month: string;
  readonly contributionsPaisa: number;
  readonly interestPaisa: number;
  readonly expensesPaisa: number;
  readonly withdrawalsPaisa: number;
  readonly netPaisa: number;
  readonly closingPaisa: number;
}

export interface AnnualReportDto {
  readonly year: number;
  readonly months: readonly AnnualMonthRowDto[];
  readonly contributionsPaisa: number;
  readonly interestPaisa: number;
  readonly expensesPaisa: number;
  readonly withdrawalsPaisa: number;
  readonly netPaisa: number;
  readonly closingPaisa: number;
}

export interface OutflowRowDto {
  readonly id: string;
  readonly title: string;
  readonly date: string;
  readonly amountPaisa: number;
  readonly isReversed: boolean;
  readonly isReversal: boolean;
}

export interface OutflowMonthTotalDto {
  readonly month: string;
  readonly totalPaisa: number;
}

export interface OutflowReportDto {
  readonly year: number;
  readonly kind: ActivityKind;
  readonly rows: readonly OutflowRowDto[];
  readonly totalPaisa: number;
  readonly monthTotals: readonly OutflowMonthTotalDto[];
}

function formatWallClockMonth(wc: WallClock): string {
  const y = wc.y;
  const m = String(wc.m).padStart(2, '0');
  return `${y}-${m}`;
}

function formatWallClockDate(wc: WallClock): string {
  const y = wc.y;
  const m = String(wc.m).padStart(2, '0');
  const d = String(wc.d).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseMonthString(monthStr: string): { y: number; m: number } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(monthStr);
  if (!match) {
    throw new HttpError(
      400,
      'invalid_request',
      'Month parameter must be in YYYY-MM format',
    );
  }
  return { y: Number(match[1]), m: Number(match[2]) };
}

function getSelectableMonthsList(
  earliestWc: WallClock,
  anchorWc: WallClock,
): string[] {
  const list: string[] = [];
  let cursor = monthStart(earliestWc);
  const end = monthStart(anchorWc);

  while (!isBefore(end, cursor)) {
    list.push(formatWallClockMonth(cursor));
    cursor = nextMonthStart(cursor);
  }
  return list;
}

/**
 * Returns selectable report months and years for a group.
 */
export async function getReportMonths(
  prisma: PrismaClient,
  groupId: string,
  now?: Date,
): Promise<ReportMonthsDto> {
  const snapshot: GroupSnapshot = await loadGroupSnapshot(prisma, groupId, now);

  const earliestMonth = monthStart(snapshot.group.createdAtWallClock);
  const anchorMonth = monthStart(snapshot.nowWallClock);

  const selectableMonths = getSelectableMonthsList(earliestMonth, anchorMonth);
  const yearSet = new Set<number>();
  for (const mStr of selectableMonths) {
    yearSet.add(Number(mStr.slice(0, 4)));
  }
  const selectableYears = Array.from(yearSet).sort((a, b) => a - b);

  return {
    earliestMonth: formatWallClockMonth(earliestMonth),
    anchorMonth: formatWallClockMonth(anchorMonth),
    selectableMonths,
    selectableYears,
  };
}

/**
 * Returns the monthly report for a group in a specific month.
 */
export async function getMonthlyReport(
  prisma: PrismaClient,
  params: {
    readonly groupId: string;
    readonly monthStr: string;
    readonly now?: Date | undefined;
  },
): Promise<MonthlyReportDto> {
  const { groupId, monthStr, now } = params;
  const snapshot: GroupSnapshot = await loadGroupSnapshot(prisma, groupId, now);

  const { y, m } = parseMonthString(monthStr);
  const requestedMonthWc = createWallClock(y, m, 1);

  const earliestMonth = monthStart(snapshot.group.createdAtWallClock);
  const anchorMonth = monthStart(snapshot.nowWallClock);

  if (
    isBefore(requestedMonthWc, earliestMonth) ||
    isBefore(anchorMonth, requestedMonthWc)
  ) {
    throw new HttpError(400, 'report_range_invalid');
  }

  const report = buildMonthlyReport({
    lines: snapshot.ledgerLines,
    members: snapshot.reportMembers,
    expectedPerMember: paisa(snapshot.group.expectedPaisa),
    month: requestedMonthWc,
    anchorMonth: snapshot.group.createdAtWallClock,
  });

  return {
    month: formatWallClockMonth(report.month),
    openingPaisa: report.openingPaisa,
    contributionsPaisa: report.contributionsPaisa,
    interestPaisa: report.interestPaisa,
    expensesPaisa: report.expensesPaisa,
    withdrawalsPaisa: report.withdrawalsPaisa,
    closingPaisa: report.closingPaisa,
    pendingPaisa: report.pendingPaisa,
    obligatedCount: report.obligatedCount,
    verifiedCount: report.verifiedCount,
    expectedTotalPaisa: report.expectedTotalPaisa,
    outstandingPaisa: report.outstandingPaisa,
  };
}

/**
 * Returns member-wise contribution obligations for a specific month.
 * Plain members see other members' pending amounts masked to 0.
 */
export async function getMemberReport(
  prisma: PrismaClient,
  params: {
    readonly groupId: string;
    readonly monthStr: string;
    readonly viewerIsTreasurer: boolean;
    readonly viewerIsOwner: boolean;
    readonly viewerMemberId: string;
    readonly now?: Date | undefined;
  },
): Promise<MemberReportDto> {
  const {
    groupId,
    monthStr,
    viewerIsTreasurer,
    viewerIsOwner,
    viewerMemberId,
    now,
  } = params;
  const snapshot: GroupSnapshot = await loadGroupSnapshot(prisma, groupId, now);

  const { y, m } = parseMonthString(monthStr);
  const requestedMonthWc = createWallClock(y, m, 1);

  const earliestMonth = monthStart(snapshot.group.createdAtWallClock);
  const anchorMonth = monthStart(snapshot.nowWallClock);

  if (
    isBefore(requestedMonthWc, earliestMonth) ||
    isBefore(anchorMonth, requestedMonthWc)
  ) {
    throw new HttpError(400, 'report_range_invalid');
  }

  const report = buildMemberReport({
    lines: snapshot.ledgerLines,
    members: snapshot.reportMembers,
    expectedPerMember: paisa(snapshot.group.expectedPaisa),
    month: requestedMonthWc,
    anchorMonth: snapshot.group.createdAtWallClock,
  });

  const canSeeOtherPending = viewerIsTreasurer || viewerIsOwner;

  let viewerPendingTotal = ZERO_PAISA;
  const rows: MemberReportRowDto[] = report.rows.map((row) => {
    const isSelf = row.memberId === viewerMemberId;
    let pendingPaisa = row.pendingPaisa;

    if (!canSeeOtherPending && !isSelf) {
      pendingPaisa = ZERO_PAISA;
    }

    if (isSelf) {
      viewerPendingTotal = row.pendingPaisa;
    }

    return {
      memberId: row.memberId,
      name: row.name,
      expectedPaisa: row.expectedPaisa,
      verifiedPaisa: row.verifiedPaisa,
      pendingPaisa,
      outstandingPaisa: row.outstandingPaisa,
      status: row.status,
    };
  });

  const pendingTotalPaisa = canSeeOtherPending
    ? report.pendingTotalPaisa
    : viewerPendingTotal;

  return {
    month: formatWallClockMonth(report.month),
    rows,
    expectedTotalPaisa: report.expectedTotalPaisa,
    verifiedTotalPaisa: report.verifiedTotalPaisa,
    pendingTotalPaisa,
    outstandingTotalPaisa: report.outstandingTotalPaisa,
  };
}

/**
 * Returns annual report containing monthly breakdowns and year totals.
 */
export async function getAnnualReport(
  prisma: PrismaClient,
  params: {
    readonly groupId: string;
    readonly year: number;
    readonly now?: Date | undefined;
  },
): Promise<AnnualReportDto> {
  const { groupId, year, now } = params;
  const snapshot: GroupSnapshot = await loadGroupSnapshot(prisma, groupId, now);

  const earliestYear = snapshot.group.createdAtWallClock.y;
  const nowYear = snapshot.nowWallClock.y;

  if (year < earliestYear || year > nowYear) {
    throw new HttpError(400, 'report_range_invalid');
  }

  const lastMonth =
    year === nowYear ? snapshot.nowWallClock : createWallClock(year, 12, 1);

  const report = buildAnnualReport({
    lines: snapshot.ledgerLines,
    year,
    lastMonth,
  });

  const months: AnnualMonthRowDto[] = report.months.map((m) => ({
    month: formatWallClockMonth(m.month),
    contributionsPaisa: m.contributionsPaisa,
    interestPaisa: m.interestPaisa,
    expensesPaisa: m.expensesPaisa,
    withdrawalsPaisa: m.withdrawalsPaisa,
    netPaisa: m.netPaisa,
    closingPaisa: m.closingPaisa,
  }));

  return {
    year: report.year,
    months,
    contributionsPaisa: report.contributionsPaisa,
    interestPaisa: report.interestPaisa,
    expensesPaisa: report.expensesPaisa,
    withdrawalsPaisa: report.withdrawalsPaisa,
    netPaisa: report.netPaisa,
    closingPaisa: report.closingPaisa,
  };
}

/**
 * Returns outflow report for expenses or withdrawals.
 */
export async function getOutflowReport(
  prisma: PrismaClient,
  params: {
    readonly groupId: string;
    readonly year: number;
    readonly kind: ActivityKind;
    readonly now?: Date | undefined;
  },
): Promise<OutflowReportDto> {
  const { groupId, year, kind, now } = params;

  if (kind !== 'expense' && kind !== 'withdrawal') {
    throw new HttpError(400, 'report_range_invalid');
  }

  const snapshot: GroupSnapshot = await loadGroupSnapshot(prisma, groupId, now);

  const earliestYear = snapshot.group.createdAtWallClock.y;
  const nowYear = snapshot.nowWallClock.y;

  if (year < earliestYear || year > nowYear) {
    throw new HttpError(400, 'report_range_invalid');
  }

  const report = buildOutflowReport({
    lines: snapshot.ledgerLines,
    year,
    kind,
  });

  const rows: OutflowRowDto[] = report.rows.map((r) => {
    const id = r.id.startsWith('ledger:') ? r.id : `ledger:${r.id}`;
    return {
      id,
      title: r.title,
      date: formatWallClockDate(r.date),
      amountPaisa: r.amountPaisa,
      isReversed: r.isReversed,
      isReversal: r.isReversal,
    };
  });

  const monthTotals: OutflowMonthTotalDto[] = report.monthTotals.map((mt) => ({
    month: formatWallClockMonth(mt.month),
    totalPaisa: mt.totalPaisa,
  }));

  return {
    year: report.year,
    kind: report.kind,
    rows,
    totalPaisa: report.totalPaisa,
    monthTotals,
  };
}
