import type { ActivityKind } from './enums.js';
import { DomainError } from './errors.js';
import type { Paisa } from './money.js';
import { addDays, isAfter, isBefore, type WallClock } from './wall-clock.js';

/**
 * Validates and trims transaction titles.
 * Valid titles are 2 to 60 characters after trimming.
 *
 * Ports Dart lib/features/transactions/domain/transaction_validators.dart:validateTransactionTitle
 */
export function validateTransactionTitle(
  title: string | null | undefined,
): string | null {
  const value = title?.trim() ?? '';
  if (value.length === 0) return 'Enter a title';
  if (value.length < 2 || value.length > 60) {
    return 'Title must be 2 to 60 characters';
  }
  return null;
}

/**
 * Validates optional transaction notes.
 * Valid notes are at most 200 characters after trimming.
 *
 * Ports Dart lib/features/transactions/domain/transaction_validators.dart:validateTransactionNote
 */
export function validateTransactionNote(
  note: string | null | undefined,
): string | null {
  if ((note?.trim().length ?? 0) > 200) {
    return 'Keep the note under 200 characters';
  }
  return null;
}

/**
 * Validates a required transaction reversal reason.
 * Valid reasons are 3 to 200 characters after trimming.
 *
 * Ports Dart lib/features/transactions/domain/transaction_validators.dart:validateReversalReason
 */
export function validateReversalReason(
  reason: string | null | undefined,
): string | null {
  const value = reason?.trim() ?? '';
  if (value.length === 0) return 'Enter a reason';
  if (value.length < 3 || value.length > 200) {
    return 'Reason must be 3 to 200 characters';
  }
  return null;
}

/**
 * Whether [kind] can be recorded directly by a Treasurer without prior approval.
 * Only interest and expense can be directly recorded.
 *
 * Ports Dart lib/features/transactions/domain/transaction_validators.dart:isRecordableKind
 */
export function isRecordableKind(kind: ActivityKind): boolean {
  return kind === 'interest' || kind === 'expense';
}

/**
 * Validates composite input parameters for recording a direct transaction.
 *
 * Throws DomainError('invalidInput') if:
 * - kind is not recordable (only expense and interest allowed)
 * - amountPaisa <= 0 or amountPaisa > 1,000,000,000 paisa (10,000,000 NPR)
 * - title fails title validation
 * - note fails note validation
 * - occurredAt is in the future (> now)
 * - occurredAt is older than 366 days (< now - 366 days)
 *
 * Ports Dart lib/features/transactions/data/repositories/mock_transactions_repository.dart:recordTransaction
 */
export function assertValidRecordTransactionInput(params: {
  readonly kind: ActivityKind;
  readonly amountPaisa: Paisa | number;
  readonly occurredAt: WallClock;
  readonly title: string;
  readonly note?: string | null;
  readonly now: WallClock;
}): void {
  const { kind, amountPaisa, occurredAt, title, note, now } = params;

  if (!isRecordableKind(kind)) {
    throw new DomainError(
      'invalidInput',
      `Activity kind '${kind}' cannot be recorded directly`,
    );
  }

  const rawAmount: number = amountPaisa;
  if (
    !Number.isInteger(rawAmount) ||
    rawAmount <= 0 ||
    rawAmount > 1_000_000_000
  ) {
    throw new DomainError(
      'invalidInput',
      `Amount must be between 1 and 1,000,000,000 paisa, got: ${rawAmount}`,
    );
  }

  const titleError = validateTransactionTitle(title);
  if (titleError !== null) {
    throw new DomainError('invalidInput', titleError);
  }

  const noteError = validateTransactionNote(note);
  if (noteError !== null) {
    throw new DomainError('invalidInput', noteError);
  }

  if (isAfter(occurredAt, now)) {
    throw new DomainError(
      'invalidInput',
      'Transaction date cannot be in the future',
    );
  }

  const oldestAllowed = addDays(now, -366);
  if (isBefore(occurredAt, oldestAllowed)) {
    throw new DomainError(
      'invalidInput',
      'Transaction date cannot be older than 366 days',
    );
  }
}
