/**
 * Masks a payment reference for non-privileged viewers and activity feeds.
 *
 * Backend privacy rule:
 * - For references longer than 4 characters: returns 'Ref ••••' followed by the last 4 characters (e.g. 'Ref ••••3456').
 * - For references of 4 characters or fewer: returns strictly 'Ref ••••' (never reveals a short reference).
 *
 * NOTE: This intentionally differs from the Flutter client UI expression in my_payments_screen.dart:85
 * (which renders short references in full). The owner decided the backend API should never leak
 * short references. The owner may modify this rule in future revisions.
 */
export function maskPaymentReference(
  reference: string | null | undefined,
): string {
  if (!reference) return '';
  const trimmed = reference.trim();
  if (trimmed.length <= 4) {
    return 'Ref ••••';
  }
  return `Ref ••••${trimmed.slice(-4)}`;
}
