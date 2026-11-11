import { isOutflow, type ActivityKind } from './enums.js';
import { paisa, ZERO_PAISA, type Paisa } from './money.js';
import type { LedgerEntry } from './types.js';
import { endOfDayInclusive, isAfter, type WallClock } from './wall-clock.js';

/**
 * Returns an entry's signed paisa, accounting for outflows and reversals.
 * Inflows are positive, outflows are negative, and reversals flip the sign.
 *
 * Ports Dart lib/core/mock/ledger_math.dart:signedPaisa
 */
export function signedPaisa(entry: {
  readonly kind: ActivityKind;
  readonly magnitudePaisa: Paisa;
  readonly reversesEntryId?: string | null | undefined;
}): Paisa {
  const outflowMultiplier = isOutflow(entry.kind) ? -1 : 1;
  const reversalMultiplier = entry.reversesEntryId != null ? -1 : 1;
  const rawSigned =
    (entry.magnitudePaisa as number) * outflowMultiplier * reversalMultiplier;
  return paisa(rawSigned);
}

/**
 * Computes the verified ledger balance in integer paisa.
 *
 * Only entries with PaymentStatus.verified are included. Inflows (contributions,
 * interest) add to the balance; outflows (expenses, withdrawals) subtract from it;
 * reversals flip the original sign via signedPaisa. Unverified and rejected
 * entries are strictly ignored.
 *
 * If [asOf] is provided, only entries whose [occurredAt] falls on or before the
 * inclusive end of that calendar day (23:59:59.999) are included.
 *
 * If the resulting balance is negative, it is returned as-is without clamping.
 *
 * Ports Dart lib/core/mock/ledger_math.dart:verifiedBalancePaisa
 */
export function verifiedBalancePaisa(
  entries: Iterable<LedgerEntry>,
  options?: { readonly asOf?: WallClock | null },
): Paisa {
  const cutoff = options?.asOf ? endOfDayInclusive(options.asOf) : null;
  let totalRaw = 0;

  for (const entry of entries) {
    if (entry.status !== 'verified') continue;
    if (cutoff !== null && isAfter(entry.occurredAt, cutoff)) continue;
    totalRaw += signedPaisa(entry) as number;
  }

  return totalRaw === 0 ? ZERO_PAISA : paisa(totalRaw);
}
