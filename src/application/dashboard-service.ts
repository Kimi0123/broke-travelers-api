import type { PrismaClient } from '@prisma/client';
import type { ActivityKind, PaymentStatus } from '../domain/enums.js';
import { dueDateFor } from '../domain/due-dates.js';
import { signedPaisa, verifiedBalancePaisa } from '../domain/ledger-math.js';
import { monthStart, nextMonthStart } from '../domain/month-math.js';
import { deriveObligationStatus } from '../domain/obligation-status.js';
import type { MappedLedgerEntry } from '../infrastructure/db/mappers.js';
import {
  addMonths,
  compareWallClock,
  isBefore,
  isEqual,
  type WallClock,
} from '../domain/wall-clock.js';
import { formatMonthName } from './formatters.js';
import { loadGroupSnapshot, type GroupSnapshot } from './read-models.js';

export interface DashboardMemberStatusDto {
  readonly memberId: string;
  readonly displayName: string;
  readonly expectedAmountPaisa: number;
  readonly status: PaymentStatus;
  readonly isCurrentUser: boolean;
}

export interface DashboardUpcomingDeadlineDto {
  readonly title: string;
  readonly dueDate: string; // YYYY-MM-DD
  readonly outstandingMemberCount: number;
}

export interface DashboardBalanceHistoryPointDto {
  readonly month: string; // YYYY-MM
  readonly verifiedBalanceAtMonthEndPaisa: number;
  readonly isCurrentMonth: boolean;
}

export interface DashboardActivityItemDto {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly title: string;
  readonly occurredAt: string; // ISO-8601
  readonly amountPaisa: number;
  readonly status: PaymentStatus;
  readonly signedAmountPaisa: number;
}

export interface DashboardSummaryDto {
  readonly groupName: string;
  readonly periodStart: string; // YYYY-MM-01
  readonly dueDate: string; // YYYY-MM-DD
  readonly verifiedBalancePaisa: number;
  readonly pendingAmountPaisa: number;
  readonly monthlyTargetPaisa: number;
  readonly verifiedThisPeriodPaisa: number;
  readonly remainingToTargetPaisa: number;
  readonly verifiedMemberCount: number;
  readonly totalMemberCount: number;
  readonly members: readonly DashboardMemberStatusDto[];
  readonly recentActivity: readonly DashboardActivityItemDto[];
  readonly upcomingDeadlines: readonly DashboardUpcomingDeadlineDto[];
  readonly balanceHistory: readonly DashboardBalanceHistoryPointDto[];
  readonly openApprovalsCount: number;
  readonly needsYourVote: boolean;
  readonly lastReconciledAt: string | null;
  readonly lastReconciliationDifferencePaisa: number | null;
  readonly lastReconciliationStatus: 'matched' | 'mismatch' | null;
}

function formatWallClockDate(wc: WallClock): string {
  const y = wc.y;
  const m = String(wc.m).padStart(2, '0');
  const d = String(wc.d).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatWallClockMonth(wc: WallClock): string {
  const y = wc.y;
  const m = String(wc.m).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Derives the complete dashboard summary for a savings group from a single
 * consistent REPEATABLE READ snapshot.
 */
export async function getDashboardSummary(
  prisma: PrismaClient,
  params: {
    readonly groupId: string;
    readonly viewerUserId: string;
    readonly viewerMembershipId: string;
    readonly isTreasurer: boolean;
    readonly isOwner: boolean;
    readonly now?: Date | undefined;
  },
): Promise<DashboardSummaryDto> {
  const {
    groupId,
    viewerUserId,
    viewerMembershipId,
    isTreasurer,
    isOwner,
    now = new Date(),
  } = params;

  const snapshot: GroupSnapshot = await loadGroupSnapshot(prisma, groupId, now);

  const currentPeriodStartWc = monthStart(snapshot.nowWallClock);
  const anchorPeriodStartWc = snapshot.group.createdAtWallClock;

  // 1. Members list with obligation status for current period
  const activeMembers = snapshot.activeMembers;
  const memberStatuses: DashboardMemberStatusDto[] = activeMembers.map((m) => {
    const status = deriveObligationStatus({
      entries: snapshot.allDomainEntries,
      memberId: m.id,
      periodStart: currentPeriodStartWc,
      anchorPeriodStart: anchorPeriodStartWc,
    });
    const isCurrentUser =
      m.id === viewerMembershipId || m.userId === viewerUserId;
    const displayName = isCurrentUser
      ? `${m.displayName} (you)`
      : m.displayName;

    return {
      memberId: m.id,
      displayName,
      expectedAmountPaisa: m.expectedPaisa,
      status,
      isCurrentUser,
    };
  });

  // 2. Financial summaries derived from ledger and submissions
  const verifiedBalance = verifiedBalancePaisa(snapshot.ledgerEntries);

  // Pending amount: plain members see only their own pending; treasurers/owner see all
  let pendingAmount = 0;
  for (const sub of snapshot.paymentSubmissions) {
    if (sub.status === 'pending' && sub.postedLedgerEntryId === null) {
      if (isTreasurer || isOwner || sub.memberId === viewerMembershipId) {
        pendingAmount += sub.amountPaisa;
      }
    }
  }

  // Monthly target: sum of expected amount of all active members
  const monthlyTarget = activeMembers.reduce(
    (acc, m) => acc + m.expectedPaisa,
    0,
  );

  // Verified this period: verified contributions in active period by active members
  const activeMemberIds = new Set(activeMembers.map((m) => m.id));
  let verifiedThisPeriod = 0;
  for (const entry of snapshot.ledgerEntries) {
    if (
      entry.status === 'verified' &&
      entry.kind === 'contribution' &&
      entry.memberId != null &&
      activeMemberIds.has(entry.memberId)
    ) {
      const period = entry.periodMonth ?? monthStart(entry.occurredAt);
      if (isEqual(period, currentPeriodStartWc)) {
        verifiedThisPeriod += entry.magnitudePaisa;
      }
    }
  }

  const remainingToTarget = Math.max(0, monthlyTarget - verifiedThisPeriod);

  const verifiedMemberCount = memberStatuses.filter(
    (m) => m.status === 'verified',
  ).length;
  const totalMemberCount = activeMembers.length;

  // 3. Recent activity: 5 newest items descending
  // Includes verified ledger entries, pending submissions (for all), and viewer's own rejected submissions.
  // Other members' rejected submissions are strictly omitted.
  interface CandidateActivity {
    readonly id: string;
    readonly kind: ActivityKind;
    readonly title: string;
    readonly occurredAtDate: Date;
    readonly occurredAt: string;
    readonly amountPaisa: number;
    readonly status: PaymentStatus;
    readonly signedAmountPaisa: number;
  }

  const candidates: CandidateActivity[] = [];

  for (const entry of snapshot.ledgerEntries) {
    candidates.push({
      id: `ledger:${entry.id}`,
      kind: entry.kind,
      title: entry.title,
      occurredAtDate: entry.occurredAtDate,
      occurredAt: entry.occurredAtDate.toISOString(),
      amountPaisa: entry.magnitudePaisa,
      status: entry.status,
      signedAmountPaisa: signedPaisa(entry),
    });
  }

  for (const sub of snapshot.paymentSubmissions) {
    if (sub.postedLedgerEntryId === null) {
      // Pending submissions are visible to all members
      // Rejected submissions are ONLY visible to the submitter themself
      if (sub.status === 'pending') {
        const member = snapshot.members.find((m) => m.id === sub.memberId);
        const name = member?.displayName ?? 'Member';
        candidates.push({
          id: `submission:${sub.id}`,
          kind: 'contribution',
          title: `${name}'s contribution`,
          occurredAtDate: sub.submittedAtDate,
          occurredAt: sub.submittedAtDate.toISOString(),
          amountPaisa: sub.amountPaisa,
          status: 'pendingVerification',
          signedAmountPaisa: sub.amountPaisa,
        });
      } else if (
        sub.status === 'rejected' &&
        sub.memberId === viewerMembershipId
      ) {
        const member = snapshot.members.find((m) => m.id === sub.memberId);
        const name = member?.displayName ?? 'Member';
        candidates.push({
          id: `submission:${sub.id}`,
          kind: 'contribution',
          title: `${name}'s contribution`,
          occurredAtDate: sub.submittedAtDate,
          occurredAt: sub.submittedAtDate.toISOString(),
          amountPaisa: sub.amountPaisa,
          status: 'rejected',
          signedAmountPaisa: sub.amountPaisa,
        });
      }
    }
  }

  // Sort newest first; tie break by id descending
  candidates.sort((a, b) => {
    const cmp = b.occurredAtDate.getTime() - a.occurredAtDate.getTime();
    if (cmp !== 0) return cmp;
    return b.id.localeCompare(a.id);
  });

  const recentActivity: DashboardActivityItemDto[] = candidates
    .slice(0, 5)
    .map((c) => ({
      id: c.id,
      kind: c.kind,
      title: c.title,
      occurredAt: c.occurredAt,
      amountPaisa: c.amountPaisa,
      status: c.status,
      signedAmountPaisa: c.signedAmountPaisa,
    }));

  // 4. Upcoming Deadlines (2 items: current period + next period)
  const currentPeriodDate = new Date(
    Date.UTC(currentPeriodStartWc.y, currentPeriodStartWc.m - 1, 1),
  );
  const nextPeriodStartWc = addMonths(currentPeriodStartWc, 1);
  const nextPeriodDate = new Date(
    Date.UTC(nextPeriodStartWc.y, nextPeriodStartWc.m - 1, 1),
  );

  const curDueDay = dueDateFor(
    currentPeriodStartWc.y,
    currentPeriodStartWc.m,
    snapshot.group.dueDay,
  );
  const nextDueDay = dueDateFor(
    nextPeriodStartWc.y,
    nextPeriodStartWc.m,
    snapshot.group.dueDay,
  );

  const curOutstandingCount = memberStatuses.filter(
    (m) => m.status !== 'verified',
  ).length;

  const upcomingDeadlines: DashboardUpcomingDeadlineDto[] = [
    {
      title: `${formatMonthName(currentPeriodDate)} contributions`,
      dueDate: formatWallClockDate(curDueDay),
      outstandingMemberCount: curOutstandingCount,
    },
    {
      title: `${formatMonthName(nextPeriodDate)} contributions`,
      dueDate: formatWallClockDate(nextDueDay),
      outstandingMemberCount: totalMemberCount,
    },
  ];

  // 5. Balance History: month-end cumulative verified balance from earliest entry
  const balanceHistory = buildBalanceHistory(
    snapshot.ledgerEntries,
    currentPeriodStartWc,
  );

  // 6. Approvals summary
  // Expired if open and createdAt older than 7 days
  const nowMs = snapshot.now.getTime();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  const openNonExpiredApprovals = snapshot.approvals.filter((a) => {
    const isExpired =
      a.status === 'open' && nowMs > a.createdAt.getTime() + SEVEN_DAYS_MS;
    return a.status === 'open' && !isExpired;
  });

  const openApprovalsCount = openNonExpiredApprovals.length;
  const needsYourVote = openNonExpiredApprovals.some((a) => {
    const isEligible = a.eligibleMemberIds.includes(viewerMembershipId);
    const hasVoted = a.votes.some((v) => v.memberId === viewerMembershipId);
    return isEligible && !hasVoted;
  });

  // 7. Latest reconciliation
  const latestRecon = snapshot.reconciliations[0] ?? null;

  return {
    groupName: snapshot.group.name,
    periodStart: formatWallClockDate(currentPeriodStartWc),
    dueDate: formatWallClockDate(curDueDay),
    verifiedBalancePaisa: verifiedBalance,
    pendingAmountPaisa: pendingAmount,
    monthlyTargetPaisa: monthlyTarget,
    verifiedThisPeriodPaisa: verifiedThisPeriod,
    remainingToTargetPaisa: remainingToTarget,
    verifiedMemberCount,
    totalMemberCount,
    members: memberStatuses,
    recentActivity,
    upcomingDeadlines,
    balanceHistory,
    openApprovalsCount,
    needsYourVote,
    lastReconciledAt: latestRecon ? latestRecon.statementDateStr : null,
    lastReconciliationDifferencePaisa: latestRecon
      ? latestRecon.differencePaisa
      : null,
    lastReconciliationStatus: latestRecon ? latestRecon.status : null,
  };
}

/**
 * Builds month-end cumulative balance history from verified ledger entries.
 * Returns an empty array if ledger is empty.
 */
function buildBalanceHistory(
  ledgerEntries: readonly MappedLedgerEntry[],
  currentPeriodStartWc: WallClock,
): DashboardBalanceHistoryPointDto[] {
  if (ledgerEntries.length === 0) return [];

  // Find earliest month among all ledger entries
  let earliest = ledgerEntries[0]!.occurredAt;
  for (const e of ledgerEntries) {
    if (isBefore(e.occurredAt, earliest)) {
      earliest = e.occurredAt;
    }
  }

  const startMonth = monthStart(earliest);
  const endMonth = currentPeriodStartWc;

  // Build list of months from startMonth to endMonth (inclusive)
  const months: WallClock[] = [];
  let cursor = startMonth;
  while (!isBefore(endMonth, cursor)) {
    months.push(cursor);
    cursor = nextMonthStart(cursor);
  }

  // Sorted verified entries ascending by occurredAt
  const verifiedSorted = ledgerEntries
    .filter((e) => e.status === 'verified')
    .slice()
    .sort((a, b) => compareWallClock(a.occurredAt, b.occurredAt));

  let cumulativePaisa = 0;
  let entryIdx = 0;
  const history: DashboardBalanceHistoryPointDto[] = [];

  for (const m of months) {
    const nextStart = nextMonthStart(m);

    while (
      entryIdx < verifiedSorted.length &&
      isBefore(verifiedSorted[entryIdx]!.occurredAt, nextStart)
    ) {
      cumulativePaisa += signedPaisa(verifiedSorted[entryIdx]!);
      entryIdx++;
    }

    history.push({
      month: formatWallClockMonth(m),
      verifiedBalanceAtMonthEndPaisa: cumulativePaisa,
      isCurrentMonth: isEqual(m, currentPeriodStartWc),
    });
  }

  return history;
}
