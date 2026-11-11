/**
 * Trims and uppercases a payment reference, removing all whitespace and hyphens.
 *
 * Ports Dart lib/features/payments/domain/payment_reference.dart:normalizePaymentReference
 */
export function normalizePaymentReference(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]/g, '');
}
