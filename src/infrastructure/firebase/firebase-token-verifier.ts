import type { ServiceAccount } from 'firebase-admin';
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from 'firebase-admin/app';
import { type Auth, type DecodedIdToken, getAuth } from 'firebase-admin/auth';
import {
  AuthenticationError,
  type TokenVerifier,
  type VerifiedTokenClaims,
} from '../../application/ports/token-verifier.js';

export interface FirebaseVerifierConfig {
  readonly firebaseProjectId?: string | undefined;
  readonly firebaseServiceAccountJson?: string | undefined;
}

export class FirebaseTokenVerifier implements TokenVerifier {
  private readonly auth: Auth;

  constructor(config: FirebaseVerifierConfig) {
    if (getApps().length === 0) {
      if (config.firebaseServiceAccountJson) {
        const serviceAccount = JSON.parse(
          config.firebaseServiceAccountJson,
        ) as ServiceAccount;
        const projectId = config.firebaseProjectId ?? serviceAccount.projectId;
        initializeApp({
          credential: cert(serviceAccount),
          ...(projectId ? { projectId } : {}),
        });
      } else if (config.firebaseProjectId) {
        initializeApp({
          credential: applicationDefault(),
          projectId: config.firebaseProjectId,
        });
      } else {
        throw new Error(
          'FirebaseTokenVerifier requires either FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_PROJECT_ID',
        );
      }
    }

    this.auth = getAuth();
  }

  async verifyIdToken(token: string): Promise<VerifiedTokenClaims> {
    try {
      // checkRevoked is explicitly set to false:
      // Firebase ID tokens are short-lived (1-hour) cryptographic JWTs verified locally using
      // Google public keys. Setting checkRevoked=true forces a blocking remote HTTPS round-trip
      // to Firebase servers on every authenticated request, which introduces substantial network
      // latency and tight remote coupling on high-throughput endpoints.
      const decoded: DecodedIdToken = await this.auth.verifyIdToken(
        token,
        false,
      );
      return {
        uid: decoded.uid,
        email: typeof decoded.email === 'string' ? decoded.email : null,
        emailVerified: Boolean(decoded.email_verified),
        displayName:
          typeof decoded['name'] === 'string' ? decoded['name'] : null,
      };
    } catch (err: unknown) {
      throw new AuthenticationError(
        err instanceof Error ? err.message : 'Invalid ID token',
      );
    }
  }
}
