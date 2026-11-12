import { Prisma, type PrismaClient } from '@prisma/client';
import type { ActivityKind, PaymentMethod } from '../domain/enums.js';
import { verifiedBalancePaisa } from '../domain/ledger-math.js';
import type { Paisa } from '../domain/money.js';
import { monthStart } from '../domain/month-math.js';
import { normalizePaymentReference } from '../domain/payment-reference.js';
import {
  validatePaymentNote,
  validatePaymentReference,
} from '../domain/payment-validators.js';
import {
  validateReversalReason,
  validateTransactionNote,
  validateTransactionTitle,
} from '../domain/transaction-validators.js';
import type { WallClock } from '../domain/wall-clock.js';
import { withTransaction } from '../infrastructure/db/client.js';
import { generateId } from '../infrastructure/db/ids.js';
import {
  mapLedgerEntryRow,
  mapPaymentSubmissionRow,
  type DomainPaymentSubmission,
  type MappedLedgerEntry,
} from '../infrastructure/db/mappers.js';
import { bigintToPaisa } from '../infrastructure/db/money.js';
import {
  nptWallClockToUtcInstant,
  wallClockToDateOnly,
} from '../infrastructure/time/npt.js';
import {
  DuplicateReferenceError,
  InsufficientBalanceError,
  InvalidInputError,
  InvalidStatusTransitionError,
  NotFoundError,
  PermissionDeniedError,
  ReversalNotAllowedError,
} from './errors.js';
import { checkIdempotency, saveIdempotency } from './idempotency.js';

export interface PostLedgerEntryInput {
  readonly groupId: string;
  readonly actorMemberId: string;
  readonly actorUserId?: string | undefined;
  readonly kind: ActivityKind;
  readonly title: string;
  readonly magnitudePaisa: Paisa | number;
  readonly occurredAt?: WallClock | Date | undefined;
  readonly memberId?: string | null | undefined;
  readonly periodMonth?: WallClock | Date | null | undefined;
  readonly paymentMethod?: PaymentMethod | null | undefined;
  readonly note?: string | null | undefined;
  readonly reversesEntryId?: string | null | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface VerifySubmissionInput {
  readonly groupId: string;
  readonly submissionId: string;
  readonly reviewerMemberId: string;
  readonly reviewerUserId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface VerifySubmissionResult {
  readonly submission: DomainPaymentSubmission;
  readonly ledgerEntry: MappedLedgerEntry;
}

export interface RejectSubmissionInput {
  readonly groupId: string;
  readonly submissionId: string;
  readonly reviewerMemberId: string;
  readonly rejectionReason:
    'notReceived' | 'wrongAmount' | 'referenceNotFound' | 'other';
  readonly rejectionNote?: string | null | undefined;
  readonly reviewerUserId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface RejectSubmissionResult {
  readonly submission: DomainPaymentSubmission;
}

export interface SubmitPaymentInput {
  readonly groupId: string;
  readonly memberId: string;
  readonly periodMonth: WallClock | Date;
  readonly paymentMethod: PaymentMethod;
  readonly reference?: string | null | undefined;
  readonly note?: string | null | undefined;
  readonly submittedAt?: WallClock | Date | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface ReverseEntryInput {
  readonly groupId: string;
  readonly entryId: string;
  readonly actorMemberId: string;
  readonly reason: string;
  readonly actorUserId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

/**
 * Acquires a row lock on the specified group row (`SELECT id, name, expected_paisa FROM groups WHERE id = $1 FOR UPDATE`).
 * Serializes all financial mutations within the group across concurrent transactions.
 */
export async function acquireGroupLock(
  tx: Prisma.TransactionClient,
  groupId: string,
): Promise<{ id: string; name: string; expectedPaisa: bigint }> {
  const rows = await tx.$queryRaw<
    { id: string; name: string; expected_paisa: bigint }[]
  >(
    Prisma.sql`SELECT id, name, expected_paisa FROM groups WHERE id = ${groupId}::uuid FOR UPDATE`,
  );
  const group = rows[0];
  if (!group) {
    throw new NotFoundError(`Group '${groupId}' not found`);
  }
  return {
    id: group.id,
    name: group.name,
    expectedPaisa: group.expected_paisa,
  };
}

async function resolveActorUserId(
  tx: Prisma.TransactionClient,
  params: {
    readonly actorUserId?: string | undefined;
    readonly actorMemberId: string;
    readonly groupId: string;
  },
): Promise<string> {
  if (params.actorUserId) return params.actorUserId;
  const member = await tx.groupMembership.findUnique({
    where: { id: params.actorMemberId },
    select: { userId: true, groupId: true },
  });
  if (!member || member.groupId !== params.groupId) {
    throw new NotFoundError(
      `Actor membership '${params.actorMemberId}' not found in group`,
    );
  }
  return member.userId;
}

function toDate(input?: WallClock | Date | null): Date | null {
  if (!input) return null;
  if (input instanceof Date) return input;
  return nptWallClockToUtcInstant(input);
}

function toDateOnly(input?: WallClock | Date | null): Date | null {
  if (!input) return null;
  if (input instanceof Date) {
    return new Date(
      Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()),
    );
  }
  return wallClockToDateOnly(monthStart(input));
}

/**
 * Posts a verified financial entry into the ledger with group row locking and balance verification.
 */
export async function postLedgerEntry(
  client: PrismaClient | Prisma.TransactionClient,
  input: PostLedgerEntryInput,
): Promise<MappedLedgerEntry> {
  const execute = async (
    tx: Prisma.TransactionClient,
  ): Promise<MappedLedgerEntry> => {
    // 1. Group row lock
    await acquireGroupLock(tx, input.groupId);

    // Resolve actor user id
    const actorUserId = await resolveActorUserId(tx, {
      actorUserId: input.actorUserId,
      actorMemberId: input.actorMemberId,
      groupId: input.groupId,
    });

    // 2. Idempotency check
    if (input.idempotencyKey) {
      const check = await checkIdempotency<MappedLedgerEntry>(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'post_ledger_entry',
        groupId: input.groupId,
        actorUserId,
        payload: input,
      });
      if (check.existing) {
        return check.existing.data;
      }
    }

    // Input validation
    const titleError = validateTransactionTitle(input.title);
    if (titleError) throw new InvalidInputError(titleError);

    const noteError = validateTransactionNote(input.note);
    if (noteError) throw new InvalidInputError(noteError);

    const magNum = Number(input.magnitudePaisa);
    if (!Number.isInteger(magNum) || magNum <= 0 || magNum > 1_000_000_000) {
      throw new InvalidInputError(
        `Magnitude paisa must be between 1 and 1,000,000,000 paisa, got: ${magNum}`,
      );
    }

    // 3. Load all verified ledger entries in sequence order
    const rawEntries = await tx.ledgerEntry.findMany({
      where: { groupId: input.groupId },
      orderBy: { seq: 'asc' },
    });
    const entries = rawEntries.map(mapLedgerEntryRow);

    // 4. Compute current verified balance
    const currentBalance = verifiedBalancePaisa(entries);

    // 5. If outflow, assert sufficient balance
    if (input.kind === 'expense' || input.kind === 'withdrawal') {
      if (currentBalance < magNum) {
        throw new InsufficientBalanceError(
          `Insufficient verified balance: required ${magNum} paisa, available ${currentBalance} paisa`,
        );
      }
    }

    const occurredAtDate = toDate(input.occurredAt) ?? new Date();
    const periodMonthDate =
      input.kind === 'contribution'
        ? (toDateOnly(input.periodMonth) ?? toDateOnly(occurredAtDate))
        : null;
    const memberId =
      input.kind === 'contribution'
        ? (input.memberId ?? input.actorMemberId)
        : (input.memberId ?? null);

    // 6. Insert new ledger row (identity column assigns seq)
    const newId = generateId();
    const row = await tx.ledgerEntry.create({
      data: {
        id: newId,
        groupId: input.groupId,
        kind: input.kind,
        title: input.title.trim(),
        magnitudePaisa: BigInt(magNum),
        occurredAt: occurredAtDate,
        postedAt: new Date(),
        memberId,
        periodMonth: periodMonthDate,
        paymentMethod: input.paymentMethod ?? null,
        note: input.note?.trim() ?? null,
        reversesEntryId: input.reversesEntryId ?? null,
        actorMemberId: input.actorMemberId,
      },
    });

    // 7. Append audit log
    await tx.auditLog.create({
      data: {
        id: generateId(),
        groupId: input.groupId,
        actorUserId,
        action: 'ledger_entry.posted',
        field: 'ledger_entry',
        beforeValue: null,
        afterValue: JSON.stringify({
          id: row.id,
          kind: row.kind,
          amount: row.magnitudePaisa.toString(),
        }),
      },
    });

    const mapped = mapLedgerEntryRow(row);

    // 8. Save idempotency record
    if (input.idempotencyKey) {
      const check = await checkIdempotency<MappedLedgerEntry>(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'post_ledger_entry',
        groupId: input.groupId,
        actorUserId,
        payload: input,
      });
      await saveIdempotency(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'post_ledger_entry',
        groupId: input.groupId,
        actorUserId,
        requestHash: check.requestHash,
        responseStatus: 201,
        responseBody: mapped,
      });
    }

    return mapped;
  };

  if ('$transaction' in client) {
    return withTransaction(client as PrismaClient, execute);
  }
  return execute(client as Prisma.TransactionClient);
}

/**
 * Atomically verifies a member payment submission and posts an immutable contribution ledger entry.
 */
export async function verifyPaymentSubmission(
  client: PrismaClient | Prisma.TransactionClient,
  input: VerifySubmissionInput,
): Promise<VerifySubmissionResult> {
  const execute = async (
    tx: Prisma.TransactionClient,
  ): Promise<VerifySubmissionResult> => {
    // 1. Group row lock
    await acquireGroupLock(tx, input.groupId);

    // 2. Idempotency check
    if (input.idempotencyKey) {
      const check = await checkIdempotency<VerifySubmissionResult>(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'verify_submission',
        groupId: input.groupId,
        payload: input,
      });
      if (check.existing) {
        return check.existing.data;
      }
    }

    // 3. Load submission FOR UPDATE
    const submission = await tx.paymentSubmission.findUnique({
      where: { id: input.submissionId },
    });
    if (!submission || submission.groupId !== input.groupId) {
      throw new NotFoundError(
        `Payment submission '${input.submissionId}' not found`,
      );
    }
    if (submission.status !== 'pending') {
      throw new InvalidStatusTransitionError(
        `Cannot verify submission in status '${submission.status}'`,
      );
    }

    // 4. Assert reviewer is active treasurer and check self-review
    const reviewer = await tx.groupMembership.findUnique({
      where: { id: input.reviewerMemberId },
    });
    if (!reviewer || reviewer.groupId !== input.groupId) {
      throw new NotFoundError(`Reviewer membership not found in group`);
    }
    if (!reviewer.isTreasurer || reviewer.leftAt !== null) {
      throw new PermissionDeniedError(
        'Only active treasurers can verify payment submissions',
      );
    }

    if (submission.memberId === input.reviewerMemberId) {
      const otherTreasurers = await tx.groupMembership.count({
        where: {
          groupId: input.groupId,
          isTreasurer: true,
          leftAt: null,
          id: { not: input.reviewerMemberId },
        },
      });
      if (otherTreasurers > 0) {
        throw new PermissionDeniedError(
          'Treasurers cannot review their own payment submission when another active treasurer exists',
        );
      }
    }

    const reviewedAt = new Date();
    const newLedgerId = generateId();

    // 6. Insert contribution ledger entry
    const newLedgerRow = await tx.ledgerEntry.create({
      data: {
        id: newLedgerId,
        groupId: input.groupId,
        kind: 'contribution',
        title: 'Savings Contribution',
        magnitudePaisa: submission.amountPaisa,
        occurredAt: submission.submittedAt,
        postedAt: reviewedAt,
        memberId: submission.memberId,
        periodMonth: submission.periodMonth,
        paymentMethod: submission.paymentMethod,
        note: submission.note,
        actorMemberId: input.reviewerMemberId,
      },
    });

    // 5 & 7. Update submission with status and linked ledger entry ID
    const updatedSubRow = await tx.paymentSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'verified',
        reviewedByMemberId: input.reviewerMemberId,
        reviewedAt,
        postedLedgerEntryId: newLedgerRow.id,
      },
    });

    // 8. Append audit log
    await tx.auditLog.create({
      data: {
        id: generateId(),
        groupId: input.groupId,
        actorUserId: reviewer.userId,
        action: 'payment_submission.verified',
        field: 'status',
        beforeValue: 'pending',
        afterValue: 'verified',
      },
    });

    const result: VerifySubmissionResult = {
      submission: mapPaymentSubmissionRow(updatedSubRow),
      ledgerEntry: mapLedgerEntryRow(newLedgerRow),
    };

    // 9. Save idempotency
    if (input.idempotencyKey) {
      const check = await checkIdempotency<VerifySubmissionResult>(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'verify_submission',
        groupId: input.groupId,
        payload: input,
      });
      await saveIdempotency(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'verify_submission',
        groupId: input.groupId,
        actorUserId: reviewer.userId,
        requestHash: check.requestHash,
        responseStatus: 200,
        responseBody: result,
      });
    }

    return result;
  };

  if ('$transaction' in client) {
    return withTransaction(client as PrismaClient, execute);
  }
  return execute(client as Prisma.TransactionClient);
}

/**
 * Rejects a member payment submission with an audit reason and optional note.
 */
export async function rejectPaymentSubmission(
  client: PrismaClient | Prisma.TransactionClient,
  input: RejectSubmissionInput,
): Promise<RejectSubmissionResult> {
  const execute = async (
    tx: Prisma.TransactionClient,
  ): Promise<RejectSubmissionResult> => {
    // 1. Group row lock
    await acquireGroupLock(tx, input.groupId);

    // 2. Idempotency check
    if (input.idempotencyKey) {
      const check = await checkIdempotency<RejectSubmissionResult>(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'reject_submission',
        groupId: input.groupId,
        payload: input,
      });
      if (check.existing) {
        return check.existing.data;
      }
    }

    // 3. Load submission FOR UPDATE
    const submission = await tx.paymentSubmission.findUnique({
      where: { id: input.submissionId },
    });
    if (!submission || submission.groupId !== input.groupId) {
      throw new NotFoundError(
        `Payment submission '${input.submissionId}' not found`,
      );
    }
    if (submission.status !== 'pending') {
      throw new InvalidStatusTransitionError(
        `Cannot reject submission in status '${submission.status}'`,
      );
    }

    // 4. Reviewer check: active treasurer
    const reviewer = await tx.groupMembership.findUnique({
      where: { id: input.reviewerMemberId },
    });
    if (!reviewer || reviewer.groupId !== input.groupId) {
      throw new NotFoundError(`Reviewer membership not found in group`);
    }
    if (!reviewer.isTreasurer || reviewer.leftAt !== null) {
      throw new PermissionDeniedError(
        'Only active treasurers can reject payment submissions',
      );
    }

    // 5. Validate rejection reason and note
    const validReasons = [
      'notReceived',
      'wrongAmount',
      'referenceNotFound',
      'other',
    ];
    if (!validReasons.includes(input.rejectionReason)) {
      throw new InvalidInputError(
        `Invalid rejection reason: '${input.rejectionReason}'`,
      );
    }
    if (
      input.rejectionReason === 'other' &&
      (!input.rejectionNote || input.rejectionNote.trim().length === 0)
    ) {
      throw new InvalidInputError(
        'Rejection note is required when reason is "other"',
      );
    }
    if (input.rejectionNote && input.rejectionNote.trim().length > 200) {
      throw new InvalidInputError(
        'Rejection note cannot exceed 200 characters',
      );
    }

    const reviewedAt = new Date();

    // 6. Update submission
    const updatedSubRow = await tx.paymentSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'rejected',
        rejectionReason: input.rejectionReason,
        rejectionNote: input.rejectionNote?.trim() ?? null,
        reviewedByMemberId: input.reviewerMemberId,
        reviewedAt,
      },
    });

    // 7. Append audit log
    await tx.auditLog.create({
      data: {
        id: generateId(),
        groupId: input.groupId,
        actorUserId: reviewer.userId,
        action: 'payment_submission.rejected',
        field: 'status',
        beforeValue: 'pending',
        afterValue: 'rejected',
      },
    });

    const result: RejectSubmissionResult = {
      submission: mapPaymentSubmissionRow(updatedSubRow),
    };

    // 8. Save idempotency
    if (input.idempotencyKey) {
      const check = await checkIdempotency<RejectSubmissionResult>(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'reject_submission',
        groupId: input.groupId,
        payload: input,
      });
      await saveIdempotency(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'reject_submission',
        groupId: input.groupId,
        actorUserId: reviewer.userId,
        requestHash: check.requestHash,
        responseStatus: 200,
        responseBody: result,
      });
    }

    return result;
  };

  if ('$transaction' in client) {
    return withTransaction(client as PrismaClient, execute);
  }
  return execute(client as Prisma.TransactionClient);
}

/**
 * Creates a member payment submission. The server strictly derives the contribution amount
 * from the group configuration (never accepts client-supplied amounts).
 */
export async function submitPayment(
  client: PrismaClient | Prisma.TransactionClient,
  input: SubmitPaymentInput,
): Promise<DomainPaymentSubmission> {
  const execute = async (
    tx: Prisma.TransactionClient,
  ): Promise<DomainPaymentSubmission> => {
    // 1. Validate reference and note via domain validators
    const refError = validatePaymentReference(
      input.paymentMethod,
      input.reference,
    );
    if (refError) throw new InvalidInputError(refError);

    const noteError = validatePaymentNote(input.note);
    if (noteError) throw new InvalidInputError(noteError);

    const normalizedRef = input.reference
      ? normalizePaymentReference(input.reference)
      : null;

    // 2. Load group and verify member
    const group = await acquireGroupLock(tx, input.groupId);

    const member = await tx.groupMembership.findUnique({
      where: { id: input.memberId },
    });
    if (!member || member.groupId !== input.groupId) {
      throw new NotFoundError(`Member '${input.memberId}' not found in group`);
    }
    if (member.leftAt !== null) {
      throw new PermissionDeniedError(
        'Inactive or departed members cannot submit payments',
      );
    }

    // Idempotency check
    if (input.idempotencyKey) {
      const check = await checkIdempotency<DomainPaymentSubmission>(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'submit_payment',
        groupId: input.groupId,
        payload: input,
      });
      if (check.existing) {
        return check.existing.data;
      }
    }

    const periodMonthDate = toDateOnly(input.periodMonth);
    if (!periodMonthDate) {
      throw new InvalidInputError('Period month is required');
    }
    const submittedAtDate = toDate(input.submittedAt) ?? new Date();

    // 3. Insert submission with status 'pending' (server derives expected_paisa)
    let subRow;
    try {
      subRow = await tx.paymentSubmission.create({
        data: {
          id: generateId(),
          groupId: input.groupId,
          memberId: input.memberId,
          periodMonth: periodMonthDate,
          amountPaisa: group.expectedPaisa,
          paymentMethod: input.paymentMethod,
          reference: normalizedRef,
          note: input.note?.trim() ?? null,
          status: 'pending',
          submittedAt: submittedAtDate,
        },
      });
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        throw new DuplicateReferenceError(
          'A payment submission with this reference is already pending or verified for this payment method',
        );
      }
      throw err;
    }

    // 4. Append audit log
    await tx.auditLog.create({
      data: {
        id: generateId(),
        groupId: input.groupId,
        actorUserId: member.userId,
        action: 'payment_submission.created',
        field: 'status',
        beforeValue: null,
        afterValue: 'pending',
      },
    });

    const mapped = mapPaymentSubmissionRow(subRow);

    // Save idempotency
    if (input.idempotencyKey) {
      const check = await checkIdempotency<DomainPaymentSubmission>(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'submit_payment',
        groupId: input.groupId,
        payload: input,
      });
      await saveIdempotency(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'submit_payment',
        groupId: input.groupId,
        actorUserId: member.userId,
        requestHash: check.requestHash,
        responseStatus: 201,
        responseBody: mapped,
      });
    }

    return mapped;
  };

  if ('$transaction' in client) {
    return withTransaction(client as PrismaClient, execute);
  }
  return execute(client as Prisma.TransactionClient);
}

/**
 * Reverses a previously posted expense or interest ledger entry.
 */
export async function reverseLedgerEntry(
  client: PrismaClient | Prisma.TransactionClient,
  input: ReverseEntryInput,
): Promise<MappedLedgerEntry> {
  const execute = async (
    tx: Prisma.TransactionClient,
  ): Promise<MappedLedgerEntry> => {
    // 1. Group row lock
    await acquireGroupLock(tx, input.groupId);

    // Idempotency check
    if (input.idempotencyKey) {
      const check = await checkIdempotency<MappedLedgerEntry>(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'reverse_ledger_entry',
        groupId: input.groupId,
        payload: input,
      });
      if (check.existing) {
        return check.existing.data;
      }
    }

    // Validate reason
    const reasonError = validateReversalReason(input.reason);
    if (reasonError) throw new InvalidInputError(reasonError);

    // Verify actor
    const actor = await tx.groupMembership.findUnique({
      where: { id: input.actorMemberId },
    });
    if (!actor || actor.groupId !== input.groupId) {
      throw new NotFoundError(`Actor membership not found in group`);
    }
    if (!actor.isTreasurer || actor.leftAt !== null) {
      throw new PermissionDeniedError(
        'Only active treasurers can reverse transactions',
      );
    }

    // 2. Load entry FOR UPDATE
    const entry = await tx.ledgerEntry.findUnique({
      where: { id: input.entryId },
    });
    if (!entry || entry.groupId !== input.groupId) {
      throw new NotFoundError(`Ledger entry '${input.entryId}' not found`);
    }

    // Assert kind is 'expense' or 'interest'
    if (entry.kind !== 'expense' && entry.kind !== 'interest') {
      throw new ReversalNotAllowedError(
        `Cannot reverse ledger entry of kind '${entry.kind}'. Only expenses and interest can be reversed.`,
      );
    }

    // Cannot reverse a reversal
    if (entry.reversesEntryId !== null) {
      throw new ReversalNotAllowedError(
        'Cannot reverse a transaction reversal entry',
      );
    }

    // 3. Assert entry has not already been reversed
    const existingReversal = await tx.ledgerEntry.findFirst({
      where: { reversesEntryId: entry.id },
    });
    if (existingReversal) {
      throw new ReversalNotAllowedError(
        'This ledger entry has already been reversed',
      );
    }

    // 4. Check balance: if reversing an interest entry (inflow), removing it must not overdraw verified balance
    if (entry.kind === 'interest') {
      const rawEntries = await tx.ledgerEntry.findMany({
        where: { groupId: input.groupId },
        orderBy: { seq: 'asc' },
      });
      const entries = rawEntries.map(mapLedgerEntryRow);
      const currentBalance = verifiedBalancePaisa(entries);
      const interestPaisa = bigintToPaisa(entry.magnitudePaisa);
      if (currentBalance < interestPaisa) {
        throw new InsufficientBalanceError(
          'Reversing this interest entry would overdraw the group verified balance',
        );
      }
    }

    const reversalId = generateId();
    const now = new Date();

    // 5. Insert reversal entry
    const reversalRow = await tx.ledgerEntry.create({
      data: {
        id: reversalId,
        groupId: entry.groupId,
        kind: entry.kind,
        title: `Reversal: ${entry.title}`,
        magnitudePaisa: entry.magnitudePaisa,
        occurredAt: now,
        postedAt: now,
        memberId: entry.memberId,
        periodMonth: entry.periodMonth,
        paymentMethod: entry.paymentMethod,
        note: input.reason.trim(),
        reversesEntryId: entry.id,
        actorMemberId: input.actorMemberId,
      },
    });

    // 6. Append audit log
    await tx.auditLog.create({
      data: {
        id: generateId(),
        groupId: input.groupId,
        actorUserId: actor.userId,
        action: 'ledger_entry.reversed',
        field: 'reverses_entry_id',
        beforeValue: entry.id,
        afterValue: reversalRow.id,
      },
    });

    const mapped = mapLedgerEntryRow(reversalRow);

    // Save idempotency
    if (input.idempotencyKey) {
      const check = await checkIdempotency<MappedLedgerEntry>(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'reverse_ledger_entry',
        groupId: input.groupId,
        payload: input,
      });
      await saveIdempotency(tx, {
        idempotencyKey: input.idempotencyKey,
        operation: 'reverse_ledger_entry',
        groupId: input.groupId,
        actorUserId: actor.userId,
        requestHash: check.requestHash,
        responseStatus: 201,
        responseBody: mapped,
      });
    }

    return mapped;
  };

  if ('$transaction' in client) {
    return withTransaction(client as PrismaClient, execute);
  }
  return execute(client as Prisma.TransactionClient);
}
