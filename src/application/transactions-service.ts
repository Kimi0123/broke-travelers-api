import type { PrismaClient } from '@prisma/client';
import type { ActivityKind, PaymentMethod } from '../domain/enums.js';
import { DomainError } from '../domain/errors.js';
import {
  assertValidRecordTransactionInput,
  isRecordableKind,
  validateReversalReason,
} from '../domain/transaction-validators.js';
import { HttpError } from '../http/errors.js';
import type { KeysetCursor } from '../http/helpers/pagination.js';
import {
  getActivityItem,
  listActivityItems,
  type ActivityItemDto,
} from './activity-service.js';
import {
  InsufficientBalanceError,
  InvalidInputError,
  ReversalNotAllowedError,
} from './errors.js';
import { postLedgerEntry, reverseLedgerEntry } from './posting-service.js';
import { utcInstantToNptWallClock } from '../infrastructure/time/npt.js';

export interface RecordTransactionParams {
  readonly groupId: string;
  readonly actorMemberId: string;
  readonly actorUserId: string;
  readonly kind: ActivityKind;
  readonly amountPaisa: number;
  readonly occurredAt: string;
  readonly title: string;
  readonly note?: string | null | undefined;
  readonly method?: PaymentMethod | null | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface ReverseTransactionParams {
  readonly groupId: string;
  readonly transactionId: string;
  readonly actorMemberId: string;
  readonly actorUserId: string;
  readonly reason: string;
  readonly idempotencyKey?: string | undefined;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TransactionsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async listTransactions(params: {
    readonly groupId: string;
    readonly limit: number;
    readonly cursor: KeysetCursor | null;
    readonly kind?: ActivityKind | undefined;
    readonly status?: string | undefined;
  }): Promise<{
    readonly items: ActivityItemDto[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  }> {
    return listActivityItems(this.prisma, params);
  }

  async getTransaction(params: {
    readonly groupId: string;
    readonly transactionId: string;
    readonly viewer?:
      | {
          readonly memberId: string;
          readonly isTreasurer: boolean;
          readonly isOwner: boolean;
        }
      | undefined;
  }): Promise<ActivityItemDto> {
    return getActivityItem(this.prisma, params);
  }

  async recordTransaction(
    params: RecordTransactionParams,
  ): Promise<ActivityItemDto> {
    const {
      groupId,
      actorMemberId,
      actorUserId,
      kind,
      amountPaisa,
      occurredAt,
      title,
      note,
      method,
      idempotencyKey,
    } = params;

    if (!isRecordableKind(kind)) {
      throw new HttpError(
        400,
        'invalid_transaction_input',
        `Activity kind '${kind}' cannot be recorded directly`,
      );
    }

    const date = new Date(occurredAt);
    if (isNaN(date.getTime())) {
      throw new HttpError(
        400,
        'invalid_transaction_input',
        'Invalid occurredAt date format',
      );
    }

    const occurredWallClock = utcInstantToNptWallClock(date);
    const nowWallClock = utcInstantToNptWallClock(this.clock());

    try {
      assertValidRecordTransactionInput({
        kind,
        amountPaisa,
        occurredAt: occurredWallClock,
        title,
        note: note ?? null,
        now: nowWallClock,
      });
    } catch (err: unknown) {
      if (err instanceof DomainError) {
        throw new HttpError(400, 'invalid_transaction_input', err.message);
      }
      throw err;
    }

    try {
      const entry = await postLedgerEntry(this.prisma, {
        groupId,
        actorMemberId,
        actorUserId,
        kind,
        title: title.trim(),
        magnitudePaisa: amountPaisa,
        occurredAt: date,
        note: note?.trim() ?? null,
        paymentMethod: method ?? null,
        idempotencyKey,
      });

      return await getActivityItem(this.prisma, {
        groupId,
        transactionId: `ledger:${entry.id}`,
      });
    } catch (err: unknown) {
      if (err instanceof InsufficientBalanceError) {
        throw new HttpError(409, 'insufficient_balance', err.message);
      }
      if (err instanceof InvalidInputError) {
        throw new HttpError(400, 'invalid_transaction_input', err.message);
      }
      throw err;
    }
  }

  async reverseTransaction(
    params: ReverseTransactionParams,
  ): Promise<ActivityItemDto> {
    const {
      groupId,
      transactionId,
      actorMemberId,
      actorUserId,
      reason,
      idempotencyKey,
    } = params;

    const trimmedReason = reason.trim();
    const reasonErr = validateReversalReason(trimmedReason);
    if (reasonErr !== null) {
      throw new HttpError(400, 'invalid_transaction_input', reasonErr);
    }

    let rawId: string;
    if (transactionId.startsWith('submission:')) {
      const subId = transactionId.slice(11);
      const sub = await this.prisma.paymentSubmission.findFirst({
        where: { id: subId, groupId },
      });
      if (!sub) {
        throw new HttpError(404, 'transaction_not_found');
      }
      throw new HttpError(
        400,
        'transaction_not_reversible',
        'Payment submissions cannot be reversed',
      );
    } else if (transactionId.startsWith('ledger:')) {
      rawId = transactionId.slice(7);
    } else if (UUID_REGEX.test(transactionId)) {
      rawId = transactionId;
    } else {
      throw new HttpError(404, 'transaction_not_found');
    }

    if (!UUID_REGEX.test(rawId)) {
      throw new HttpError(404, 'transaction_not_found');
    }

    const entry = await this.prisma.ledgerEntry.findFirst({
      where: { id: rawId, groupId },
    });

    if (!entry) {
      const sub = await this.prisma.paymentSubmission.findFirst({
        where: { id: rawId, groupId },
      });
      if (sub) {
        throw new HttpError(
          400,
          'transaction_not_reversible',
          'Payment submissions cannot be reversed',
        );
      }
      throw new HttpError(404, 'transaction_not_found');
    }

    if (entry.kind !== 'expense' && entry.kind !== 'interest') {
      throw new HttpError(
        400,
        'transaction_not_reversible',
        `Cannot reverse transaction of kind '${entry.kind}'`,
      );
    }

    if (entry.reversesEntryId !== null) {
      throw new HttpError(
        400,
        'transaction_not_reversible',
        'Cannot reverse a reversal transaction',
      );
    }

    const existingReversal = await this.prisma.ledgerEntry.findFirst({
      where: { groupId, reversesEntryId: entry.id },
    });
    if (existingReversal) {
      throw new HttpError(409, 'transaction_already_reversed');
    }

    try {
      const reversal = await reverseLedgerEntry(this.prisma, {
        groupId,
        entryId: entry.id,
        actorMemberId,
        actorUserId,
        reason: trimmedReason,
        idempotencyKey,
      });

      return await getActivityItem(this.prisma, {
        groupId,
        transactionId: `ledger:${reversal.id}`,
      });
    } catch (err: unknown) {
      if (err instanceof InsufficientBalanceError) {
        throw new HttpError(409, 'insufficient_balance', err.message);
      }
      if (err instanceof ReversalNotAllowedError) {
        if (err.message.includes('already been reversed')) {
          throw new HttpError(409, 'transaction_already_reversed', err.message);
        }
        throw new HttpError(400, 'transaction_not_reversible', err.message);
      }
      throw err;
    }
  }
}
