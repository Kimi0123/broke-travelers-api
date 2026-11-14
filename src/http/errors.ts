import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApplicationError } from '../application/errors.js';
import { DomainError } from '../domain/errors.js';

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
  };
}

/**
 * Authoritative message mapping table derived from docs/domain-rules.md Section 11
 * and docs/api-contract.md.
 */
export const ERROR_MESSAGES: Readonly<
  Record<string, { status: number; message: string }>
> = {
  // Global / HTTP errors
  unauthenticated: { status: 401, message: 'Authentication required' },
  user_not_provisioned: {
    status: 401,
    message:
      'User profile has not been provisioned. Please call POST /v1/session first.',
  },
  invalid_token_claims: {
    status: 400,
    message: 'Authentication token is missing required claims',
  },
  forbidden: {
    status: 403,
    message: 'You do not have permission to perform this action',
  },
  not_found: { status: 404, message: 'The requested endpoint was not found' },
  invalid_request: {
    status: 400,
    message: 'Malformed request syntax or validation failure',
  },
  invalid_cursor: {
    status: 400,
    message: 'Pagination cursor is invalid or malformed',
  },
  invalid_input: { status: 400, message: 'Invalid input' },
  payload_too_large: {
    status: 413,
    message: 'Request payload exceeds allowed limit',
  },
  too_many_attempts: {
    status: 429,
    message: 'Too many attempts; please try again later',
  },
  internal_error: {
    status: 500,
    message: 'An unexpected error occurred. Please try again later.',
  },

  // Idempotency
  idempotency_key_required: {
    status: 400,
    message: 'Idempotency-Key header is required',
  },
  invalid_idempotency_key: {
    status: 400,
    message: 'Idempotency-Key header is invalid',
  },
  idempotency_conflict: {
    status: 409,
    message: 'Idempotency key was reused with differing request payload',
  },

  // Groups & Membership
  group_not_found: {
    status: 404,
    message: 'Group not found or access denied',
  },
  group_access_denied: {
    status: 404,
    message: 'Group not found or access denied',
  },
  email_not_verified: {
    status: 403,
    message:
      'Please verify your email address before joining or creating a group',
  },
  group_creation_failed: {
    status: 409,
    message: 'Unable to create group for this user',
  },
  invalid_group_settings: {
    status: 400,
    message: 'Group name or due day failed validation',
  },
  member_not_found: { status: 404, message: 'Member not found' },
  cannot_remove_owner: {
    status: 409,
    message: 'The group owner cannot be removed',
  },
  member_has_pending_payments: {
    status: 409,
    message: 'Cannot remove member with pending payments',
  },
  cannot_remove_last_treasurer: {
    status: 409,
    message: "Cannot remove the group's only treasurer",
  },

  // Invitations
  invalid_invitation_code: {
    status: 400,
    message: 'Invitation code is invalid or expired',
  },
  already_in_group: {
    status: 409,
    message: 'You are already a member of a group',
  },
  invitation_not_revocable: {
    status: 409,
    message:
      'Invitation cannot be revoked because it has already been accepted or expired',
  },

  // Financial & Ledger
  insufficient_balance: {
    status: 409,
    message: 'Insufficient verified balance to record transaction',
  },
  report_range_invalid: {
    status: 400,
    message: "Requested report period is outside the group's history",
  },
  invalid_credentials: { status: 401, message: 'Invalid email or password' },
  email_already_in_use: {
    status: 409,
    message: 'An account with this email already exists',
  },
  weak_password: {
    status: 400,
    message: 'Password does not meet security requirements',
  },
  not_obligated: {
    status: 400,
    message: 'You are not obligated for this period',
  },
  period_not_open: {
    status: 400,
    message: 'This period is not open for submission',
  },
  period_not_found: {
    status: 404,
    message: 'Contribution period not found',
  },
  already_submitted: {
    status: 409,
    message: 'Payment already submitted for this period',
  },
  duplicate_reference: {
    status: 409,
    message: 'A payment with this reference is already recorded',
  },
  invalid_payment_input: {
    status: 400,
    message: 'Payment details failed validation',
  },
  submission_not_found: {
    status: 404,
    message: 'Payment submission not found',
  },
  already_reviewed: {
    status: 409,
    message: 'Payment has already been reviewed',
  },
  cannot_review_own_payment: {
    status: 403,
    message: 'You cannot verify your own payment when another treasurer exists',
  },
  invalid_review_input: {
    status: 400,
    message: 'Review rejection reason or note failed validation',
  },
  invalid_transaction_input: {
    status: 400,
    message: 'Transaction input failed validation',
  },
  transaction_not_found: { status: 404, message: 'Transaction not found' },
  transaction_not_reversible: {
    status: 400,
    message: 'This transaction cannot be reversed',
  },
  transaction_already_reversed: {
    status: 409,
    message: 'This transaction has already been reversed',
  },
  invalid_approval_input: {
    status: 400,
    message: 'Approval input failed validation',
  },
  not_enough_members: {
    status: 400,
    message: 'Group needs at least two members for approvals',
  },
  approval_not_found: { status: 404, message: 'Approval request not found' },
  approval_not_open: {
    status: 409,
    message: 'Approval request is closed or expired',
  },
  approval_not_approved: {
    status: 409,
    message: 'Request has not reached approval threshold',
  },
  already_voted: {
    status: 409,
    message: 'You have already voted on this request',
  },
  not_eligible_to_vote: {
    status: 403,
    message: 'You are not eligible to vote on this request',
  },
  cannot_vote_on_own_request: {
    status: 403,
    message: 'You cannot vote on your own request',
  },
  approval_already_executed: {
    status: 409,
    message: 'This approval request has already been recorded',
  },
  cannot_execute_own_request: {
    status: 403,
    message:
      'You cannot execute your own request when another treasurer exists',
  },
  invalid_statement_date: {
    status: 400,
    message: 'Statement date is invalid or in the future',
  },
  invalid_reconciliation_input: {
    status: 400,
    message: 'Statement date, balance, or note is invalid',
  },
  reconciliation_already_recorded: {
    status: 409,
    message:
      'A reconciliation has already been recorded for this statement date',
  },
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message ?? ERROR_MESSAGES[code]?.message ?? 'An error occurred');
    this.name = 'HttpError';
  }
}

/**
 * Resolves an error into an HTTP status and canonical error code.
 */
export function resolveError(err: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (err instanceof HttpError) {
    const entry = ERROR_MESSAGES[err.code];
    return {
      status: err.status,
      code: err.code,
      message: entry ? entry.message : err.message,
    };
  }

  if (err instanceof ApplicationError) {
    const entry = ERROR_MESSAGES[err.code];
    return {
      status: entry ? entry.status : err.statusCode,
      code: err.code,
      message: entry ? entry.message : err.message,
    };
  }

  if (err instanceof DomainError) {
    const codeMap: Record<string, string> = {
      insufficientBalance: 'insufficient_balance',
      permissionDenied: 'forbidden',
      duplicateReference: 'duplicate_reference',
      invalidInput: 'invalid_input',
      reversalNotAllowed: 'transaction_not_reversible',
      invalidStatusTransition: 'already_reviewed',
      voteNotAllowed: 'not_eligible_to_vote',
      thresholdNotMet: 'approval_not_approved',
    };
    const mappedCode = codeMap[err.code] ?? 'invalid_input';
    const entry =
      ERROR_MESSAGES[mappedCode] ?? ERROR_MESSAGES['invalid_input']!;
    return {
      status: entry.status,
      code: mappedCode,
      message: entry.message,
    };
  }

  if (err instanceof ZodError) {
    const entry = ERROR_MESSAGES['invalid_request']!;
    return {
      status: 400,
      code: 'invalid_request',
      message: entry.message,
    };
  }

  // Body parser errors (PayloadTooLargeError or JSON SyntaxError)
  const anyErr = err as { type?: string; status?: number };
  if (anyErr?.type === 'entity.too.large' || anyErr?.status === 413) {
    const entry = ERROR_MESSAGES['payload_too_large']!;
    return {
      status: 413,
      code: 'payload_too_large',
      message: entry.message,
    };
  }

  if (err instanceof SyntaxError && ('status' in err || 'body' in err)) {
    const entry = ERROR_MESSAGES['invalid_request']!;
    return {
      status: 400,
      code: 'invalid_request',
      message: entry.message,
    };
  }

  // Unknown or unmapped error -> 500 internal_error
  const fallback = ERROR_MESSAGES['internal_error']!;
  return {
    status: 500,
    code: 'internal_error',
    message: fallback.message,
  };
}

/**
 * Central Express error-handling middleware.
 */
export function createErrorHandler(logger?: {
  error: (obj: unknown, msg: string) => void;
}) {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  return (
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
  ): void => {
    /* eslint-enable @typescript-eslint/no-unused-vars */
    const requestId = (req as { id?: string }).id ?? 'unknown';
    const resolved = resolveError(err);

    if (err instanceof HttpError && err.headers) {
      res.set(err.headers);
    }

    if (resolved.status >= 500 && logger) {
      logger.error(
        { err, requestId, path: req.path, method: req.method },
        'Unhandled internal server error',
      );
    }

    const payload: ApiErrorResponse = {
      error: {
        code: resolved.code,
        message: resolved.message,
        requestId,
      },
    };

    res.status(resolved.status).json(payload);
  };
}
