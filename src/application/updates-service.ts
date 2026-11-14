import type { PrismaClient } from '@prisma/client';
import { dueDateFor } from '../domain/due-dates.js';
import { monthStart, nextMonthStart } from '../domain/month-math.js';
import { deriveObligationStatus } from '../domain/obligation-status.js';
import { isBefore, type WallClock } from '../domain/wall-clock.js';
import {
  formatDayMonth,
  formatDayMonthYear,
  formatMoneyPaisa,
  formatMonthName,
  formatMonthYear,
} from './formatters.js';
import { loadGroupSnapshot, type GroupSnapshot } from './read-models.js';

export const MAX_UPDATES_FEED_COUNT = 50;

export type UpdateKind =
  | 'announcement'
  | 'reminder'
  | 'paymentVerification'
  | 'approval'
  | 'reconciliation';

export type UpdateTargetDto =
  | { readonly type: 'payments' }
  | { readonly type: 'verifyPayments' }
  | { readonly type: 'approvalDetail'; readonly approvalId: string }
  | { readonly type: 'reconciliation' }
  | { readonly type: 'contributions' }
  | { readonly type: 'none' };

export interface UpdateItemDto {
  readonly id: string;
  readonly kind: UpdateKind;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string; // ISO-8601
  readonly isRead: boolean;
  readonly target: UpdateTargetDto;
}

interface RawFeedItem {
  readonly id: string;
  readonly kind: UpdateKind;
  readonly title: string;
  readonly body: string;
  readonly createdAtDate: Date;
  readonly target: UpdateTargetDto;
}

function rejectionReasonLabel(
  rejectionReason: string | null,
  rejectionNote: string | null,
): string {
  switch (rejectionReason) {
    case 'notReceived':
      return 'Payment not received';
    case 'wrongAmount':
      return 'Wrong amount';
    case 'referenceNotFound':
      return 'Reference not found';
    case 'other':
      return rejectionNote && rejectionNote.trim().length > 0
        ? rejectionNote.trim()
        : 'Other';
    default:
      return 'Payment could not be verified';
  }
}

function wallClockToUtcDate(wc: WallClock): Date {
  return new Date(Date.UTC(wc.y, wc.m - 1, wc.d, wc.h, wc.mi, wc.s, wc.ms));
}

/**
 * Derives the raw feed items for a given viewer and group snapshot.
 */
function deriveRawFeedItems(
  snapshot: GroupSnapshot,
  viewerMemberId: string,
  isTreasurer: boolean,
): RawFeedItem[] {
  const items: RawFeedItem[] = [];
  const nowMs = snapshot.now.getTime();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  // 1. Member's own payments (verified, rejected, pending)
  const viewerSubmissions = snapshot.paymentSubmissions.filter(
    (s) => s.memberId === viewerMemberId,
  );

  const processedEntryIds = new Set<string>();

  for (const sub of viewerSubmissions) {
    const periodLabel = formatMonthYear(sub.periodMonth);
    const amountStr = formatMoneyPaisa(sub.amountPaisa);

    if (sub.postedLedgerEntryId !== null) {
      processedEntryIds.add(sub.postedLedgerEntryId);
    }

    switch (sub.status) {
      case 'verified':
        items.push({
          id: `pay-${sub.id}-verified`,
          kind: 'paymentVerification',
          title: 'Payment verified',
          body: `Your ${amountStr} contribution for ${periodLabel} was verified.`,
          createdAtDate: sub.reviewedAtDate ?? sub.submittedAtDate,
          target: { type: 'payments' },
        });
        break;
      case 'rejected': {
        const reasonText = rejectionReasonLabel(
          sub.rejectionReason,
          sub.rejectionNote,
        );
        items.push({
          id: `pay-${sub.id}-rejected`,
          kind: 'paymentVerification',
          title: 'Payment rejected',
          body: `Your ${amountStr} contribution for ${periodLabel} was rejected: ${reasonText}.`,
          createdAtDate: sub.reviewedAtDate ?? sub.submittedAtDate,
          target: { type: 'payments' },
        });
        break;
      }
      case 'pending':
        items.push({
          id: `pay-${sub.id}-pending`,
          kind: 'paymentVerification',
          title: 'Payment awaiting verification',
          body: `Your ${amountStr} contribution for ${periodLabel} is pending verification. It is not included in the verified balance.`,
          createdAtDate: sub.submittedAtDate,
          target: { type: 'payments' },
        });
        break;
    }
  }

  // Include any verified contribution ledger entries for viewer not associated with a submission
  for (const entry of snapshot.ledgerEntries) {
    if (
      entry.kind === 'contribution' &&
      entry.memberId === viewerMemberId &&
      entry.status === 'verified' &&
      !processedEntryIds.has(entry.id)
    ) {
      const period = entry.periodMonth ?? monthStart(entry.occurredAt);
      const periodLabel = formatMonthYear(period);
      const amountStr = formatMoneyPaisa(entry.magnitudePaisa);
      items.push({
        id: `pay-${entry.id}-verified`,
        kind: 'paymentVerification',
        title: 'Payment verified',
        body: `Your ${amountStr} contribution for ${periodLabel} was verified.`,
        createdAtDate: entry.occurredAtDate,
        target: { type: 'payments' },
      });
    }
  }

  // 2. Due date reminder for current open period
  const viewerMember = snapshot.activeMembers.find(
    (m) => m.id === viewerMemberId,
  );
  if (viewerMember) {
    const currentPeriodStartWc = monthStart(snapshot.nowWallClock);
    const periodEndWc = nextMonthStart(currentPeriodStartWc);

    const isObligated =
      isBefore(viewerMember.joinedAtWallClock, periodEndWc) &&
      (viewerMember.leftAtWallClock === null ||
        !isBefore(viewerMember.leftAtWallClock, periodEndWc));

    if (isObligated) {
      const status = deriveObligationStatus({
        entries: snapshot.allDomainEntries,
        memberId: viewerMember.id,
        periodStart: currentPeriodStartWc,
        anchorPeriodStart: snapshot.group.createdAtWallClock,
      });

      if (status !== 'verified') {
        const dueDateWc = dueDateFor(
          currentPeriodStartWc.y,
          currentPeriodStartWc.m,
          snapshot.group.dueDay,
        );
        const dueDate = wallClockToUtcDate(dueDateWc);
        const dueDayMonth = formatDayMonth(dueDate);
        const dueMonthLong = formatMonthName(dueDate);
        const monthPad = String(currentPeriodStartWc.m).padStart(2, '0');

        items.push({
          id: `due-${currentPeriodStartWc.y}-${monthPad}`,
          kind: 'reminder',
          title: `Contributions due ${dueDayMonth}`,
          body: `${dueMonthLong} contributions are due on ${dueDayMonth}.`,
          createdAtDate: dueDate,
          target: { type: 'contributions' },
        });
      }
    }
  }

  // 3. Approvals
  for (const req of snapshot.approvals) {
    const isExpired =
      req.status === 'open' && nowMs > req.createdAt.getTime() + SEVEN_DAYS_MS;
    const formattedAmount = formatMoneyPaisa(req.amountPaisa);

    if (req.status === 'open' && !isExpired) {
      const isEligible = req.eligibleMemberIds.includes(viewerMemberId);
      const hasVoted = req.votes.some((v) => v.memberId === viewerMemberId);

      if (isEligible && !hasVoted) {
        items.push({
          id: `appr-${req.id}-needs-vote`,
          kind: 'approval',
          title: `Vote needed: ${req.title}`,
          body: `${req.title} for ${formattedAmount} needs your vote.`,
          createdAtDate: req.createdAt,
          target: { type: 'approvalDetail', approvalId: req.id },
        });
      }
    }

    if (req.requesterMemberId === viewerMemberId) {
      if (isExpired) {
        items.push({
          id: `appr-${req.id}-expired`,
          kind: 'approval',
          title: `Request expired: ${req.title}`,
          body: `Your request for ${formattedAmount} expired without reaching a decision.`,
          createdAtDate: new Date(req.createdAt.getTime() + SEVEN_DAYS_MS),
          target: { type: 'approvalDetail', approvalId: req.id },
        });
      } else {
        switch (req.status) {
          case 'approved':
            items.push({
              id: `appr-${req.id}-approved`,
              kind: 'approval',
              title: `Request approved: ${req.title}`,
              body: `Your request for ${formattedAmount} was approved.`,
              createdAtDate: req.closedAt ?? req.createdAt,
              target: { type: 'approvalDetail', approvalId: req.id },
            });
            break;
          case 'rejected':
            items.push({
              id: `appr-${req.id}-rejected`,
              kind: 'approval',
              title: `Request rejected: ${req.title}`,
              body: `Your request for ${formattedAmount} was rejected.`,
              createdAtDate: req.closedAt ?? req.createdAt,
              target: { type: 'approvalDetail', approvalId: req.id },
            });
            break;
          case 'executed':
            items.push({
              id: `appr-${req.id}-executed`,
              kind: 'approval',
              title: `Request executed: ${req.title}`,
              body: `Your approved request for ${formattedAmount} has been recorded by the treasurer.`,
              createdAtDate: req.closedAt ?? req.createdAt,
              target: { type: 'approvalDetail', approvalId: req.id },
            });
            break;
          case 'open':
          case 'cancelled':
            break;
        }
      }
    }
  }

  // 4. Reconciliations (visible to all active members)
  for (const rec of snapshot.reconciliations) {
    const dateLabel = formatDayMonthYear(rec.statementDate);
    if (rec.differencePaisa === 0) {
      items.push({
        id: `rec-${rec.id}`,
        kind: 'reconciliation',
        title: 'Bank reconciliation matched',
        body: `Reconciliation for ${dateLabel} matched the recorded balance.`,
        createdAtDate: rec.recordedAt,
        target: { type: 'reconciliation' },
      });
    } else {
      const diffStr = formatMoneyPaisa(rec.differencePaisa);
      const direction =
        rec.differencePaisa < 0 ? 'bank is lower' : 'bank is higher';
      items.push({
        id: `rec-${rec.id}`,
        kind: 'reconciliation',
        title: 'Bank reconciliation mismatch',
        body: `Reconciliation for ${dateLabel}: difference ${diffStr} (${direction}).`,
        createdAtDate: rec.recordedAt,
        target: { type: 'reconciliation' },
      });
    }
  }

  // 5. Treasurer additional queue items
  if (isTreasurer) {
    const hasOtherTreasurer = snapshot.activeMembers.some(
      (m) => m.id !== viewerMemberId && m.isTreasurer,
    );

    const pendingSubmissions = snapshot.paymentSubmissions.filter(
      (s) =>
        s.status === 'pending' &&
        s.postedLedgerEntryId === null &&
        (!hasOtherTreasurer || s.memberId !== viewerMemberId),
    );

    if (pendingSubmissions.length > 0) {
      const count = pendingSubmissions.length;
      let latestPendingTime = pendingSubmissions[0]!.submittedAtDate;
      for (const s of pendingSubmissions) {
        if (s.submittedAtDate.getTime() > latestPendingTime.getTime()) {
          latestPendingTime = s.submittedAtDate;
        }
      }

      items.push({
        id: 'treasurer-pending-payments',
        kind: 'paymentVerification',
        title: 'Payments awaiting verification',
        body:
          count === 1
            ? '1 payment is awaiting verification.'
            : `${count} payments are awaiting verification.`,
        createdAtDate: latestPendingTime,
        target: { type: 'verifyPayments' },
      });
    }

    const awaitingExecution = snapshot.approvals.filter(
      (req) => req.status === 'approved' && req.executedEntryId === null,
    );

    for (const req of awaitingExecution) {
      items.push({
        id: `appr-${req.id}-awaiting-execution`,
        kind: 'approval',
        title: `Request awaiting execution: ${req.title}`,
        body: `${req.title} for ${formatMoneyPaisa(req.amountPaisa)} is approved and ready to be recorded.`,
        createdAtDate: req.closedAt ?? req.createdAt,
        target: { type: 'approvalDetail', approvalId: req.id },
      });
    }
  }

  // Sort newest first; tie-break by id descending
  items.sort((a, b) => {
    const cmp = b.createdAtDate.getTime() - a.createdAtDate.getTime();
    if (cmp !== 0) return cmp;
    return b.id.localeCompare(a.id);
  });

  if (items.length > MAX_UPDATES_FEED_COUNT) {
    return items.slice(0, MAX_UPDATES_FEED_COUNT);
  }
  return items;
}

/**
 * Returns the derived updates feed for a viewer, joining persisted read state.
 */
export async function getUpdatesFeed(
  prisma: PrismaClient,
  params: {
    readonly groupId: string;
    readonly viewerUserId: string;
    readonly viewerMemberId: string;
    readonly isTreasurer: boolean;
    readonly now?: Date | undefined;
  },
): Promise<UpdateItemDto[]> {
  const { groupId, viewerUserId, viewerMemberId, isTreasurer, now } = params;

  const snapshot = await loadGroupSnapshot(prisma, groupId, now);
  const rawItems = deriveRawFeedItems(snapshot, viewerMemberId, isTreasurer);

  // Load read state for this user and group
  const reads = await prisma.userUpdateRead.findMany({
    where: {
      userId: viewerUserId,
      groupId,
    },
    select: { feedItemId: true },
  });

  const readSet = new Set(reads.map((r) => r.feedItemId));

  return rawItems.map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    createdAt: item.createdAtDate.toISOString(),
    isRead: readSet.has(item.id),
    target: item.target,
  }));
}

/**
 * Marks a list of update item IDs as read for a user in a group.
 * Naturally idempotent; unknown IDs are silently ignored.
 */
export async function markUpdatesRead(
  prisma: PrismaClient,
  params: {
    readonly groupId: string;
    readonly userId: string;
    readonly ids: readonly string[];
  },
): Promise<{ readonly markedCount: number }> {
  const { groupId, userId, ids } = params;
  if (ids.length === 0) {
    return { markedCount: 0 };
  }

  const distinctIds = Array.from(new Set(ids)).slice(0, MAX_UPDATES_FEED_COUNT);

  const result = await prisma.userUpdateRead.createMany({
    data: distinctIds.map((feedItemId) => ({
      userId,
      groupId,
      feedItemId,
    })),
    skipDuplicates: true,
  });

  return { markedCount: result.count };
}

/**
 * Marks all current feed items for the viewer as read.
 */
export async function markAllUpdatesRead(
  prisma: PrismaClient,
  params: {
    readonly groupId: string;
    readonly viewerUserId: string;
    readonly viewerMemberId: string;
    readonly isTreasurer: boolean;
    readonly now?: Date | undefined;
  },
): Promise<{ readonly markedCount: number }> {
  const { groupId, viewerUserId, viewerMemberId, isTreasurer, now } = params;

  const snapshot = await loadGroupSnapshot(prisma, groupId, now);
  const rawItems = deriveRawFeedItems(snapshot, viewerMemberId, isTreasurer);

  if (rawItems.length === 0) {
    return { markedCount: 0 };
  }

  const result = await prisma.userUpdateRead.createMany({
    data: rawItems.map((item) => ({
      userId: viewerUserId,
      groupId,
      feedItemId: item.id,
    })),
    skipDuplicates: true,
  });

  return { markedCount: result.count };
}

/**
 * Returns the unread update count for a viewer.
 */
export async function getUnreadUpdatesCount(
  prisma: PrismaClient,
  params: {
    readonly groupId: string;
    readonly viewerUserId: string;
    readonly viewerMemberId: string;
    readonly isTreasurer: boolean;
    readonly now?: Date | undefined;
  },
): Promise<{ readonly unreadCount: number }> {
  const feed = await getUpdatesFeed(prisma, params);
  const unreadCount = feed.filter((item) => !item.isRead).length;
  return { unreadCount };
}
