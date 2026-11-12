import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { MembersService } from '../../application/members-service.js';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import { HttpError } from '../errors.js';
import { requireAuth, requireUser } from '../middleware/auth.js';
import { loadMembership, requireOwner } from '../middleware/membership.js';

export interface MembersRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
}

const UpdateRoleSchema = z.object({
  isTreasurer: z.boolean(),
});

export function createMembersRouter(deps: MembersRouteDeps): Router {
  const router = Router();
  const membersService = new MembersService({
    prisma: deps.prisma,
    clock: deps.clock,
    idGenerator: deps.idGenerator,
  });

  // GET /v1/groups/:groupId/members
  router.get(
    '/v1/groups/:groupId/members',
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

      const members = await membersService.listMembers(groupId, user.id);
      res.status(200).json(members);
    },
  );

  // PATCH /v1/groups/:groupId/members/:memberId/role
  router.patch(
    '/v1/groups/:groupId/members/:memberId/role',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireOwner,
    async (req, res) => {
      const user = req.user;
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      const rawMemberId = req.params['memberId'];
      const memberId = Array.isArray(rawMemberId)
        ? rawMemberId[0]
        : rawMemberId;

      if (!user || !groupId || !memberId) {
        throw new HttpError(404, 'group_not_found');
      }

      const body = UpdateRoleSchema.parse(req.body);
      const updated = await membersService.updateMemberRole(
        groupId,
        memberId,
        user.id,
        body,
      );
      res.status(200).json(updated);
    },
  );

  // DELETE /v1/groups/:groupId/members/:memberId
  router.delete(
    '/v1/groups/:groupId/members/:memberId',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireOwner,
    async (req, res) => {
      const user = req.user;
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      const rawMemberId = req.params['memberId'];
      const memberId = Array.isArray(rawMemberId)
        ? rawMemberId[0]
        : rawMemberId;

      if (!user || !groupId || !memberId) {
        throw new HttpError(404, 'group_not_found');
      }

      await membersService.removeMember(groupId, memberId, user.id);
      res.status(204).send();
    },
  );

  return router;
}
