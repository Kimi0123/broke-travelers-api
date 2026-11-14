import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { ApprovalsService } from '../../application/approvals-service.js';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import { HttpError } from '../errors.js';
import { parsePaginationParams } from '../helpers/pagination.js';
import { requireAuth, requireUser } from '../middleware/auth.js';
import {
  extractIdempotencyKey,
  requireIdempotencyKey,
} from '../middleware/idempotency-key.js';
import { loadMembership, requireTreasurer } from '../middleware/membership.js';
import {
  createApprovalRequestSchema,
  executeApprovalRequestSchema,
  voteApprovalRequestSchema,
} from '../schemas/approvals.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApprovalsRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
}

export function createApprovalsRouter(deps: ApprovalsRouteDeps): Router {
  const router = Router();
  const service = new ApprovalsService(
    deps.prisma,
    deps.clock,
    deps.idGenerator,
  );

  // POST /v1/groups/:groupId/approvals (Create approval request)
  router.post(
    '/v1/groups/:groupId/approvals',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireIdempotencyKey,
    async (req, res) => {
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      const user = req.user;
      const membership = req.membership;

      if (!groupId || !user || !membership) {
        throw new HttpError(404, 'group_not_found');
      }

      const body = req.body as Record<string, unknown> | null;
      if (body && (body['id'] !== undefined || body['status'] !== undefined)) {
        throw new HttpError(
          400,
          'invalid_approval_input',
          'Client cannot supply computed or id fields',
        );
      }

      const parsed = createApprovalRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          'invalid_approval_input',
          parsed.error.message,
        );
      }

      const idempotencyKey = extractIdempotencyKey(req);
      const result = await service.createApproval({
        groupId,
        actorUserId: user.id,
        memberId: membership.membershipId,
        kind: parsed.data.kind,
        title: parsed.data.title,
        payee: parsed.data.payee,
        description: parsed.data.description,
        amountPaisa: parsed.data.amountPaisa,
        idempotencyKey,
      });

      if (result.isReplay) {
        res.setHeader('Idempotent-Replay', 'true');
      }
      res.status(201).json(result.approval);
    },
  );

  // GET /v1/groups/:groupId/approvals (List approvals)
  router.get(
    '/v1/groups/:groupId/approvals',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      const membership = req.membership;

      if (!groupId || !membership) {
        throw new HttpError(404, 'group_not_found');
      }

      const { limit, cursor } = parsePaginationParams(req.query);
      const rawStatus = req.query['status'];
      const statusStr = Array.isArray(rawStatus) ? rawStatus[0] : rawStatus;
      const status = typeof statusStr === 'string' ? statusStr : undefined;

      const result = await service.listApprovals({
        groupId,
        viewerMemberId: membership.membershipId,
        limit,
        cursor: cursor ? cursor.id : null,
        status,
      });

      res.status(200).json(result);
    },
  );

  // GET /v1/groups/:groupId/approvals/:approvalId (Detail)
  router.get(
    '/v1/groups/:groupId/approvals/:approvalId',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      const rawApprovalId = req.params['approvalId'];
      const approvalId = Array.isArray(rawApprovalId)
        ? rawApprovalId[0]
        : rawApprovalId;
      const membership = req.membership;

      if (!groupId || !approvalId || !membership) {
        throw new HttpError(404, 'approval_not_found');
      }

      if (!UUID_REGEX.test(approvalId)) {
        throw new HttpError(404, 'approval_not_found');
      }

      const result = await service.getApproval({
        groupId,
        approvalId,
        viewerMemberId: membership.membershipId,
      });

      res.status(200).json(result);
    },
  );

  // Handler for vote logic
  const handleVote = async (req: Request, res: Response) => {
    const rawGroupId = req.params['groupId'];
    const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
    const rawApprovalId = req.params['approvalId'];
    const approvalId = Array.isArray(rawApprovalId)
      ? rawApprovalId[0]
      : rawApprovalId;
    const user = req.user;
    const membership = req.membership;

    if (!groupId || !approvalId || !user || !membership) {
      throw new HttpError(404, 'approval_not_found');
    }

    if (!UUID_REGEX.test(approvalId)) {
      throw new HttpError(404, 'approval_not_found');
    }

    const parsed = voteApprovalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_approval_input', parsed.error.message);
    }

    let vote: 'approve' | 'reject';
    if (parsed.data.vote) {
      vote = parsed.data.vote;
    } else {
      vote = parsed.data.approve ? 'approve' : 'reject';
    }

    const idempotencyKey = extractIdempotencyKey(req);
    const result = await service.vote({
      groupId,
      approvalId,
      actorUserId: user.id,
      memberId: membership.membershipId,
      vote,
      idempotencyKey,
    });

    if (result.isReplay) {
      res.setHeader('Idempotent-Replay', 'true');
    }
    res.status(200).json(result.approval);
  };

  // POST /v1/groups/:groupId/approvals/:approvalId/votes
  router.post(
    '/v1/groups/:groupId/approvals/:approvalId/votes',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireIdempotencyKey,
    handleVote,
  );

  // POST /v1/groups/:groupId/approvals/:approvalId/vote (alias)
  router.post(
    '/v1/groups/:groupId/approvals/:approvalId/vote',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireIdempotencyKey,
    handleVote,
  );

  // POST /v1/groups/:groupId/approvals/:approvalId/cancel
  router.post(
    '/v1/groups/:groupId/approvals/:approvalId/cancel',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireIdempotencyKey,
    async (req, res) => {
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      const rawApprovalId = req.params['approvalId'];
      const approvalId = Array.isArray(rawApprovalId)
        ? rawApprovalId[0]
        : rawApprovalId;
      const user = req.user;
      const membership = req.membership;

      if (!groupId || !approvalId || !user || !membership) {
        throw new HttpError(404, 'approval_not_found');
      }

      if (!UUID_REGEX.test(approvalId)) {
        throw new HttpError(404, 'approval_not_found');
      }

      const idempotencyKey = extractIdempotencyKey(req);
      const result = await service.cancelApproval({
        groupId,
        approvalId,
        actorUserId: user.id,
        memberId: membership.membershipId,
        idempotencyKey,
      });

      if (result.isReplay) {
        res.setHeader('Idempotent-Replay', 'true');
      }
      res.status(200).json(result.approval);
    },
  );

  // POST /v1/groups/:groupId/approvals/:approvalId/execute (Treasurer only)
  router.post(
    '/v1/groups/:groupId/approvals/:approvalId/execute',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireTreasurer,
    requireIdempotencyKey,
    async (req, res) => {
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      const rawApprovalId = req.params['approvalId'];
      const approvalId = Array.isArray(rawApprovalId)
        ? rawApprovalId[0]
        : rawApprovalId;
      const user = req.user;
      const membership = req.membership;

      if (!groupId || !approvalId || !user || !membership) {
        throw new HttpError(404, 'approval_not_found');
      }

      if (!UUID_REGEX.test(approvalId)) {
        throw new HttpError(404, 'approval_not_found');
      }

      // Reject client-sent amount/title
      const body = req.body as Record<string, unknown> | null;
      if (
        body &&
        (body['amount'] !== undefined ||
          body['amountPaisa'] !== undefined ||
          body['title'] !== undefined ||
          body['payee'] !== undefined)
      ) {
        throw new HttpError(
          400,
          'invalid_approval_input',
          'Execution amount and title come only from the approval request',
        );
      }

      const parsed = executeApprovalRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(
          400,
          'invalid_approval_input',
          parsed.error.message,
        );
      }

      const idempotencyKey = extractIdempotencyKey(req);
      const result = await service.executeApproval({
        groupId,
        approvalId,
        actorUserId: user.id,
        memberId: membership.membershipId,
        method: parsed.data.method,
        idempotencyKey,
      });

      if (result.isReplay) {
        res.setHeader('Idempotent-Replay', 'true');
      }
      res.status(200).json(result.approval);
    },
  );

  return router;
}
