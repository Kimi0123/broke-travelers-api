import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { IdempotencyConflictError } from '../../src/application/errors.js';
import { DomainError } from '../../src/domain/errors.js';
import {
  ERROR_MESSAGES,
  HttpError,
  createErrorHandler,
  resolveError,
} from '../../src/http/errors.js';

describe('Error Mapping and Taxonomy', () => {
  const section11Codes = [
    'group_not_found',
    'group_access_denied',
    'forbidden',
    'group_creation_failed',
    'invalid_group_settings',
    'cannot_remove_owner',
    'member_has_pending_payments',
    'cannot_remove_last_treasurer',
    'insufficient_balance',
    'report_range_invalid',
    'invalid_credentials',
    'email_already_in_use',
    'weak_password',
    'invalid_invitation_code',
    'already_in_group',
    'too_many_attempts',
    'not_obligated',
    'period_not_open',
    'already_submitted',
    'duplicate_reference',
    'invalid_payment_input',
    'submission_not_found',
    'already_reviewed',
    'cannot_review_own_payment',
    'invalid_review_input',
    'invalid_transaction_input',
    'transaction_not_found',
    'transaction_not_reversible',
    'transaction_already_reversed',
    'invalid_approval_input',
    'not_enough_members',
    'approval_not_found',
    'approval_not_open',
    'approval_not_approved',
    'already_voted',
    'not_eligible_to_vote',
    'cannot_vote_on_own_request',
    'approval_already_executed',
    'invalid_reconciliation_input',
    'reconciliation_already_recorded',
  ];

  it('contains every machine code from docs/domain-rules.md Section 11', () => {
    for (const code of section11Codes) {
      expect(
        ERROR_MESSAGES,
        `Expected ${code} to be defined in ERROR_MESSAGES`,
      ).toHaveProperty(code);
      expect(ERROR_MESSAGES[code]?.status).toBeGreaterThanOrEqual(400);
      expect(ERROR_MESSAGES[code]?.message).toBeTruthy();
    }
  });

  it('maps HttpError with canonical message and status', () => {
    const error = new HttpError(404, 'group_not_found');
    const resolved = resolveError(error);

    expect(resolved.status).toBe(404);
    expect(resolved.code).toBe('group_not_found');
    expect(resolved.message).toBe('Group not found or access denied');
  });

  it('maps ApplicationError with corresponding entry in ERROR_MESSAGES', () => {
    const error = new IdempotencyConflictError('Different payload');
    const resolved = resolveError(error);

    expect(resolved.status).toBe(409);
    expect(resolved.code).toBe('idempotency_conflict');
    expect(resolved.message).toBe(
      'Idempotency key was reused with differing request payload',
    );
  });

  it('maps DomainError correctly to corresponding canonical code', () => {
    const error = new DomainError('insufficientBalance', 'Cannot afford');
    const resolved = resolveError(error);

    expect(resolved.status).toBe(409);
    expect(resolved.code).toBe('insufficient_balance');
    expect(resolved.message).toBe(
      'Insufficient verified balance to record transaction',
    );
  });

  it('maps ZodError to 400 invalid_request with fixed message', () => {
    const schema = z.object({ amount: z.number().positive() });
    const parseResult = schema.safeParse({ amount: -5 });
    if (!parseResult.success) {
      const resolved = resolveError(parseResult.error);
      expect(resolved.status).toBe(400);
      expect(resolved.code).toBe('invalid_request');
      expect(resolved.message).toBe(
        'Malformed request syntax or validation failure',
      );
    } else {
      expect.fail('Should fail');
    }
  });

  it('maps payload too large error to 413 payload_too_large', () => {
    const err = { type: 'entity.too.large', status: 413 };
    const resolved = resolveError(err);

    expect(resolved.status).toBe(413);
    expect(resolved.code).toBe('payload_too_large');
    expect(resolved.message).toBe('Request payload exceeds allowed limit');
  });

  it('maps unexpected internal errors to 500 internal_error without leaking internals', () => {
    const internalErr = new Error(
      'PrismaClientKnownRequestError: column users.password does not exist at ...',
    );
    const resolved = resolveError(internalErr);

    expect(resolved.status).toBe(500);
    expect(resolved.code).toBe('internal_error');
    expect(resolved.message).toBe(
      'An unexpected error occurred. Please try again later.',
    );
    expect(resolved.message).not.toContain('Prisma');
    expect(resolved.message).not.toContain('users.password');
  });

  it('createErrorHandler formats JSON response with request ID and appropriate status', () => {
    const errorHandler = createErrorHandler();
    const req = { id: 'req_test123', path: '/test', method: 'GET' };
    const jsonMock = vi.fn();
    const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    const res = { status: statusMock };
    const next = vi.fn();

    errorHandler(
      new HttpError(404, 'not_found'),
      req as never,
      res as never,
      next,
    );

    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'not_found',
        message: 'The requested endpoint was not found',
        requestId: 'req_test123',
      },
    });
  });
});
