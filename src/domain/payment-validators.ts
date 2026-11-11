import type { PaymentMethod, PaymentStatus } from './enums.js';
import { normalizePaymentReference } from './payment-reference.js';

/**
 * Returns a validation error message for a payment reference, or null if valid.
 *
 * Rules:
 * - Cash: null or empty reference is valid (cash payments can occur without reference).
 * - Digital/bank: empty reference is invalid ('Enter the payment reference').
 * - Valid length: 4 to 40 characters after normalization.
 * - Allowed characters: uppercase letters, digits, underscore, forward slash, hyphen.
 *
 * Ports Dart lib/features/payments/domain/payment_validators.dart:validatePaymentReference
 */
export function validatePaymentReference(
  method: PaymentMethod,
  value: string | null | undefined,
): string | null {
  const normalized = value == null ? '' : normalizePaymentReference(value);

  if (method === 'cash' && normalized.length === 0) {
    return null;
  }
  if (normalized.length === 0) {
    return 'Enter the payment reference';
  }
  if (
    normalized.length < 4 ||
    normalized.length > 40 ||
    !/^[A-Z0-9_/-]+$/.test(normalized)
  ) {
    return 'Use 4 to 40 letters, numbers, - _ or /';
  }
  return null;
}

/**
 * Returns a validation error message for a payment note, or null if valid.
 * Maximum length is 200 characters.
 *
 * Ports Dart lib/features/payments/domain/payment_validators.dart:validatePaymentNote
 */
export function validatePaymentNote(
  value: string | null | undefined,
): string | null {
  if (value != null && value.length > 200) {
    return 'Keep the note under 200 characters';
  }
  return null;
}

/**
 * Checks whether an active (pendingVerification or verified) submission already exists
 * for the same group and payment method with the same normalized reference.
 * Rejected submissions do not block duplicate reuse.
 *
 * Ports Dart lib/features/payments/data/repositories/mock_payments_repository.dart:_hasActiveDuplicateReference
 */
export function hasActiveDuplicateReference(params: {
  readonly existingSubmissions: readonly {
    readonly method: PaymentMethod;
    readonly reference: string | null;
    readonly status: PaymentStatus;
    readonly groupId?: string;
  }[];
  readonly method: PaymentMethod;
  readonly reference: string;
  readonly groupId?: string;
}): boolean {
  const targetNormalized = normalizePaymentReference(params.reference);

  for (const sub of params.existingSubmissions) {
    if (params.groupId && sub.groupId && sub.groupId !== params.groupId) {
      continue;
    }
    if (sub.method !== params.method || sub.reference == null) {
      continue;
    }
    if (normalizePaymentReference(sub.reference) !== targetNormalized) {
      continue;
    }
    if (sub.status === 'pendingVerification' || sub.status === 'verified') {
      return true;
    }
  }

  return false;
}
