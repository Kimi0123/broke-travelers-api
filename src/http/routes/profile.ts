import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import { HttpError } from '../errors.js';
import { requireAuth, requireUser } from '../middleware/auth.js';

export interface ProfileRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
}

export function createProfileRouter(deps: ProfileRouteDeps): Router {
  const router = Router();

  router.get(
    '/v1/profile',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    async (req, res) => {
      const user = req.user;
      if (!user) {
        throw new HttpError(401, 'user_not_provisioned');
      }

      const memberships = await deps.prisma.groupMembership.findMany({
        where: {
          userId: user.id,
          leftAt: null,
        },
        include: {
          group: {
            include: {
              _count: {
                select: {
                  memberships: {
                    where: { leftAt: null },
                  },
                },
              },
            },
          },
        },
        orderBy: {
          joinedAt: 'asc',
        },
      });

      const groups = memberships.map((m) => ({
        id: m.group.id,
        name: m.group.name,
        role: m.isOwner ? 'owner' : 'member',
        isTreasurer: m.isTreasurer,
        monthlyContributionPaisa: Number(m.group.expectedPaisa),
        dueDay: m.group.dueDay,
        memberCount: m.group._count.memberships,
        joinedAt: m.joinedAt.toISOString(),
      }));

      res.status(200).json({
        user: {
          id: user.id,
          name: user.displayName,
          email: user.email,
        },
        groups,
      });
    },
  );

  return router;
}
