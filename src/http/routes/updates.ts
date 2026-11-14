import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import {
  getUnreadUpdatesCount,
  getUpdatesFeed,
  markAllUpdatesRead,
  markUpdatesRead,
} from '../../application/updates-service.js';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import { HttpError } from '../errors.js';
import { requireAuth, requireUser } from '../middleware/auth.js';
import { loadMembership } from '../middleware/membership.js';
import {
  markUpdatesReadRequestSchema,
  markUpdatesReadResponseSchema,
  unreadUpdatesCountResponseSchema,
  updatesResponseSchema,
} from '../schemas/updates.js';

export interface UpdatesRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
  readonly clock?: (() => Date) | undefined;
}

export function createUpdatesRouter(deps: UpdatesRouteDeps): Router {
  const router = Router();

  function requireGroupId(raw: unknown): string {
    const groupId = Array.isArray(raw) ? (raw[0] as unknown) : raw;
    if (typeof groupId !== 'string' || groupId.length === 0) {
      throw new HttpError(404, 'group_not_found');
    }
    return groupId;
  }

  // GET /v1/groups/:groupId/updates
  router.get(
    '/v1/groups/:groupId/updates',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const groupId = requireGroupId(req.params['groupId']);
      res.setHeader('Cache-Control', 'no-store');

      const now = deps.clock ? deps.clock() : new Date();
      const updates = await getUpdatesFeed(deps.prisma, {
        groupId,
        viewerUserId: req.user!.id,
        viewerMemberId: req.membership!.membershipId,
        isTreasurer: req.membership!.isTreasurer,
        now,
      });

      const response = updatesResponseSchema.parse({ updates });
      res.status(200).json(response);
    },
  );

  // POST /v1/groups/:groupId/updates/read
  router.post(
    '/v1/groups/:groupId/updates/read',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const groupId = requireGroupId(req.params['groupId']);

      const parsed = markUpdatesReadRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_request', parsed.error.message);
      }

      const result = await markUpdatesRead(deps.prisma, {
        groupId,
        userId: req.user!.id,
        ids: parsed.data.ids,
      });

      const response = markUpdatesReadResponseSchema.parse(result);
      res.status(200).json(response);
    },
  );

  // POST /v1/groups/:groupId/updates/read-all
  router.post(
    '/v1/groups/:groupId/updates/read-all',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const groupId = requireGroupId(req.params['groupId']);

      const now = deps.clock ? deps.clock() : new Date();
      const result = await markAllUpdatesRead(deps.prisma, {
        groupId,
        viewerUserId: req.user!.id,
        viewerMemberId: req.membership!.membershipId,
        isTreasurer: req.membership!.isTreasurer,
        now,
      });

      const response = markUpdatesReadResponseSchema.parse(result);
      res.status(200).json(response);
    },
  );

  // GET /v1/groups/:groupId/updates/unread-count
  router.get(
    '/v1/groups/:groupId/updates/unread-count',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const groupId = requireGroupId(req.params['groupId']);
      res.setHeader('Cache-Control', 'no-store');

      const now = deps.clock ? deps.clock() : new Date();
      const result = await getUnreadUpdatesCount(deps.prisma, {
        groupId,
        viewerUserId: req.user!.id,
        viewerMemberId: req.membership!.membershipId,
        isTreasurer: req.membership!.isTreasurer,
        now,
      });

      const response = unreadUpdatesCountResponseSchema.parse(result);
      res.status(200).json(response);
    },
  );

  return router;
}
