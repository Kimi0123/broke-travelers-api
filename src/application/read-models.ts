import { Prisma, type PrismaClient } from '@prisma/client';
import type { ActivityKind, PaymentStatus } from '../domain/enums.js';
import { signedPaisa } from '../domain/ledger-math.js';
import type { LedgerLine, ReportMember } from '../domain/report-types.js';
import type { LedgerEntry } from '../domain/types.js';
import type { WallClock } from '../domain/wall-clock.js';
import { HttpError } from '../http/errors.js';
import {
  mapLedgerEntryRow,
  mapPaymentSubmissionRow,
  mapSubmissionToLedgerEntry,
  type DomainPaymentSubmission,
  type MappedLedgerEntry,
} from '../infrastructure/db/mappers.js';
import { utcInstantToNptWallClock } from '../infrastructure/time/npt.js';

export interface SnapshotMember {
  readonly id: string; // membership ID
  readonly userId: string;
  readonly displayName: string;
  readonly isOwner: boolean;
  readonly isTreasurer: boolean;
  readonly joinedAt: Date;
  readonly joinedAtWallClock: WallClock;
  readonly leftAt: Date | null;
  readonly leftAtWallClock: WallClock | null;
  readonly expectedPaisa: number;
}

export interface SnapshotApproval {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly requesterMemberId: string;
  readonly title: string;
  readonly amountPaisa: number;
  readonly status: string;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
  readonly executedEntryId: string | null;
  readonly eligibleMemberIds: readonly string[];
  readonly votes: ReadonlyArray<{
    readonly memberId: string;
    readonly choice: string;
    readonly at: Date;
  }>;
}

export interface SnapshotReconciliation {
  readonly id: string;
  readonly statementDate: Date;
  readonly statementDateStr: string;
  readonly bankBalancePaisa: number;
  readonly recordedBalancePaisa: number;
  readonly differencePaisa: number;
  readonly status: 'matched' | 'mismatch';
  readonly note: string | null;
  readonly recordedByMemberId: string;
  readonly recordedByName: string;
  readonly recordedAt: Date;
}

export interface SnapshotLedgerEntry extends MappedLedgerEntry {
  readonly occurredAtDate: Date;
}

export interface SnapshotPaymentSubmission extends DomainPaymentSubmission {
  readonly submittedAtDate: Date;
  readonly reviewedAtDate: Date | null;
}

export interface GroupSnapshot {
  readonly group: {
    readonly id: string;
    readonly name: string;
    readonly expectedPaisa: number;
    readonly dueDay: number;
    readonly createdAt: Date;
    readonly createdAtWallClock: WallClock;
  };
  readonly members: readonly SnapshotMember[];
  readonly activeMembers: readonly SnapshotMember[];
  readonly reportMembers: readonly ReportMember[];
  readonly ledgerEntries: readonly SnapshotLedgerEntry[];
  readonly paymentSubmissions: readonly SnapshotPaymentSubmission[];
  readonly ledgerLines: readonly LedgerLine[];
  readonly allDomainEntries: readonly LedgerEntry[];
  readonly approvals: readonly SnapshotApproval[];
  readonly reconciliations: readonly SnapshotReconciliation[];
  readonly now: Date;
  readonly nowWallClock: WallClock;
}

/**
 * Loads a consistent snapshot of an entire group inside ONE read-only transaction
 * with REPEATABLE READ isolation.
 *
 * All financial calculations, report generation, and updates feed derivation
 * consume this snapshot directly via pure domain functions.
 */
export async function loadGroupSnapshot(
  prisma: PrismaClient,
  groupId: string,
  now: Date = new Date(),
): Promise<GroupSnapshot> {
  const nowWallClock = utcInstantToNptWallClock(now);

  return prisma.$transaction(
    async (tx) => {
      // 1. Group info
      const groupRow = await tx.group.findUnique({
        where: { id: groupId },
      });
      if (!groupRow) {
        throw new HttpError(404, 'group_not_found');
      }

      // 2. Memberships with User info
      const membershipRows = await tx.groupMembership.findMany({
        where: { groupId },
        include: { user: { select: { displayName: true } } },
        orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
      });

      // 3. Ledger Entries (verified entries) ordered by seq asc
      const ledgerRows = await tx.ledgerEntry.findMany({
        where: { groupId },
        orderBy: { seq: 'asc' },
      });

      // 4. Payment Submissions ordered by seq asc
      const submissionRows = await tx.paymentSubmission.findMany({
        where: { groupId },
        include: {
          member: { include: { user: { select: { displayName: true } } } },
        },
        orderBy: { seq: 'asc' },
      });

      // 5. Approvals with eligible voters and votes
      const approvalRows = await tx.approvalRequest.findMany({
        where: { groupId },
        include: {
          eligibleVoters: { select: { memberId: true } },
          votes: { select: { memberId: true, choice: true, createdAt: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      // 6. Bank Reconciliations ordered newest statementDate first
      const reconRows = await tx.bankReconciliation.findMany({
        where: { groupId },
        include: {
          recordedByMember: {
            include: { user: { select: { displayName: true } } },
          },
        },
        orderBy: [{ statementDate: 'desc' }, { recordedAt: 'desc' }],
      });

      // Map Members
      const members: SnapshotMember[] = membershipRows.map((m) => {
        const joinedAtWallClock = utcInstantToNptWallClock(m.joinedAt);
        const leftAtWallClock = m.leftAt
          ? utcInstantToNptWallClock(m.leftAt)
          : null;
        return {
          id: m.id,
          userId: m.userId,
          displayName: m.user.displayName,
          isOwner: m.isOwner,
          isTreasurer: m.isTreasurer,
          joinedAt: m.joinedAt,
          joinedAtWallClock,
          leftAt: m.leftAt,
          leftAtWallClock,
          expectedPaisa: Number(groupRow.expectedPaisa),
        };
      });

      const activeMembers = members.filter((m) => m.leftAt === null);

      const reportMembers: ReportMember[] = members.map((m) => ({
        id: m.id,
        name: m.displayName,
        joinedAt: m.joinedAtWallClock,
        leftAt: m.leftAtWallClock,
      }));

      // Map Ledger Entries
      const mappedLedgerEntries: SnapshotLedgerEntry[] = ledgerRows.map(
        (row) => ({
          ...mapLedgerEntryRow(row),
          occurredAtDate: row.occurredAt,
        }),
      );

      // Map Submissions
      const domainSubmissions: SnapshotPaymentSubmission[] = submissionRows.map(
        (row) => ({
          ...mapPaymentSubmissionRow(row),
          submittedAtDate: row.submittedAt,
          reviewedAtDate: row.reviewedAt,
        }),
      );

      // Build LedgerLine[] for report builders
      // Includes all verified ledger entries plus active pending/rejected submissions
      const ledgerLines: LedgerLine[] = [];

      for (const entry of mappedLedgerEntries) {
        ledgerLines.push({
          id: entry.id,
          kind: entry.kind,
          status: entry.status,
          amount: entry.magnitudePaisa,
          signed: signedPaisa(entry),
          occurredAt: entry.occurredAt,
          periodMonth: entry.periodMonth,
          memberId: entry.memberId,
          title: entry.title,
          reversesId: entry.reversesEntryId,
        });
      }

      // Add unverified submissions (where postedLedgerEntryId is null)
      for (const sub of domainSubmissions) {
        if (sub.postedLedgerEntryId === null) {
          const status: PaymentStatus =
            sub.status === 'pending'
              ? 'pendingVerification'
              : sub.status === 'rejected'
                ? 'rejected'
                : 'verified';

          const matchingMember = members.find((m) => m.id === sub.memberId);
          const memberDisplayName = matchingMember?.displayName ?? 'Member';

          ledgerLines.push({
            id: `submission:${sub.id}`,
            kind: 'contribution',
            status,
            amount: sub.amountPaisa,
            signed: sub.amountPaisa,
            occurredAt: sub.submittedAt,
            periodMonth: sub.periodMonth,
            memberId: sub.memberId,
            title: `${memberDisplayName}'s contribution`,
            reversesId: null,
          });
        }
      }

      // Build unified allDomainEntries for obligation status derivations
      const allDomainEntries: LedgerEntry[] = [
        ...mappedLedgerEntries,
        ...domainSubmissions
          .filter((s) => s.postedLedgerEntryId === null)
          .map(mapSubmissionToLedgerEntry),
      ];

      // Map Approvals
      const approvals: SnapshotApproval[] = approvalRows.map((a) => {
        return {
          id: a.id,
          kind: a.kind as ActivityKind,
          requesterMemberId: a.requesterMemberId,
          title: a.title,
          amountPaisa: Number(a.amountPaisa),
          status: a.status,
          createdAt: a.createdAt,
          closedAt: a.closedAt,
          executedEntryId: a.executedEntryId,
          eligibleMemberIds: a.eligibleVoters.map((ev) => ev.memberId),
          votes: a.votes.map((v) => ({
            memberId: v.memberId,
            choice: v.choice,
            at: v.createdAt,
          })),
        };
      });

      // Map Reconciliations
      const reconciliations: SnapshotReconciliation[] = reconRows.map((r) => {
        const diff = Number(r.differencePaisa);
        return {
          id: r.id,
          statementDate: r.statementDate,
          statementDateStr: r.statementDate.toISOString().slice(0, 10),
          bankBalancePaisa: Number(r.bankBalancePaisa),
          recordedBalancePaisa: Number(r.recordedBalancePaisa),
          differencePaisa: diff,
          status: diff === 0 ? 'matched' : 'mismatch',
          note: r.note,
          recordedByMemberId: r.recordedByMemberId,
          recordedByName: r.recordedByMember?.user.displayName ?? 'Member',
          recordedAt: r.recordedAt,
        };
      });

      return {
        group: {
          id: groupRow.id,
          name: groupRow.name,
          expectedPaisa: Number(groupRow.expectedPaisa),
          dueDay: groupRow.dueDay,
          createdAt: groupRow.createdAt,
          createdAtWallClock: utcInstantToNptWallClock(groupRow.createdAt),
        },
        members,
        activeMembers,
        reportMembers,
        ledgerEntries: mappedLedgerEntries,
        paymentSubmissions: domainSubmissions,
        ledgerLines,
        allDomainEntries,
        approvals,
        reconciliations,
        now,
        nowWallClock,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5000,
      timeout: 10000,
    },
  );
}
