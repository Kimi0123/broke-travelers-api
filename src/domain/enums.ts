/**
 * Categorises the kind of financial activity recorded in the ledger.
 * Ports Dart lib/shared/enums/activity_kind.dart:ActivityKind
 */
export type ActivityKind =
  'contribution' | 'interest' | 'expense' | 'withdrawal';

export const ActivityKind = {
  contribution: 'contribution',
  interest: 'interest',
  expense: 'expense',
  withdrawal: 'withdrawal',
} as const;

/**
 * Returns whether [kind] is an outflow (reduces the verified balance).
 * Ports Dart lib/shared/enums/activity_kind.dart:ActivityKind.isOutflow
 */
export function isOutflow(kind: ActivityKind): boolean {
  return kind === 'expense' || kind === 'withdrawal';
}

/**
 * Status describing a member's contribution payment state for a given period.
 * Ports Dart lib/shared/enums/payment_status.dart:PaymentStatus
 */
export type PaymentStatus =
  'notSubmitted' | 'pendingVerification' | 'verified' | 'rejected' | 'overdue';

export const PaymentStatus = {
  notSubmitted: 'notSubmitted',
  pendingVerification: 'pendingVerification',
  verified: 'verified',
  rejected: 'rejected',
  overdue: 'overdue',
} as const;

/**
 * Payment methods used for savings contributions and group transactions.
 * Ports Dart lib/shared/enums/payment_method.dart:PaymentMethod
 */
export type PaymentMethod = 'esewa' | 'khalti' | 'bankTransfer' | 'cash';

export const PaymentMethod = {
  esewa: 'esewa',
  khalti: 'khalti',
  bankTransfer: 'bankTransfer',
  cash: 'cash',
} as const;

/**
 * Roles assigned to members of a savings group.
 * Ports Dart lib/shared/enums/group_role.dart:GroupRole
 */
export type GroupRole = 'owner' | 'treasurer' | 'member';

export const GroupRole = {
  owner: 'owner',
  treasurer: 'treasurer',
  member: 'member',
} as const;

/**
 * Status of an expense or withdrawal approval request.
 * Ports Dart lib/features/approvals/domain/entities/approval_request.dart:ApprovalStatus
 */
export type ApprovalStatus =
  'open' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'executed';

export const ApprovalStatus = {
  open: 'open',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
  expired: 'expired',
  executed: 'executed',
} as const;
