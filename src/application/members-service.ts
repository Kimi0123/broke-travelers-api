import type { PrismaClient } from '@prisma/client';
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
import { withTransaction } from '../infrastructure/db/client.js';
import { generateId } from '../infrastructure/db/ids.js';
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

export interface GroupMemberResponse {
  readonly id: string;
  readonly displayName: string;
  readonly roles: string[];
  readonly joinedAt: string;
  readonly isCurrentUser: boolean;
  readonly currentPeriodStatus: PaymentStatus;
}

export interface MemberContributionHistoryDto {
  readonly month: string;
  readonly expectedPaisa: number;
  readonly paidPaisa: number;
  readonly status: PaymentStatus;
  readonly recordedAt: string | null;
}

export interface MemberDetailResponseDto {
  readonly member: GroupMemberResponse;
  readonly verifiedTotalPaisa: number;
  readonly pendingTotalPaisa: number;
  readonly verifiedMonthCount: number;
  readonly history: MemberContributionHistoryDto[];
}

export interface UpdateMemberRoleInput {
  readonly isTreasurer: boolean;
}

export interface MembersServiceDeps {
  readonly prisma: PrismaClient;
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
}

function computeRoles(isOwner: boolean, isTreasurer: boolean): string[] {
  const roles: string[] = [];
  if (isOwner) roles.push('owner');
  if (isTreasurer) roles.push('treasurer');
  if (roles.length === 0) roles.push('member');
  return roles;
}

export class MembersService {
  private readonly prisma: PrismaClient;
  private readonly clock?: (() => Date) | undefined;
  private readonly idGenerator?: (() => string) | undefined;

  constructor(deps: MembersServiceDeps) {
    this.prisma = deps.prisma;
    this.clock = deps.clock;
    this.idGenerator = deps.idGenerator;
  }

  private async loadAllEntries(groupId: string): Promise<MappedLedgerEntry[]> {
    const ledgerRows = await this.prisma.ledgerEntry.findMany({
      where: { groupId },
      orderBy: { seq: 'asc' },
    });
    const submissionRows = await this.prisma.paymentSubmission.findMany({
      where: { groupId, postedLedgerEntryId: null },
      orderBy: { seq: 'asc' },
    });

    const mappedLedger = ledgerRows.map(mapLedgerEntryRow);
    const mappedSubmissions = submissionRows.map(mapSubmissionToLedgerEntry);
    return sortBySeqAsc([...mappedLedger, ...mappedSubmissions]);
  }

  async listMembers(
    groupId: string,
    viewerUserId: string,
  ): Promise<GroupMemberResponse[]> {
    const viewerMembership = await this.prisma.groupMembership.findFirst({
      where: {
        groupId,
        userId: viewerUserId,
        leftAt: null,
      },
    });

    if (!viewerMembership) {
      throw new HttpError(404, 'group_not_found');
    }

    const activeMemberships = await this.prisma.groupMembership.findMany({
      where: {
        groupId,
        leftAt: null,
      },
      include: {
        user: true,
      },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    });

    const now = this.clock ? this.clock() : new Date();
    const nptNow = utcInstantToNptWallClock(now);
    const currentPeriodStart = monthStart(nptNow);

    const entries = await this.loadAllEntries(groupId);

    return activeMemberships.map((m) => {
      const roles = computeRoles(m.isOwner, m.isTreasurer);
      const status = deriveObligationStatus({
        entries,
        memberId: m.id,
        periodStart: currentPeriodStart,
        anchorPeriodStart: currentPeriodStart,
      });

      return {
        id: m.id,
        displayName: m.user.displayName,
        roles,
        joinedAt: m.joinedAt.toISOString(),
        isCurrentUser: m.userId === viewerUserId,
        currentPeriodStatus: status,
      };
    });
  }

  async getMemberDetail(
    groupId: string,
    memberId: string,
    viewerUserId: string,
  ): Promise<MemberDetailResponseDto> {
    const viewerMembership = await this.prisma.groupMembership.findFirst({
      where: {
        groupId,
        userId: viewerUserId,
        leftAt: null,
      },
    });

    if (!viewerMembership) {
      throw new HttpError(404, 'group_not_found');
    }

    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
    });
    if (!group) {
      throw new HttpError(404, 'group_not_found');
    }

    const target = await this.prisma.groupMembership.findFirst({
      where: {
        id: memberId,
        groupId,
        leftAt: null,
      },
      include: {
        user: true,
      },
    });

    if (!target) {
      throw new HttpError(404, 'member_not_found');
    }

    const allEntries = await this.loadAllEntries(groupId);

    const now = this.clock ? this.clock() : new Date();
    const nowWallClock = utcInstantToNptWallClock(now);
    const anchorPeriodStart = monthStart(nowWallClock);

    const currentPeriodStatus = deriveObligationStatus({
      entries: allEntries,
      memberId: target.id,
      periodStart: anchorPeriodStart,
      anchorPeriodStart,
    });

    // Determine earliest calendar month
    let earliest = monthStart(utcInstantToNptWallClock(group.createdAt));
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

    // Build calendar months from earliest through anchorPeriodStart
    const months: WallClock[] = [];
    let cursor = earliest;
    while (!isAfter(cursor, anchorPeriodStart)) {
      months.push(cursor);
      cursor = nextMonthStart(cursor);
    }

    // Member contributions from all entries
    const memberContributions = allEntries.filter(
      (e) => e.memberId === target.id && e.kind === 'contribution',
    );

    const isSelf = target.userId === viewerUserId;
    const isViewerTreasurer = viewerMembership.isTreasurer;
    const canSeePending = isSelf || isViewerTreasurer;

    const expectedPaisa = Number(group.expectedPaisa);

    // Build history newest month first
    const history: MemberContributionHistoryDto[] = [];
    for (let i = months.length - 1; i >= 0; i--) {
      const month = months[i]!;
      const periodEnd = nextMonthStart(month);

      const monthEntries = memberContributions.filter((e) => {
        const eMonth = effectivePeriodMonth(e);
        return !isBefore(eMonth, month) && isBefore(eMonth, periodEnd);
      });
      monthEntries.sort((a, b) => compareWallClock(b.occurredAt, a.occurredAt));

      const status = deriveObligationStatus({
        entries: allEntries,
        memberId: target.id,
        periodStart: month,
        anchorPeriodStart,
      });

      let paidPaisa = 0;
      let recordedAt: string | null = null;

      if (monthEntries.length > 0) {
        const latest = monthEntries[0]!;
        const isPaidStatus =
          status === 'verified' || status === 'pendingVerification';
        if (isPaidStatus) {
          if (status === 'pendingVerification') {
            paidPaisa = canSeePending ? latest.magnitudePaisa : 0;
          } else {
            paidPaisa = latest.magnitudePaisa;
          }
        }
        recordedAt = nptWallClockToUtcInstant(latest.occurredAt).toISOString();
      }

      history.push({
        month: nptWallClockToUtcInstant(month).toISOString(),
        expectedPaisa,
        paidPaisa,
        status,
        recordedAt,
      });
    }

    // Cumulative totals
    let verifiedTotalPaisa = 0;
    let pendingTotalPaisa = 0;
    for (const e of memberContributions) {
      if (e.status === 'verified') {
        verifiedTotalPaisa += e.magnitudePaisa;
      } else if (e.status === 'pendingVerification') {
        pendingTotalPaisa += e.magnitudePaisa;
      }
    }

    if (!canSeePending) {
      pendingTotalPaisa = 0;
    }

    const verifiedMonthCount = history.filter(
      (r) => r.status === 'verified',
    ).length;

    return {
      member: {
        id: target.id,
        displayName: target.user.displayName,
        roles: computeRoles(target.isOwner, target.isTreasurer),
        joinedAt: target.joinedAt.toISOString(),
        isCurrentUser: target.userId === viewerUserId,
        currentPeriodStatus,
      },
      verifiedTotalPaisa,
      pendingTotalPaisa,
      verifiedMonthCount,
      history,
    };
  }

  async updateMemberRole(
    groupId: string,
    memberId: string,
    actorUserId: string,
    input: UpdateMemberRoleInput,
  ): Promise<GroupMemberResponse> {
    const actorMembership = await this.prisma.groupMembership.findFirst({
      where: {
        groupId,
        userId: actorUserId,
        leftAt: null,
      },
    });

    if (!actorMembership) {
      throw new HttpError(404, 'group_not_found');
    }

    if (!actorMembership.isOwner) {
      throw new HttpError(403, 'forbidden');
    }

    const target = await this.prisma.groupMembership.findFirst({
      where: {
        id: memberId,
        groupId,
        leftAt: null,
      },
      include: {
        user: true,
      },
    });

    if (!target) {
      throw new HttpError(404, 'member_not_found');
    }

    if (target.isOwner) {
      throw new HttpError(409, 'cannot_remove_owner');
    }

    if (!input.isTreasurer && target.isTreasurer) {
      const otherTreasurersCount = await this.prisma.groupMembership.count({
        where: {
          groupId,
          leftAt: null,
          isTreasurer: true,
          id: { not: memberId },
        },
      });

      if (otherTreasurersCount === 0) {
        throw new HttpError(409, 'cannot_remove_last_treasurer');
      }
    }

    return withTransaction(this.prisma, async (tx) => {
      const updated = await tx.groupMembership.update({
        where: { id: memberId },
        data: { isTreasurer: input.isTreasurer },
        include: { user: true },
      });

      const now = this.clock ? this.clock() : new Date();
      const auditLogId = this.idGenerator ? this.idGenerator() : generateId();
      await tx.auditLog.create({
        data: {
          id: auditLogId,
          groupId,
          actorUserId,
          action: 'member_role_updated',
          field: `member:${memberId}:is_treasurer`,
          beforeValue: String(target.isTreasurer),
          afterValue: String(input.isTreasurer),
          createdAt: now,
        },
      });

      const nptNow = utcInstantToNptWallClock(now);
      const currentPeriodStart = monthStart(nptNow);

      const ledgerRows = await tx.ledgerEntry.findMany({
        where: { groupId },
        orderBy: { seq: 'asc' },
      });
      const submissionRows = await tx.paymentSubmission.findMany({
        where: { groupId, postedLedgerEntryId: null },
        orderBy: { seq: 'asc' },
      });
      const entries = sortBySeqAsc([
        ...ledgerRows.map(mapLedgerEntryRow),
        ...submissionRows.map(mapSubmissionToLedgerEntry),
      ]);
      const status = deriveObligationStatus({
        entries,
        memberId: updated.id,
        periodStart: currentPeriodStart,
        anchorPeriodStart: currentPeriodStart,
      });

      return {
        id: updated.id,
        displayName: updated.user.displayName,
        roles: computeRoles(updated.isOwner, updated.isTreasurer),
        joinedAt: updated.joinedAt.toISOString(),
        isCurrentUser: updated.userId === actorUserId,
        currentPeriodStatus: status,
      };
    });
  }

  async removeMember(
    groupId: string,
    memberId: string,
    actorUserId: string,
  ): Promise<void> {
    const actorMembership = await this.prisma.groupMembership.findFirst({
      where: {
        groupId,
        userId: actorUserId,
        leftAt: null,
      },
    });

    if (!actorMembership) {
      throw new HttpError(404, 'group_not_found');
    }

    if (!actorMembership.isOwner) {
      throw new HttpError(403, 'forbidden');
    }

    const target = await this.prisma.groupMembership.findFirst({
      where: {
        id: memberId,
        groupId,
        leftAt: null,
      },
    });

    if (!target) {
      throw new HttpError(404, 'member_not_found');
    }

    // Invariant 1: Cannot remove owner
    if (target.isOwner) {
      throw new HttpError(409, 'cannot_remove_owner');
    }

    // Invariant 2: Cannot remove member with pending payments
    const pendingCount = await this.prisma.paymentSubmission.count({
      where: {
        groupId,
        memberId,
        status: 'pending',
      },
    });

    if (pendingCount > 0) {
      throw new HttpError(409, 'member_has_pending_payments');
    }

    // Invariant 3: Cannot remove last treasurer
    if (target.isTreasurer) {
      const otherTreasurersCount = await this.prisma.groupMembership.count({
        where: {
          groupId,
          leftAt: null,
          isTreasurer: true,
          id: { not: memberId },
        },
      });

      if (otherTreasurersCount === 0) {
        throw new HttpError(409, 'cannot_remove_last_treasurer');
      }
    }

    // Soft remove: set leftAt to now and append audit log
    await withTransaction(this.prisma, async (tx) => {
      const now = this.clock ? this.clock() : new Date();

      await tx.groupMembership.update({
        where: { id: memberId },
        data: { leftAt: now },
      });

      const auditLogId = this.idGenerator ? this.idGenerator() : generateId();
      await tx.auditLog.create({
        data: {
          id: auditLogId,
          groupId,
          actorUserId,
          action: 'member_removed',
          field: `member:${memberId}:left_at`,
          beforeValue: null,
          afterValue: now.toISOString(),
          createdAt: now,
        },
      });
    });
  }
}
