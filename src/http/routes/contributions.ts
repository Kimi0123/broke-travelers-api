import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { ContributionsService } from '../../application/contributions-service.js';
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
  const service = new ContributionsService(deps.prisma, deps.clock);

  // GET /v1/groups/:groupId/contributions/periods
  router.get(
    '/v1/groups/:groupId/contributions/periods',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      const userId = req.user!.id;
      const periods = await service.listPeriods(groupId!, userId);
      res.status(200).json(periods);
    },
  );

  // GET /v1/groups/:groupId/contributions/periods/:periodId
  router.get(
    '/v1/groups/:groupId/contributions/periods/:periodId',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      const rawPeriodId = req.params['periodId'];
      const periodId = Array.isArray(rawPeriodId)
        ? rawPeriodId[0]
        : rawPeriodId;
      const userId = req.user!.id;
      const detail = await service.getPeriodDetail(groupId!, periodId!, userId);
      res.status(200).json(detail);
    },
  );

  return router;
}
