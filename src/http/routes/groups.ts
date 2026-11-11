import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { GroupsService } from '../../application/groups-service.js';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import type { AppConfig } from '../../config/env.js';
import { HttpError } from '../errors.js';
import {
  requireAuth,
  requireUser,
  requireVerifiedEmail,
} from '../middleware/auth.js';
import { loadMembership, requireOwner } from '../middleware/membership.js';

export interface GroupsRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
  readonly config: AppConfig;
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
}

const CreateGroupSchema = z.object({
  name: z.string(),
  monthlyContributionPaisa: z.number(),
  dueDay: z.number(),
});

const UpdateSettingsSchema = z.object({
  name: z.string().optional(),
  dueDay: z.number().optional(),
  monthlyContributionPaisa: z.unknown().optional(),
});

export function createGroupsRouter(deps: GroupsRouteDeps): Router {
  const router = Router();
  const groupsService = new GroupsService({
    prisma: deps.prisma,
    clock: deps.clock,
    idGenerator: deps.idGenerator,
  });

  // POST /v1/groups
  router.post(
    '/v1/groups',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    requireVerifiedEmail(deps.config),
    async (req, res) => {
      const user = req.user;
      if (!user) {
        throw new HttpError(401, 'unauthenticated');
      }

      const idempotencyKey = req.header('idempotency-key');
      if (!idempotencyKey || idempotencyKey.trim().length === 0) {
        throw new HttpError(400, 'idempotency_key_required');
      }

      const body = CreateGroupSchema.parse(req.body);
      const result = await groupsService.createGroup(
        user.id,
        idempotencyKey,
        body,
      );

      if (result.isReplay) {
        res.setHeader('Idempotent-Replay', 'true');
        res.status(result.status || 201).json(result.group);
      } else {
        res.status(201).json(result.group);
      }
    },
  );

  // GET /v1/groups/:groupId
  router.get(
    '/v1/groups/:groupId',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const user = req.user;
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      if (!user || !groupId) {
        throw new HttpError(404, 'group_not_found');
      }

      const group = await groupsService.getGroup(groupId, user.id);
      res.status(200).json(group);
    },
  );

  // PATCH /v1/groups/:groupId/settings
  router.patch(
    '/v1/groups/:groupId/settings',
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

      const body = UpdateSettingsSchema.parse(req.body);
      const updated = await groupsService.updateGroupSettings(
        groupId,
        user.id,
        body,
      );
      res.status(200).json(updated);
    },
  );

  return router;
}
