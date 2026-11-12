import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { PaymentsService } from '../../application/payments-service.js';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import { HttpError } from '../errors.js';
import { requireAuth, requireUser } from '../middleware/auth.js';
import {
  extractIdempotencyKey,
  requireIdempotencyKey,
} from '../middleware/idempotency-key.js';
import { loadMembership, requireTreasurer } from '../middleware/membership.js';
import { submitPaymentRequestSchema } from '../schemas/financial.js';

export interface PaymentsRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
}

export function createPaymentsRouter(deps: PaymentsRouteDeps): Router {
  const router = Router();
  const service = new PaymentsService(
    deps.prisma,
    deps.clock,
    deps.idGenerator,
  );

  // POST /v1/groups/:groupId/payments
  router.post(
    '/v1/groups/:groupId/payments',
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
      if (
        body &&
        (body['amount'] !== undefined || body['amountPaisa'] !== undefined)
      ) {
        throw new HttpError(
          400,
          'invalid_payment_input',
          'Client cannot supply payment amount',
        );
      }

      const parsed = submitPaymentRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_payment_input', parsed.error.message);
      }

      const idempotencyKey = extractIdempotencyKey(req);
      const result = await service.submitPayment({
        groupId,
        actorUserId: user.id,
        memberId: membership.membershipId,
        periodId: parsed.data.periodId,
        method: parsed.data.method,
        reference: parsed.data.reference,
        note: parsed.data.note,
        idempotencyKey,
      });

      if (result.isReplay) {
        res.setHeader('Idempotent-Replay', 'true');
      }
      res.status(201).json(result.submission);
    },
  );

  // GET /v1/groups/:groupId/payments/my
  router.get(
    '/v1/groups/:groupId/payments/my',
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

      const items = await service.getMyPayments(
        groupId,
        membership.membershipId,
      );
      res.status(200).json(items);
    },
  );

  // GET /v1/groups/:groupId/payments/pending
  router.get(
    '/v1/groups/:groupId/payments/pending',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireTreasurer,
    async (req, res) => {
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      const membership = req.membership;

      if (!groupId || !membership) {
        throw new HttpError(404, 'group_not_found');
      }

      const items = await service.getPendingReviews(
        groupId,
        membership.membershipId,
      );
      res.status(200).json(items);
    },
  );

  // POST /v1/groups/:groupId/payments/:submissionId/verify
  router.post(
    '/v1/groups/:groupId/payments/:submissionId/verify',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireTreasurer,
    requireIdempotencyKey,
    (_req, res) => {
      res.status(200).json({});
    },
  );

  // POST /v1/groups/:groupId/payments/:submissionId/reject
  router.post(
    '/v1/groups/:groupId/payments/:submissionId/reject',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireTreasurer,
    requireIdempotencyKey,
    (_req, res) => {
      res.status(200).json({});
    },
  );

  return router;
}
