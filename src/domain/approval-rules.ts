import type { ApprovalStatus } from './enums.js';
import { DomainError } from './errors.js';
import { addDays, isBefore, type WallClock } from './wall-clock.js';

/**
 * Returns the strict majority votes needed for [eligible] voters.
 *
 * Formula: eligible ~/ 2 + 1
 * 2 eligible -> 2
 * 3 eligible -> 2
 * 4 eligible -> 3
 * 5 eligible -> 3
 * 6 eligible -> 4
 * 7 eligible -> 4
 * 8 eligible -> 5
 *
 * Ports Dart lib/features/approvals/domain/approval_rules.dart:votesNeeded
 */
export function votesNeeded(eligible: number): number {
  if (!Number.isInteger(eligible) || eligible < 1) {
    throw new DomainError(
      'invalidInput',
      `Eligible voter count must be a positive integer, got: ${eligible}`,
    );
  }
  const half = (eligible - (eligible % 2)) / 2;
  return half + 1;
}

/**
 * Determines whether an open approval request has reached approval,
 * has been early-rejected, or remains open.
 *
 * - Approved if approvals >= votesNeeded(eligible).
 * - Early-rejected if eligible - rejections < votesNeeded(eligible) (impossible to reach threshold).
 * - Otherwise remains open.
 *
 * Ports Dart lib/features/approvals/domain/approval_rules.dart:resolveOpenStatus
 */
export function resolveOpenStatus(params: {
  readonly eligible: number;
  readonly approvals: number;
  readonly rejections: number;
}): 'approved' | 'rejected' | 'open' {
  const { eligible, approvals, rejections } = params;
  const needed = votesNeeded(eligible);

  if (approvals >= needed) {
    return 'approved';
  }
  if (eligible - rejections < needed) {
    return 'rejected';
  }
  return 'open';
}

/**
 * Returns whether an approval request has expired (7 days past creation).
 * Exactly at 7 days and later is expired.
 *
 * Ports Dart lib/features/approvals/data/repositories/mock_approvals_repository.dart:_statusAt
 */
export function isApprovalExpired(
  createdAt: WallClock,
  now: WallClock,
): boolean {
  const expiresAt = addDays(createdAt, 7);
  return !isBefore(now, expiresAt);
}

/**
 * Resolves full approval status taking votes and expiration window into account.
 */
export function resolveApprovalStatus(params: {
  readonly eligible: number;
  readonly approvals: number;
  readonly rejections: number;
  readonly createdAt?: WallClock;
  readonly now?: WallClock;
}): ApprovalStatus {
  if (params.createdAt && params.now) {
    if (isApprovalExpired(params.createdAt, params.now)) {
      return 'expired';
    }
  }
  return resolveOpenStatus(params);
}
