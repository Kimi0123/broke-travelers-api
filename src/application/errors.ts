/**
 * Base application error class for business and workflow failures.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class InvalidInputError extends ApplicationError {
  readonly code = 'invalid_input';
  readonly statusCode = 400;
}

export class InsufficientBalanceError extends ApplicationError {
  readonly code = 'insufficient_balance';
  readonly statusCode = 409;
}

export class DuplicateReferenceError extends ApplicationError {
  readonly code = 'duplicate_reference';
  readonly statusCode = 409;
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'idempotency_conflict';
  readonly statusCode = 409;
}

export class PermissionDeniedError extends ApplicationError {
  readonly code = 'permission_denied';
  readonly statusCode = 403;
}

export class NotFoundError extends ApplicationError {
  readonly code = 'not_found';
  readonly statusCode = 404;
}

export class ReversalNotAllowedError extends ApplicationError {
  readonly code = 'reversal_not_allowed';
  readonly statusCode = 400;
}

export class InvalidStatusTransitionError extends ApplicationError {
  readonly code = 'invalid_status_transition';
  readonly statusCode = 409;
}
