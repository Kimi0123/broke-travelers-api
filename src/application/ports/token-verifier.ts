import { ApplicationError } from '../errors.js';

export interface VerifiedTokenClaims {
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
}

export class AuthenticationError extends ApplicationError {
  readonly code = 'unauthenticated';
  readonly statusCode = 401;

  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export interface TokenVerifier {
  verifyIdToken(token: string): Promise<VerifiedTokenClaims>;
}
