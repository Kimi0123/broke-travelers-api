import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AuthenticationError } from '../../src/application/ports/token-verifier.js';
import { HttpError } from '../../src/http/errors.js';
import {
  requireAuth,
  requireUser,
  requireVerifiedEmail,
} from '../../src/http/middleware/auth.js';
import { FirebaseTokenVerifier } from '../../src/infrastructure/firebase/firebase-token-verifier.js';
import { FakeTokenVerifier } from '../support/fake-token-verifier.js';

describe('FakeTokenVerifier', () => {
  it('parses structured test tokens correctly', async () => {
    const verifier = new FakeTokenVerifier();
    const token = FakeTokenVerifier.createToken(
      'user-123',
      'user@example.com',
      true,
      'Test User',
    );

    const claims = await verifier.verifyIdToken(token);
    expect(claims.uid).toBe('user-123');
    expect(claims.email).toBe('user@example.com');
    expect(claims.emailVerified).toBe(true);
    expect(claims.displayName).toBe('Test User');
  });

  it('rejects invalid or non-test tokens with AuthenticationError', async () => {
    const verifier = new FakeTokenVerifier();

    await expect(verifier.verifyIdToken('invalid')).rejects.toThrow(
      AuthenticationError,
    );
    await expect(verifier.verifyIdToken('some-random-token')).rejects.toThrow(
      AuthenticationError,
    );
    await expect(verifier.verifyIdToken('')).rejects.toThrow(
      AuthenticationError,
    );
  });

  it('allows manual claim overrides via setClaims', async () => {
    const verifier = new FakeTokenVerifier();
    verifier.setClaims('custom-token', {
      uid: 'custom-uid',
      email: 'custom@example.com',
      emailVerified: false,
      displayName: 'Custom User',
    });

    const claims = await verifier.verifyIdToken('custom-token');
    expect(claims.uid).toBe('custom-uid');
    expect(claims.emailVerified).toBe(false);
  });

  it('fails to instantiate when NODE_ENV is production', () => {
    const originalEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';

    expect(() => new FakeTokenVerifier()).toThrow(
      /cannot be instantiated in production/,
    );

    process.env['NODE_ENV'] = originalEnv;
  });
});

describe('FirebaseTokenVerifier (Integration Guard)', () => {
  it.skipIf(!process.env['FIREBASE_SERVICE_ACCOUNT_JSON'])(
    'initializes when credentials are provided',
    () => {
      const verifier = new FirebaseTokenVerifier({
        firebaseServiceAccountJson:
          process.env['FIREBASE_SERVICE_ACCOUNT_JSON'],
      });
      expect(verifier).toBeDefined();
    },
  );
});

describe('Auth Middleware', () => {
  describe('requireAuth', () => {
    it('rejects missing Authorization header with 401 unauthenticated', async () => {
      const verifier = new FakeTokenVerifier();
      const middleware = requireAuth(verifier);
      const req = { header: vi.fn().mockReturnValue(undefined) };
      const next = vi.fn();

      await expect(
        middleware(req as never, {} as never, next),
      ).rejects.toMatchObject({
        status: 401,
        code: 'unauthenticated',
      });
    });

    it('rejects invalid Bearer prefix with 401 unauthenticated', async () => {
      const verifier = new FakeTokenVerifier();
      const middleware = requireAuth(verifier);
      const req = { header: vi.fn().mockReturnValue('Basic dXNlcjpwYXNz') };
      const next = vi.fn();

      await expect(
        middleware(req as never, {} as never, next),
      ).rejects.toMatchObject({
        status: 401,
        code: 'unauthenticated',
      });
    });

    it('attaches verified claims to req.auth on valid token', async () => {
      const verifier = new FakeTokenVerifier();
      const token = FakeTokenVerifier.createToken('u-1', 'u1@test.com', true);
      const middleware = requireAuth(verifier);
      const req: { header: () => string; auth?: unknown } = {
        header: () => `Bearer ${token}`,
      };
      const next = vi.fn();

      await middleware(req as never, {} as never, next);
      expect(req.auth).toEqual({
        uid: 'u-1',
        email: 'u1@test.com',
        emailVerified: true,
        displayName: 'u-1',
      });
      expect(next).toHaveBeenCalled();
    });
  });

  describe('requireUser', () => {
    it('throws 401 unauthenticated if req.auth is absent', async () => {
      const middleware = requireUser({} as PrismaClient);
      const req = {};
      const next = vi.fn();

      await expect(
        middleware(req as never, {} as never, next),
      ).rejects.toMatchObject({
        status: 401,
        code: 'unauthenticated',
      });
    });

    it('throws 401 user_not_provisioned if user not in database', async () => {
      const prismaMock = {
        user: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      } as unknown as PrismaClient;

      const middleware = requireUser(prismaMock);
      const req = { auth: { uid: 'unprovisioned-uid' } };
      const next = vi.fn();

      await expect(
        middleware(req as never, {} as never, next),
      ).rejects.toMatchObject({
        status: 401,
        code: 'user_not_provisioned',
      });
    });

    it('attaches user to req.user if found', async () => {
      const fakeUser = {
        id: 'user-uuid',
        firebaseUid: 'provisioned-uid',
        email: 'p@test.com',
        displayName: 'Provisioned',
      };
      const prismaMock = {
        user: {
          findUnique: vi.fn().mockResolvedValue(fakeUser),
        },
      } as unknown as PrismaClient;

      const middleware = requireUser(prismaMock);
      const req: { auth: { uid: string }; user?: unknown } = {
        auth: { uid: 'provisioned-uid' },
      };
      const next = vi.fn();

      await middleware(req as never, {} as never, next);
      expect(req.user).toEqual(fakeUser);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('requireVerifiedEmail', () => {
    it('allows through when REQUIRE_VERIFIED_EMAIL is false', () => {
      const middleware = requireVerifiedEmail({
        REQUIRE_VERIFIED_EMAIL: false,
      });
      const req = { auth: { emailVerified: false } };
      const next = vi.fn();

      middleware(req as never, {} as never, next);
      expect(next).toHaveBeenCalled();
    });

    it('throws 403 email_not_verified when REQUIRE_VERIFIED_EMAIL is true and emailVerified is false', () => {
      const middleware = requireVerifiedEmail({ REQUIRE_VERIFIED_EMAIL: true });
      const req = { auth: { emailVerified: false } };
      const next = vi.fn();

      expect(() => middleware(req as never, {} as never, next)).toThrowError(
        HttpError,
      );
    });

    it('allows through when REQUIRE_VERIFIED_EMAIL is true and emailVerified is true', () => {
      const middleware = requireVerifiedEmail({ REQUIRE_VERIFIED_EMAIL: true });
      const req = { auth: { emailVerified: true } };
      const next = vi.fn();

      middleware(req as never, {} as never, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
