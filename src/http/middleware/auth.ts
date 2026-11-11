import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient, User } from '@prisma/client';
import type {
  TokenVerifier,
  VerifiedTokenClaims,
} from '../../application/ports/token-verifier.js';
import { HttpError } from '../errors.js';

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      auth?: VerifiedTokenClaims;
      user?: User;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

/**
 * Extracts and verifies the Firebase Bearer token from the Authorization header.
 * Attaches verified claims to req.auth.
 */
export function requireAuth(verifier: TokenVerifier) {
  return async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const authHeader = req.header('authorization');
    if (!authHeader) {
      throw new HttpError(401, 'unauthenticated');
    }

    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!match || !match[1]) {
      throw new HttpError(401, 'unauthenticated');
    }

    const token = match[1];
    try {
      const claims = await verifier.verifyIdToken(token);
      req.auth = claims;
      next();
    } catch {
      throw new HttpError(401, 'unauthenticated');
    }
  };
}

/**
 * Ensures the authenticated Firebase user has a provisioned database record.
 * Attaches the database user to req.user.
 */
export function requireUser(prisma: PrismaClient) {
  return async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (!req.auth?.uid) {
      throw new HttpError(401, 'unauthenticated');
    }

    const user = await prisma.user.findUnique({
      where: { firebaseUid: req.auth.uid },
    });

    if (!user) {
      throw new HttpError(401, 'user_not_provisioned');
    }

    req.user = user;
    next();
  };
}

/**
 * Enforces email verification policy.
 * If REQUIRE_VERIFIED_EMAIL is active and the token claim emailVerified is false,
 * rejects with 403 email_not_verified.
 */
export function requireVerifiedEmail(config: {
  readonly REQUIRE_VERIFIED_EMAIL: boolean;
}) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (config.REQUIRE_VERIFIED_EMAIL && !req.auth?.emailVerified) {
      throw new HttpError(403, 'email_not_verified');
    }
    next();
  };
}
