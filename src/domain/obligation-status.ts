import type { PaymentStatus } from './enums.js';
import { monthStart, nextMonthStart } from './month-math.js';
import { effectivePeriodMonth, type LedgerEntry } from './types.js';
import { compareWallClock, isBefore, type WallClock } from './wall-clock.js';

/**
 * Derives a member's contribution payment status for the month containing [periodStart].
 *
 * Evaluation rules:
 * 1. Filter to contribution entries for [memberId] whose effective period month
 *    falls within [periodStart] calendar month.
 * 2. Sort matching submissions by [occurredAt] descending.
 * 3. Break identical timestamp ties using input list insertion order descending
 *    (the later entry in the input list wins).
 *    NOTE FOR PERSISTENCE: The database/persistence layer must supply entries
 *    in deterministic insertion order (e.g. ordered by monotonic `seq ASC` or
 *    `created_at ASC, id ASC`) so list order reflects true submission sequence.
 * 4. The latest submission determines the status (verified, pendingVerification, rejected).
 * 5. If no submission exists:
 *    - If [periodStart] is before [anchorPeriodStart] month -> PaymentStatus.overdue.
 *    - If [periodStart] is current anchor or future month -> PaymentStatus.notSubmitted.
 *
 * Ports Dart lib/core/mock/obligation_status.dart:deriveObligationStatus
 */
export function deriveObligationStatus(params: {
  readonly entries: readonly LedgerEntry[];
  readonly memberId: string;
  readonly periodStart: WallClock;
  readonly anchorPeriodStart: WallClock;
}): PaymentStatus {
  const { entries, memberId, periodStart, anchorPeriodStart } = params;

  const start = monthStart(periodStart);
  const end = nextMonthStart(start);

  const entryIndexes = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry) {
      entryIndexes.set(entry.id, i);
    }
  }

  const matching = entries.filter((entry) => {
    if (entry.memberId !== memberId) return false;
    if (entry.kind !== 'contribution') return false;
    const period = effectivePeriodMonth(entry);
    return !isBefore(period, start) && isBefore(period, end);
  });

  matching.sort((first, second) => {
    const byTime = compareWallClock(second.occurredAt, first.occurredAt);
    if (byTime !== 0) return byTime;
    const firstIdx = entryIndexes.get(first.id) ?? 0;
    const secondIdx = entryIndexes.get(second.id) ?? 0;
    return secondIdx - firstIdx;
  });

  const firstMatch = matching[0];
  if (firstMatch) {
    return firstMatch.status;
  }

  const anchorStart = monthStart(anchorPeriodStart);
  return isBefore(start, anchorStart) ? 'overdue' : 'notSubmitted';
}
