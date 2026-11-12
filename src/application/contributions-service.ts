import type { PrismaClient } from '@prisma/client';
import { dueDateFor } from '../domain/due-dates.js';
import type { PaymentStatus } from '../domain/enums.js';
import { monthStart, nextMonthStart } from '../domain/month-math.js';
import { deriveObligationStatus } from '../domain/obligation-status.js';
import { effectivePeriodMonth } from '../domain/types.js';
import {
  compareWallClock,
  isAfter,
  isBefore,
  type WallClock,
} from '../domain/wall-clock.js';
import { HttpError } from '../http/errors.js';
import {
  mapLedgerEntryRow,
  mapSubmissionToLedgerEntry,
  sortBySeqAsc,
  type MappedLedgerEntry,
} from '../infrastructure/db/mappers.js';
import {
  nptWallClockToUtcInstant,
  utcInstantToNptWallClock,
} from '../infrastructure/time/npt.js';

export interface ContributionPeriodSummaryDto {
  readonly id: string;
  readonly month: string;
  readonly dueDate: string;
  readonly expectedTotalPaisa: number;
  readonly verifiedReceivedPaisa: number;
  readonly pendingTotalPaisa: number;
  readonly obligatedCount: number;
  readonly verifiedObligationCount: number;
  readonly isCurrent: boolean;
  readonly aggregateStatus: PaymentStatus;
}

export interface ContributionObligationDto {
  readonly memberId: string;
  readonly memberName: string;
  readonly isCurrentUser: boolean;
  readonly expectedPaisa: number;
  readonly paidPaisa: number;
  readonly status: PaymentStatus;
  readonly recordedAt: string | null;
}

export interface ContributionPeriodDetailDto {
  readonly summary: ContributionPeriodSummaryDto;
  readonly obligations: ContributionObligationDto[];
}

function calculateAggregateStatus(
  statuses: readonly PaymentStatus[],
): PaymentStatus {
  if (statuses.length === 0) return 'notSubmitted';
  if (statuses.every((s) => s === 'verified')) return 'verified';
  if (statuses.some((s) => s === 'overdue')) return 'overdue';
  if (statuses.some((s) => s === 'pendingVerification'))
    return 'pendingVerification';
  if (statuses.some((s) => s === 'rejected')) return 'rejected';
  return 'notSubmitted';
}

function formatPeriodId(month: WallClock): string {
  return `${month.y.toString().padStart(4, '0')}-${month.m.toString().padStart(2, '0')}`;
}

export class ContributionsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock?: (() => Date) | undefined,
  ) {}

  private async loadGroupAndEntries(groupId: string) {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: {
        memberships: {
          include: {
            user: { select: { displayName: true } },
          },
        },
      },
    });

    if (!group) {
      throw new HttpError(404, 'group_not_found');
    }

    const [ledgerRows, submissionRows] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where: { groupId },
        orderBy: { seq: 'asc' },
      }),
      this.prisma.paymentSubmission.findMany({
        where: { groupId, postedLedgerEntryId: null },
        orderBy: { seq: 'asc' },
      }),
    ]);

    const mappedLedger = ledgerRows.map(mapLedgerEntryRow);
    const mappedSubmissions = submissionRows.map(mapSubmissionToLedgerEntry);
    const allEntries: MappedLedgerEntry[] = sortBySeqAsc([
      ...mappedLedger,
      ...mappedSubmissions,
    ]);

    return { group, allEntries };
  }

  private calculatePeriodMonths(
    groupCreatedAt: Date,
    allEntries: readonly MappedLedgerEntry[],
    anchorPeriodStart: WallClock,
  ): WallClock[] {
    const groupCreatedWallClock = utcInstantToNptWallClock(groupCreatedAt);
    let earliest = monthStart(groupCreatedWallClock);

    if (isBefore(anchorPeriodStart, earliest)) {
      earliest = anchorPeriodStart;
    }

    for (const entry of allEntries) {
      const entryMonth =
        entry.kind === 'contribution'
          ? effectivePeriodMonth(entry)
          : monthStart(entry.occurredAt);
      if (isBefore(entryMonth, earliest)) {
        earliest = entryMonth;
      }
    }

    const months: WallClock[] = [];
    let cursor = earliest;
    while (!isAfter(cursor, anchorPeriodStart)) {
      months.push(cursor);
      cursor = nextMonthStart(cursor);
    }

    return months;
  }

  private buildPeriodDetail(
    group: {
      id: string;
      expectedPaisa: bigint;
      dueDay: number;
      memberships: {
        id: string;
        userId: string;
        joinedAt: Date;
        leftAt: Date | null;
        user: { displayName: string };
      }[];
    },
    allEntries: readonly MappedLedgerEntry[],
    month: WallClock,
    anchorPeriodStart: WallClock,
    viewerUserId: string,
  ): ContributionPeriodDetailDto {
    const periodEnd = nextMonthStart(month);
    const periodId = formatPeriodId(month);
    const expectedPaisa = Number(group.expectedPaisa);

    const obligatedMembers = group.memberships.filter((m) => {
      const joinedWallClock = utcInstantToNptWallClock(m.joinedAt);
      const leftWallClock = m.leftAt
        ? utcInstantToNptWallClock(m.leftAt)
        : null;
      return (
        isBefore(joinedWallClock, periodEnd) &&
        (leftWallClock === null || !isBefore(leftWallClock, periodEnd))
      );
    });

    const obligations: ContributionObligationDto[] = obligatedMembers.map(
      (m) => {
        const status = deriveObligationStatus({
          entries: allEntries,
          memberId: m.id,
          periodStart: month,
          anchorPeriodStart,
        });

        const memberMonthContributions = allEntries.filter((e) => {
          if (e.memberId !== m.id || e.kind !== 'contribution') return false;
          const eMonth = effectivePeriodMonth(e);
          return !isBefore(eMonth, month) && isBefore(eMonth, periodEnd);
        });

        memberMonthContributions.sort((a, b) =>
          compareWallClock(b.occurredAt, a.occurredAt),
        );

        const latest = memberMonthContributions[0];
        const hasPaidAmount =
          status === 'verified' || status === 'pendingVerification';
        const paidPaisa =
          hasPaidAmount && latest ? (latest.magnitudePaisa as number) : 0;
        const recordedAt = latest
          ? nptWallClockToUtcInstant(latest.occurredAt).toISOString()
          : null;

        return {
          memberId: m.id,
          memberName: m.user.displayName,
          isCurrentUser: m.userId === viewerUserId,
          expectedPaisa,
          paidPaisa,
          status,
          recordedAt,
        };
      },
    );

    let verifiedReceivedPaisa = 0;
    let pendingTotalPaisa = 0;

    for (const entry of allEntries) {
      if (entry.kind !== 'contribution') continue;
      const eMonth = effectivePeriodMonth(entry);
      if (isBefore(eMonth, month) || !isBefore(eMonth, periodEnd)) continue;

      if (entry.status === 'verified') {
        verifiedReceivedPaisa += entry.magnitudePaisa as number;
      } else if (entry.status === 'pendingVerification') {
        pendingTotalPaisa += entry.magnitudePaisa as number;
      }
    }

    const dueDateWallClock = dueDateFor(month.y, month.m, group.dueDay);
    const dueDate = nptWallClockToUtcInstant(dueDateWallClock).toISOString();
    const monthIso = nptWallClockToUtcInstant(month).toISOString();
    const isCurrent =
      month.y === anchorPeriodStart.y && month.m === anchorPeriodStart.m;
    const aggregateStatus = calculateAggregateStatus(
      obligations.map((o) => o.status),
    );

    const summary: ContributionPeriodSummaryDto = {
      id: periodId,
      month: monthIso,
      dueDate,
      expectedTotalPaisa: obligations.length * expectedPaisa,
      verifiedReceivedPaisa,
      pendingTotalPaisa,
      obligatedCount: obligations.length,
      verifiedObligationCount: obligations.filter(
        (o) => o.status === 'verified',
      ).length,
      isCurrent,
      aggregateStatus,
    };

    return { summary, obligations };
  }

  async listPeriods(
    groupId: string,
    viewerUserId: string,
  ): Promise<ContributionPeriodSummaryDto[]> {
    const { group, allEntries } = await this.loadGroupAndEntries(groupId);

    const now = this.clock ? this.clock() : new Date();
    const anchorPeriodStart = monthStart(utcInstantToNptWallClock(now));

    const months = this.calculatePeriodMonths(
      group.createdAt,
      allEntries,
      anchorPeriodStart,
    );

    // Newest month first
    const reversedMonths = [...months].reverse();

    return reversedMonths.map((m) => {
      const detail = this.buildPeriodDetail(
        group,
        allEntries,
        m,
        anchorPeriodStart,
        viewerUserId,
      );
      return detail.summary;
    });
  }

  async getPeriodDetail(
    groupId: string,
    periodId: string,
    viewerUserId: string,
  ): Promise<ContributionPeriodDetailDto> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodId)) {
      throw new HttpError(404, 'period_not_found');
    }

    const year = Number(periodId.substring(0, 4));
    const monthNumber = Number(periodId.substring(5, 7));

    const { group, allEntries } = await this.loadGroupAndEntries(groupId);

    const now = this.clock ? this.clock() : new Date();
    const anchorPeriodStart = monthStart(utcInstantToNptWallClock(now));

    const months = this.calculatePeriodMonths(
      group.createdAt,
      allEntries,
      anchorPeriodStart,
    );

    const targetMonth = months.find((m) => m.y === year && m.m === monthNumber);

    if (!targetMonth) {
      throw new HttpError(404, 'period_not_found');
    }

    return this.buildPeriodDetail(
      group,
      allEntries,
      targetMonth,
      anchorPeriodStart,
      viewerUserId,
    );
  }
}
