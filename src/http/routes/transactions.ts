import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import { requireAuth, requireUser } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency-key.js';
import { loadMembership, requireTreasurer } from '../middleware/membership.js';

export interface TransactionsRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
}

export function createTransactionsRouter(deps: TransactionsRouteDeps): Router {
  const router = Router();

  // GET /v1/groups/:groupId/transactions
  router.get(
    '/v1/groups/:groupId/transactions',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    (_req, res) => {
      res.status(200).json({ items: [], nextCursor: null, hasMore: false });
    },
  );

  // GET /v1/groups/:groupId/transactions/:transactionId
  router.get(
    '/v1/groups/:groupId/transactions/:transactionId',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    (_req, res) => {
      res.status(200).json({});
    },
  );

  // POST /v1/groups/:groupId/transactions
  router.post(
    '/v1/groups/:groupId/transactions',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireTreasurer,
    requireIdempotencyKey,
    (_req, res) => {
      res.status(201).json({});
    },
  );

  // POST /v1/groups/:groupId/transactions/:transactionId/reverse
  router.post(
    '/v1/groups/:groupId/transactions/:transactionId/reverse',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireTreasurer,
    requireIdempotencyKey,
    (_req, res) => {
      res.status(201).json({});
    },
  );

  return router;
}
