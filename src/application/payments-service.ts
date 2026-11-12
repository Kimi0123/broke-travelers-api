import type { PrismaClient } from '@prisma/client';
import type { PaymentMethod, PaymentStatus } from '../domain/enums.js';
import { monthStart, nextMonthStart } from '../domain/month-math.js';
import { deriveObligationStatus } from '../domain/obligation-status.js';
import { normalizePaymentReference } from '../domain/payment-reference.js';
import {
  validatePaymentNote,
  validatePaymentReference,
} from '../domain/payment-validators.js';
import { maskPaymentReference } from '../domain/reference-masking.js';
import { effectivePeriodMonth } from '../domain/types.js';
import { createWallClock, isAfter, isBefore } from '../domain/wall-clock.js';
import { HttpError } from '../http/errors.js';
import { withTransaction } from '../infrastructure/db/client.js';
import { generateId } from '../infrastructure/db/ids.js';
import {
  mapLedgerEntryRow,
  mapSubmissionToLedgerEntry,
  sortBySeqAsc,
  type MappedLedgerEntry,
} from '../infrastructure/db/mappers.js';
import { utcInstantToNptWallClock } from '../infrastructure/time/npt.js';
import {
  InvalidInputError,
  InvalidStatusTransitionError,
  NotFoundError,
  PermissionDeniedError,
} from './errors.js';
import { computeRequestHash, saveIdempotency } from './idempotency.js';
import {
  acquireGroupLock,
  rejectPaymentSubmission,
  verifyPaymentSubmission,
} from './posting-service.js';
import type { DomainPaymentSubmission } from '../infrastructure/db/mappers.js';

export interface SubmitPaymentParams {
  readonly groupId: string;
  readonly actorUserId: string;
  readonly memberId: string;
  readonly periodId: string;
  readonly method: PaymentMethod;
  readonly reference?: string | null | undefined;
  readonly note?: string | null | undefined;
  readonly idempotencyKey: string;
}

export interface SubmitPaymentResultDto {
  readonly id: string;
  readonly groupId: string;
  readonly memberId: string;
  readonly periodMonth: string;
  readonly amountPaisa: number;
  readonly paymentMethod: PaymentMethod;
  readonly reference: string | null;
  readonly note: string | null;
  readonly status: 'pending';
  readonly submittedAt: string;
}

export interface MyPaymentItemDto {
  readonly id: string;
  readonly periodMonth: string;
  readonly amountPaisa: number;
  readonly paymentMethod: PaymentMethod;
  readonly reference: string | null;
  readonly note: string | null;
  readonly status: PaymentStatus;
  readonly submittedAt: string;
  readonly rejectionReason: string | null;
  readonly rejectionNote: string | null;
}

export interface PendingPaymentReviewDto {
  readonly submissionId: string;
  readonly memberId: string;
  readonly memberName: string;
  readonly periodMonth: string;
  readonly amountPaisa: number;
  readonly paymentMethod: PaymentMethod;
  readonly reference: string | null;
  readonly note: string | null;
  readonly submittedAt: string;
  readonly isOwnSubmission: boolean;
}

export class PaymentsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock?: (() => Date) | undefined,
    private readonly idGenerator?: (() => string) | undefined,
  ) {}

  private getNow(): Date {
    return this.clock ? this.clock() : new Date();
  }

  private getId(): string {
    return this.idGenerator ? this.idGenerator() : generateId();
  }

  async submitPayment(
    params: SubmitPaymentParams,
  ): Promise<{ submission: SubmitPaymentResultDto; isReplay: boolean }> {
    const {
      groupId,
      actorUserId,
      memberId,
      periodId,
      method,
      reference,
      note,
      idempotencyKey,
    } = params;

    // Validate reference and note with domain validators
    const refError = validatePaymentReference(method, reference);
    if (refError) {
      throw new HttpError(400, 'invalid_payment_input', refError);
    }

    const noteError = validatePaymentNote(note);
    if (noteError) {
      throw new HttpError(400, 'invalid_payment_input', noteError);
    }

    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodId)) {
      throw new HttpError(400, 'period_not_open');
    }

    const year = Number(periodId.substring(0, 4));
    const monthNumber = Number(periodId.substring(5, 7));
    const periodStart = createWallClock(year, monthNumber, 1, 0, 0, 0, 0);

    const payloadHash = computeRequestHash({
      groupId,
      periodId,
      method,
      reference: reference?.trim() || null,
      note: note?.trim() || null,
    });

    // 1. Early idempotency check outside transaction to allow exact replay
    const earlyCheck = await this.prisma.idempotencyKey.findFirst({
      where: {
        idempotencyKey,
        operation: 'submit_payment',
        groupId,
        actorUserId,
      },
    });

    if (earlyCheck) {
      if (earlyCheck.requestHash !== payloadHash) {
        throw new HttpError(409, 'idempotency_conflict');
      }
      return {
        submission:
          earlyCheck.responseBody as unknown as SubmitPaymentResultDto,
        isReplay: true,
      };
    }

    // 2. Perform submission inside transaction with row lock
    const now = this.getNow();
    const nowWallClock = utcInstantToNptWallClock(now);
    const anchorPeriodStart = monthStart(nowWallClock);

    return withTransaction(this.prisma, async (tx) => {
      // Re-check idempotency under transaction
      const txCheck = await tx.idempotencyKey.findFirst({
        where: {
          idempotencyKey,
          operation: 'submit_payment',
          groupId,
          actorUserId,
        },
      });

      if (txCheck) {
        if (txCheck.requestHash !== payloadHash) {
          throw new HttpError(409, 'idempotency_conflict');
        }
        return {
          submission: txCheck.responseBody as unknown as SubmitPaymentResultDto,
          isReplay: true,
        };
      }

      // Acquire group lock
      const groupData = await acquireGroupLock(tx, groupId);

      const group = await tx.group.findUnique({
        where: { id: groupId },
        include: {
          memberships: true,
        },
      });

      if (!group) {
        throw new HttpError(404, 'group_not_found');
      }

      const member = group.memberships.find((m) => m.id === memberId);
      if (!member || member.userId !== actorUserId) {
        throw new HttpError(404, 'member_not_found');
      }
      if (member.leftAt !== null) {
        throw new HttpError(403, 'forbidden');
      }

      // Load all entries to determine period validity and obligation status
      const [ledgerRows, submissionRows] = await Promise.all([
        tx.ledgerEntry.findMany({
          where: { groupId },
          orderBy: { seq: 'asc' },
        }),
        tx.paymentSubmission.findMany({
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

      // Calculate earliest period
      const groupCreatedWallClock = utcInstantToNptWallClock(group.createdAt);
      let earliest = monthStart(groupCreatedWallClock);
      if (isBefore(anchorPeriodStart, earliest)) {
        earliest = anchorPeriodStart;
      }
      for (const entry of allEntries) {
        const eMonth =
          entry.kind === 'contribution'
            ? effectivePeriodMonth(entry)
            : monthStart(entry.occurredAt);
        if (isBefore(eMonth, earliest)) {
          earliest = eMonth;
        }
      }

      // Period open check
      if (
        isBefore(periodStart, earliest) ||
        isAfter(periodStart, anchorPeriodStart)
      ) {
        throw new HttpError(400, 'period_not_open');
      }

      // Obligation check
      const periodEnd = nextMonthStart(periodStart);
      const joinedWallClock = utcInstantToNptWallClock(member.joinedAt);
      const leftWallClock = member.leftAt
        ? utcInstantToNptWallClock(member.leftAt)
        : null;

      if (
        !isBefore(joinedWallClock, periodEnd) ||
        (leftWallClock !== null && isBefore(leftWallClock, periodEnd))
      ) {
        throw new HttpError(400, 'not_obligated');
      }

      // Check if already submitted or verified
      const status = deriveObligationStatus({
        entries: allEntries,
        memberId: member.id,
        periodStart,
        anchorPeriodStart,
      });

      if (status === 'verified' || status === 'pendingVerification') {
        throw new HttpError(409, 'already_submitted');
      }

      const normalizedRef = reference
        ? normalizePaymentReference(reference)
        : null;

      const periodMonthDate = new Date(
        Date.UTC(periodStart.y, periodStart.m - 1, 1),
      );

      const submissionId = this.getId();

      let subRow;
      try {
        subRow = await tx.paymentSubmission.create({
          data: {
            id: submissionId,
            groupId,
            memberId: member.id,
            periodMonth: periodMonthDate,
            amountPaisa: groupData.expectedPaisa,
            paymentMethod: method,
            reference: normalizedRef,
            note: note?.trim() || null,
            status: 'pending',
            submittedAt: now,
          },
        });
      } catch (err: unknown) {
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code: string }).code === 'P2002'
        ) {
          throw new HttpError(409, 'duplicate_reference');
        }
        throw err;
      }

      // Audit log entry
      await tx.auditLog.create({
        data: {
          id: this.getId(),
          groupId,
          actorUserId,
          action: 'payment.submitted',
          field: `period:${periodId}`,
          beforeValue: 'none',
          afterValue: 'pendingVerification',
          createdAt: now,
        },
      });

      const responseDto: SubmitPaymentResultDto = {
        id: subRow.id,
        groupId: subRow.groupId,
        memberId: subRow.memberId,
        periodMonth: `${periodStart.y}-${String(periodStart.m).padStart(2, '0')}-01`,
        amountPaisa: Number(subRow.amountPaisa),
        paymentMethod: subRow.paymentMethod as PaymentMethod,
        reference: subRow.reference,
        note: subRow.note,
        status: 'pending',
        submittedAt: subRow.submittedAt.toISOString(),
      };

      // Save idempotency
      await saveIdempotency(tx, {
        idempotencyKey,
        operation: 'submit_payment',
        groupId,
        actorUserId,
        requestHash: payloadHash,
        responseStatus: 201,
        responseBody: responseDto,
      });

      return {
        submission: responseDto,
        isReplay: false,
      };
    });
  }

  async getMyPayments(
    groupId: string,
    memberId: string,
  ): Promise<MyPaymentItemDto[]> {
    const submissions = await this.prisma.paymentSubmission.findMany({
      where: {
        groupId,
        memberId,
      },
      orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    });

    return submissions.map((sub) => {
      const periodWallClock = utcInstantToNptWallClock(sub.periodMonth);
      const periodMonthStr = `${periodWallClock.y}-${String(periodWallClock.m).padStart(2, '0')}-01`;

      const status =
        sub.status === 'pending'
          ? 'pendingVerification'
          : (sub.status as PaymentStatus);

      return {
        id: sub.id,
        periodMonth: periodMonthStr,
        amountPaisa: Number(sub.amountPaisa),
        paymentMethod: sub.paymentMethod as PaymentMethod,
        reference: sub.reference ? maskPaymentReference(sub.reference) : null,
        note: sub.note,
        status,
        submittedAt: sub.submittedAt.toISOString(),
        rejectionReason: sub.rejectionReason,
        rejectionNote: sub.rejectionNote,
      };
    });
  }

  async getPendingReviews(
    groupId: string,
    callerMemberId: string,
  ): Promise<PendingPaymentReviewDto[]> {
    const submissions = await this.prisma.paymentSubmission.findMany({
      where: {
        groupId,
        status: 'pending',
      },
      include: {
        member: {
          include: {
            user: { select: { displayName: true } },
          },
        },
      },
      orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    });

    return submissions.map((sub) => {
      const periodWallClock = utcInstantToNptWallClock(sub.periodMonth);
      const periodMonthStr = `${periodWallClock.y}-${String(periodWallClock.m).padStart(2, '0')}-01`;

      return {
        submissionId: sub.id,
        memberId: sub.memberId,
        memberName: sub.member.user.displayName,
        periodMonth: periodMonthStr,
        amountPaisa: Number(sub.amountPaisa),
        paymentMethod: sub.paymentMethod as PaymentMethod,
        reference: sub.reference, // UNMASKED for treasurer review
        note: sub.note,
        submittedAt: sub.submittedAt.toISOString(),
        isOwnSubmission: sub.memberId === callerMemberId,
      };
    });
  }

  async verifyPayment(params: {
    readonly groupId: string;
    readonly submissionId: string;
    readonly reviewerMemberId: string;
    readonly reviewerUserId: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly result: {
      readonly submission: DomainPaymentSubmission;
      readonly ledgerEntryId: string;
    };
    readonly isReplay: boolean;
  }> {
    const {
      groupId,
      submissionId,
      reviewerMemberId,
      reviewerUserId,
      idempotencyKey,
    } = params;

    const payloadHash = computeRequestHash({
      groupId,
      submissionId,
      action: 'verify',
    });

    // 1. Early idempotency check
    const earlyCheck = await this.prisma.idempotencyKey.findFirst({
      where: {
        idempotencyKey,
        operation: 'verify_submission',
        groupId,
        actorUserId: reviewerUserId,
      },
    });

    if (earlyCheck) {
      if (earlyCheck.requestHash !== payloadHash) {
        throw new HttpError(409, 'idempotency_conflict');
      }
      return {
        result: earlyCheck.responseBody as unknown as {
          submission: DomainPaymentSubmission;
          ledgerEntryId: string;
        },
        isReplay: true,
      };
    }

    // 2. Preflight checks
    const sub = await this.prisma.paymentSubmission.findUnique({
      where: { id: submissionId },
    });
    if (!sub || sub.groupId !== groupId) {
      throw new HttpError(404, 'submission_not_found');
    }
    if (sub.status !== 'pending') {
      throw new HttpError(409, 'already_reviewed');
    }

    // 3. Self-review check
    if (sub.memberId === reviewerMemberId) {
      const otherTreasurers = await this.prisma.groupMembership.count({
        where: {
          groupId,
          isTreasurer: true,
          leftAt: null,
          id: { not: reviewerMemberId },
        },
      });
      if (otherTreasurers > 0) {
        throw new HttpError(403, 'cannot_review_own_payment');
      }
    }

    try {
      const verified = await verifyPaymentSubmission(this.prisma, {
        groupId,
        submissionId,
        reviewerMemberId,
        reviewerUserId,
        idempotencyKey,
      });

      return {
        result: {
          submission: verified.submission,
          ledgerEntryId: verified.ledgerEntry.id,
        },
        isReplay: false,
      };
    } catch (err: unknown) {
      if (err instanceof NotFoundError) {
        throw new HttpError(404, 'submission_not_found');
      }
      if (err instanceof InvalidStatusTransitionError) {
        throw new HttpError(409, 'already_reviewed');
      }
      if (err instanceof PermissionDeniedError) {
        throw new HttpError(403, 'cannot_review_own_payment');
      }
      throw err;
    }
  }

  async rejectPayment(params: {
    readonly groupId: string;
    readonly submissionId: string;
    readonly reviewerMemberId: string;
    readonly reviewerUserId: string;
    readonly reason:
      'notReceived' | 'wrongAmount' | 'referenceNotFound' | 'other';
    readonly note?: string | null | undefined;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly submission: DomainPaymentSubmission;
    readonly isReplay: boolean;
  }> {
    const {
      groupId,
      submissionId,
      reviewerMemberId,
      reviewerUserId,
      reason,
      note,
      idempotencyKey,
    } = params;

    const validReasons = [
      'notReceived',
      'wrongAmount',
      'referenceNotFound',
      'other',
    ];
    if (!validReasons.includes(reason)) {
      throw new HttpError(
        400,
        'invalid_review_input',
        `Invalid rejection reason: '${reason}'`,
      );
    }
    if (reason === 'other' && (!note || note.trim().length === 0)) {
      throw new HttpError(
        400,
        'invalid_review_input',
        'Rejection note is required when reason is "other"',
      );
    }
    if (note && note.trim().length > 200) {
      throw new HttpError(
        400,
        'invalid_review_input',
        'Rejection note cannot exceed 200 characters',
      );
    }

    const payloadHash = computeRequestHash({
      groupId,
      submissionId,
      reason,
      note: note?.trim() || null,
      action: 'reject',
    });

    // 1. Early idempotency check
    const earlyCheck = await this.prisma.idempotencyKey.findFirst({
      where: {
        idempotencyKey,
        operation: 'reject_submission',
        groupId,
        actorUserId: reviewerUserId,
      },
    });

    if (earlyCheck) {
      if (earlyCheck.requestHash !== payloadHash) {
        throw new HttpError(409, 'idempotency_conflict');
      }
      return {
        submission:
          earlyCheck.responseBody as unknown as DomainPaymentSubmission,
        isReplay: true,
      };
    }

    // 2. Preflight checks
    const sub = await this.prisma.paymentSubmission.findUnique({
      where: { id: submissionId },
    });
    if (!sub || sub.groupId !== groupId) {
      throw new HttpError(404, 'submission_not_found');
    }
    if (sub.status !== 'pending') {
      throw new HttpError(409, 'already_reviewed');
    }

    // 3. Self-review check
    if (sub.memberId === reviewerMemberId) {
      const otherTreasurers = await this.prisma.groupMembership.count({
        where: {
          groupId,
          isTreasurer: true,
          leftAt: null,
          id: { not: reviewerMemberId },
        },
      });
      if (otherTreasurers > 0) {
        throw new HttpError(403, 'cannot_review_own_payment');
      }
    }

    try {
      const rejected = await rejectPaymentSubmission(this.prisma, {
        groupId,
        submissionId,
        reviewerMemberId,
        reviewerUserId,
        rejectionReason: reason,
        rejectionNote: note,
        idempotencyKey,
      });

      return {
        submission: rejected.submission,
        isReplay: false,
      };
    } catch (err: unknown) {
      if (err instanceof NotFoundError) {
        throw new HttpError(404, 'submission_not_found');
      }
      if (err instanceof InvalidStatusTransitionError) {
        throw new HttpError(409, 'already_reviewed');
      }
      if (err instanceof PermissionDeniedError) {
        throw new HttpError(403, 'cannot_review_own_payment');
      }
      if (err instanceof InvalidInputError) {
        throw new HttpError(400, 'invalid_review_input');
      }
      throw err;
    }
  }
}
