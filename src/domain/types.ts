import type {
  ActivityKind,
  GroupRole,
  PaymentMethod,
  PaymentStatus,
} from './enums.js';
import type { Paisa } from './money.js';
import { monthStart } from './month-math.js';
import type { WallClock } from './wall-clock.js';

/**
 * Raw ledger entry representing a transaction or payment submission.
 * Ports Dart lib/core/mock/mock_ledger_data.dart:MockLedgerEntry
 */
export interface LedgerEntry {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly title: string;
  readonly occurredAt: WallClock;
  readonly magnitudePaisa: Paisa;
  readonly status: PaymentStatus;
  readonly memberId?: string | null | undefined;
  readonly paymentMethod?: PaymentMethod | null | undefined;
  readonly note?: string | null | undefined;
  readonly periodMonth?: WallClock | null | undefined;
  readonly reversesEntryId?: string | null | undefined;
}

/**
 * Returns the effective contribution period month, defaulting to the month the activity occurred.
 * Ports Dart lib/core/mock/mock_ledger_data.dart:MockLedgerEntry.effectivePeriodMonth
 */
export function effectivePeriodMonth(entry: LedgerEntry): WallClock {
  return monthStart(entry.periodMonth ?? entry.occurredAt);
}

/**
 * Group member entity representing membership and obligation rules.
 * Ports Dart lib/core/mock/mock_ledger_data.dart:MockRosterMember
 */
export interface GroupMember {
  readonly id: string;
  readonly name: string;
  readonly roles?: readonly GroupRole[] | ReadonlySet<GroupRole> | undefined;
  readonly joinedAt: WallClock;
  readonly leftAt?: WallClock | null | undefined;
  readonly expectedPaisa?: Paisa | undefined;
  readonly userId?: string | null | undefined;
}
