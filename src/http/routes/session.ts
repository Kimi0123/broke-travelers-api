import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import type { AppConfig } from '../../config/env.js';
import { generateId } from '../../infrastructure/db/ids.js';
import { HttpError } from '../errors.js';
import { requireAuth, requireVerifiedEmail } from '../middleware/auth.js';

export interface SessionRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
  readonly config: AppConfig;
  readonly idGenerator?: (() => string) | undefined;
}

const SessionBodySchema = z.object({
  displayName: z.string().max(50).optional(),
});

export function createSessionRouter(deps: SessionRouteDeps): Router {
  const router = Router();

  router.post(
    '/v1/session',
    requireAuth(deps.tokenVerifier),
    requireVerifiedEmail(deps.config),
    async (req, res) => {
      const auth = req.auth;
      if (!auth) {
        throw new HttpError(401, 'unauthenticated');
      }

      if (!auth.email || auth.email.trim().length === 0) {
        throw new HttpError(400, 'invalid_token_claims');
      }

      const body = SessionBodySchema.parse(req.body ?? {});
      const trimmedBodyName = body.displayName?.trim();
      const fallbackFromEmail = auth.email.split('@')[0] || 'User';

      const displayName =
        trimmedBodyName && trimmedBodyName.length > 0
          ? trimmedBodyName
          : auth.displayName?.trim() || fallbackFromEmail;

      const user = await deps.prisma.user.upsert({
        where: { firebaseUid: auth.uid },
        create: {
          id: deps.idGenerator ? deps.idGenerator() : generateId(),
          firebaseUid: auth.uid,
          displayName,
          email: auth.email,
        },
        update: {
          displayName,
          email: auth.email,
        },
      });

      const memberships = await deps.prisma.groupMembership.findMany({
        where: {
          userId: user.id,
          leftAt: null,
        },
        include: {
          group: true,
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
