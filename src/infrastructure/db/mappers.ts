import type {
  LedgerEntry as PrismaLedgerEntry,
  PaymentSubmission as PrismaPaymentSubmission,
} from '@prisma/client';
import type {
  ActivityKind,
  PaymentMethod,
  PaymentStatus,
} from '../../domain/enums.js';
import type { Paisa } from '../../domain/money.js';
import type { LedgerEntry } from '../../domain/types.js';
import type { WallClock } from '../../domain/wall-clock.js';
import { dateOnlyToWallClock, utcInstantToNptWallClock } from '../time/npt.js';
import { bigintToPaisa } from './money.js';

/**
 * Mapped ledger entry extending domain LedgerEntry with database sequence and tenant context.
 */
export interface MappedLedgerEntry extends LedgerEntry {
  readonly seq: bigint;
  readonly groupId: string;
  readonly postedAt: WallClock;
  readonly actorMemberId: string;
}

/**
 * Domain representation of a member payment submission lifecycle record.
 */
export interface DomainPaymentSubmission {
  readonly id: string;
  readonly seq: bigint;
  readonly groupId: string;
  readonly memberId: string;
  readonly periodMonth: WallClock;
  readonly amountPaisa: Paisa;
  readonly paymentMethod: PaymentMethod;
  readonly reference: string | null;
  readonly note: string | null;
  readonly status: 'pending' | 'verified' | 'rejected';
  readonly submittedAt: WallClock;
  readonly reviewedByMemberId: string | null;
  readonly reviewedAt: WallClock | null;
  readonly rejectionReason: string | null;
  readonly rejectionNote: string | null;
  readonly postedLedgerEntryId: string | null;
}

/**
 * Maps a Prisma LedgerEntry row to the domain LedgerEntry interface.
 * Preserves the monotonic `seq` column for sequence tie-breaking.
 */
export function mapLedgerEntryRow(row: PrismaLedgerEntry): MappedLedgerEntry {
  return {
    id: row.id,
    seq: row.seq,
    groupId: row.groupId,
    kind: row.kind as ActivityKind,
    title: row.title,
    magnitudePaisa: bigintToPaisa(row.magnitudePaisa),
    occurredAt: utcInstantToNptWallClock(row.occurredAt),
    postedAt: utcInstantToNptWallClock(row.postedAt),
    status: 'verified',
    memberId: row.memberId,
    paymentMethod: (row.paymentMethod as PaymentMethod) ?? null,
    note: row.note,
    periodMonth: row.periodMonth ? dateOnlyToWallClock(row.periodMonth) : null,
    reversesEntryId: row.reversesEntryId,
    actorMemberId: row.actorMemberId,
  };
}

/**
 * Maps a Prisma PaymentSubmission row to the DomainPaymentSubmission interface.
 */
export function mapPaymentSubmissionRow(
  row: PrismaPaymentSubmission,
): DomainPaymentSubmission {
  return {
    id: row.id,
    seq: row.seq,
    groupId: row.groupId,
    memberId: row.memberId,
    periodMonth: dateOnlyToWallClock(row.periodMonth),
    amountPaisa: bigintToPaisa(row.amountPaisa),
    paymentMethod: row.paymentMethod as PaymentMethod,
    reference: row.reference,
    note: row.note,
    status: row.status as 'pending' | 'verified' | 'rejected',
    submittedAt: utcInstantToNptWallClock(row.submittedAt),
    reviewedByMemberId: row.reviewedByMemberId,
    reviewedAt: row.reviewedAt
      ? utcInstantToNptWallClock(row.reviewedAt)
      : null,
    rejectionReason: row.rejectionReason,
    rejectionNote: row.rejectionNote,
    postedLedgerEntryId: row.postedLedgerEntryId,
  };
}

/**
 * Maps a PaymentSubmission (either Prisma row or domain model) to a LedgerEntry
 * representation for derivation of obligation statuses.
 */
export function mapSubmissionToLedgerEntry(
  submission: PrismaPaymentSubmission | DomainPaymentSubmission,
): MappedLedgerEntry {
  const isPrisma =
    'amountPaisa' in submission && typeof submission.amountPaisa === 'bigint';
  const id = submission.id;
  const seq = submission.seq;
  const groupId = submission.groupId;
  const memberId = submission.memberId;
  const periodMonth = isPrisma
    ? dateOnlyToWallClock((submission as PrismaPaymentSubmission).periodMonth)
    : (submission as DomainPaymentSubmission).periodMonth;
  const magnitudePaisa = isPrisma
    ? bigintToPaisa((submission as PrismaPaymentSubmission).amountPaisa)
    : (submission as DomainPaymentSubmission).amountPaisa;
  const paymentMethod = submission.paymentMethod as PaymentMethod;
  const note = submission.note;
  const statusStr = submission.status;
  const status: PaymentStatus =
    statusStr === 'pending'
      ? 'pendingVerification'
      : statusStr === 'rejected'
        ? 'rejected'
        : 'verified';
  const submittedAt = isPrisma
    ? utcInstantToNptWallClock(
        (submission as PrismaPaymentSubmission).submittedAt,
      )
    : (submission as DomainPaymentSubmission).submittedAt;

  return {
    id,
    seq,
    groupId,
    kind: 'contribution',
    title: 'Savings Contribution',
    magnitudePaisa,
    occurredAt: submittedAt,
    postedAt: submittedAt,
    status,
    memberId,
    paymentMethod,
    note,
    periodMonth,
    reversesEntryId: null,
    actorMemberId: memberId,
  };
}

/**
 * Sorts items by sequence number ascending (earliest to latest insertion order).
 */
export function sortBySeqAsc<T extends { readonly seq: bigint }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) =>
    a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0,
  );
}

/**
 * Sorts items by sequence number descending (latest to earliest insertion order).
 */
export function sortBySeqDesc<T extends { readonly seq: bigint }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) =>
    a.seq > b.seq ? -1 : a.seq < b.seq ? 1 : 0,
  );
}
