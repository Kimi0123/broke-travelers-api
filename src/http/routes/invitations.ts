import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { InvitationsService } from '../../application/invitations-service.js';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import type { AppConfig } from '../../config/env.js';
import { HttpError } from '../errors.js';
import {
  requireAuth,
  requireUser,
  requireVerifiedEmail,
} from '../middleware/auth.js';
import { extractIdempotencyKey } from '../middleware/idempotency-key.js';
import { loadMembership, requireOwner } from '../middleware/membership.js';

export interface InvitationsRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
  readonly config: AppConfig;
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
}

const AcceptInvitationSchema = z.object({
  code: z.string(),
});

export function createInvitationsRouter(deps: InvitationsRouteDeps): Router {
  const router = Router();
  const invitationsService = new InvitationsService({
    prisma: deps.prisma,
    clock: deps.clock,
    idGenerator: deps.idGenerator,
  });

  // POST /v1/groups/:groupId/invitations
  router.post(
    '/v1/groups/:groupId/invitations',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireOwner,
    async (req, res) => {
      const user = req.user;
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      if (!user || !groupId) {
        throw new HttpError(404, 'group_not_found');
      }

      const idempotencyKey = extractIdempotencyKey(req);

      const result = await invitationsService.createInvitation(
        groupId,
        user.id,
        idempotencyKey,
      );

      if (result.isReplay) {
        res.setHeader('Idempotent-Replay', 'true');
        res.status(result.status || 201).json(result.invitation);
      } else {
        res.status(201).json(result.invitation);
      }
    },
  );

  // GET /v1/groups/:groupId/invitations
  router.get(
    '/v1/groups/:groupId/invitations',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireOwner,
    async (req, res) => {
      const user = req.user;
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      if (!user || !groupId) {
        throw new HttpError(404, 'group_not_found');
      }

      const invitations = await invitationsService.getInvitations(
        groupId,
        user.id,
      );
      res.status(200).json(invitations);
    },
  );

  // DELETE /v1/groups/:groupId/invitations/:invitationId
  router.delete(
    '/v1/groups/:groupId/invitations/:invitationId',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireOwner,
    async (req, res) => {
      const user = req.user;
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      const rawInvitationId = req.params['invitationId'];
      const invitationId = Array.isArray(rawInvitationId)
        ? rawInvitationId[0]
        : rawInvitationId;

      if (!user || !groupId || !invitationId) {
        throw new HttpError(404, 'not_found');
      }

      await invitationsService.revokeInvitation(groupId, invitationId, user.id);
      res.status(204).send();
    },
  );

  // POST /v1/invitations/accept
  router.post(
    '/v1/invitations/accept',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    requireVerifiedEmail(deps.config),
    async (req, res) => {
      const user = req.user;
      if (!user) {
        throw new HttpError(401, 'unauthenticated');
      }

      const idempotencyKey = extractIdempotencyKey(req);

      const body = AcceptInvitationSchema.parse(req.body);
      const result = await invitationsService.acceptInvitation(
        user.id,
        idempotencyKey,
        body.code,
      );

      if (result.isReplay) {
        res.setHeader('Idempotent-Replay', 'true');
        res.status(result.status || 200).json(result.data);
      } else {
        res.status(200).json(result.data);
      }
    },
  );

  return router;
}
