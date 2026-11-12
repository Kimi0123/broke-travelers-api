import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import { requireAuth, requireUser } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency-key.js';
import { loadMembership, requireTreasurer } from '../middleware/membership.js';

export interface PaymentsRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
}

export function createPaymentsRouter(deps: PaymentsRouteDeps): Router {
  const router = Router();

  // POST /v1/groups/:groupId/payments
  router.post(
    '/v1/groups/:groupId/payments',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireIdempotencyKey,
    (_req, res) => {
      res.status(201).json({});
    },
  );

  // GET /v1/groups/:groupId/payments/my
  router.get(
    '/v1/groups/:groupId/payments/my',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    (_req, res) => {
      res.status(200).json([]);
    },
  );

  // GET /v1/groups/:groupId/payments/pending
  router.get(
    '/v1/groups/:groupId/payments/pending',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireTreasurer,
    (_req, res) => {
      res.status(200).json([]);
    },
  );

  // POST /v1/groups/:groupId/payments/:submissionId/verify
  router.post(
    '/v1/groups/:groupId/payments/:submissionId/verify',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireTreasurer,
    requireIdempotencyKey,
    (_req, res) => {
      res.status(200).json({});
    },
  );

  // POST /v1/groups/:groupId/payments/:submissionId/reject
  router.post(
    '/v1/groups/:groupId/payments/:submissionId/reject',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireTreasurer,
    requireIdempotencyKey,
    (_req, res) => {
      res.status(200).json({});
    },
  );

  return router;
}
