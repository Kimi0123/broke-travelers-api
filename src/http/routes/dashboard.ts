import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { getDashboardSummary } from '../../application/dashboard-service.js';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import { HttpError } from '../errors.js';
import { requireAuth, requireUser } from '../middleware/auth.js';
import { loadMembership } from '../middleware/membership.js';
import { dashboardSummaryResponseSchema } from '../schemas/dashboard.js';

export interface DashboardRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
  readonly clock?: (() => Date) | undefined;
}

export function createDashboardRouter(deps: DashboardRouteDeps): Router {
  const router = Router();

  // GET /v1/groups/:groupId/dashboard
  router.get(
    '/v1/groups/:groupId/dashboard',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      if (!groupId) {
        throw new HttpError(404, 'group_not_found');
      }

      res.setHeader('Cache-Control', 'no-store');

      const now = deps.clock ? deps.clock() : new Date();
      const summary = await getDashboardSummary(deps.prisma, {
        groupId,
        viewerUserId: req.user!.id,
        viewerMembershipId: req.membership!.membershipId,
        isTreasurer: req.membership!.isTreasurer,
        isOwner: req.membership!.isOwner,
        now,
      });

      const response = dashboardSummaryResponseSchema.parse(summary);
      res.status(200).json(response);
    },
  );

  return router;
}
