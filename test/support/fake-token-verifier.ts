import {
  AuthenticationError,
  type TokenVerifier,
  type VerifiedTokenClaims,
} from '../../src/application/ports/token-verifier.js';

export class FakeTokenVerifier implements TokenVerifier {
  private readonly tokenMap = new Map<string, VerifiedTokenClaims>();

  constructor() {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('FakeTokenVerifier cannot be instantiated in production');
    }
  }

  setClaims(token: string, claims: VerifiedTokenClaims): void {
    this.tokenMap.set(token, claims);
  }

  static createToken(
    uid: string,
    email = `${uid}@example.com`,
    emailVerified = true,
    displayName: string | null = uid,
  ): string {
    return `test:${uid}:${email}:${emailVerified ? 'true' : 'false'}:${displayName ?? ''}`;
  }

  verifyIdToken(token: string): Promise<VerifiedTokenClaims> {
    if (!token || token === 'invalid') {
      return Promise.reject(new AuthenticationError('Invalid ID token'));
    }

    const registered = this.tokenMap.get(token);
    if (registered) {
      return Promise.resolve(registered);
    }

    if (!token.startsWith('test:')) {
      return Promise.reject(
        new AuthenticationError('Invalid test token prefix'),
      );
    }

    const parts = token.split(':');
    const uid = parts[1];
    if (!uid) {
      return Promise.reject(new AuthenticationError('Invalid token format'));
    }

    const email = parts[2] && parts[2].length > 0 ? parts[2] : null;
    const emailVerified = parts[3] === 'true';
    const displayName = parts[4] && parts[4].length > 0 ? parts[4] : null;

    return Promise.resolve({
      uid,
      email,
      emailVerified,
      displayName,
    });
  }
}
