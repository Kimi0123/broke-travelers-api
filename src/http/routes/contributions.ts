import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import { requireAuth, requireUser } from '../middleware/auth.js';
import { loadMembership } from '../middleware/membership.js';

export interface ContributionsRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
  readonly clock?: (() => Date) | undefined;
}

export function createContributionsRouter(
  deps: ContributionsRouteDeps,
): Router {
  const router = Router();

  // GET /v1/groups/:groupId/contributions/periods
  router.get(
    '/v1/groups/:groupId/contributions/periods',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    (_req, res) => {
      res.status(200).json([]);
    },
  );

  // GET /v1/groups/:groupId/contributions/periods/:periodId
  router.get(
    '/v1/groups/:groupId/contributions/periods/:periodId',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    (_req, res) => {
      res.status(200).json({});
    },
  );

  return router;
}
