import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { ReconciliationService } from '../../application/reconciliation-service.js';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import { HttpError } from '../errors.js';
import { requireAuth, requireUser } from '../middleware/auth.js';
import {
  extractIdempotencyKey,
  requireIdempotencyKey,
} from '../middleware/idempotency-key.js';
import { loadMembership, requireTreasurer } from '../middleware/membership.js';
import { recordReconciliationRequestSchema } from '../schemas/reconciliations.js';

export interface ReconciliationsRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
}

export function createReconciliationsRouter(
  deps: ReconciliationsRouteDeps,
): Router {
  const router = Router();
  const service = new ReconciliationService(
    deps.prisma,
    deps.clock,
    deps.idGenerator,
  );

  // GET /v1/groups/:groupId/reconciliations/recorded-balance?date=YYYY-MM-DD
  router.get(
    '/v1/groups/:groupId/reconciliations/recorded-balance',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      if (!groupId) {
        throw new HttpError(404, 'group_not_found');
      }

      const rawDate = req.query['date'];
      const dateStr = Array.isArray(rawDate) ? rawDate[0] : rawDate;
      if (!dateStr || typeof dateStr !== 'string') {
        throw new HttpError(
          400,
          'invalid_statement_date',
          'Date query parameter is required in YYYY-MM-DD format',
        );
      }

      const result = await service.getRecordedBalance({ groupId, dateStr });
      res.status(200).json(result);
    },
  );

  // GET /v1/groups/:groupId/reconciliations
  router.get(
    '/v1/groups/:groupId/reconciliations',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      if (!groupId) {
        throw new HttpError(404, 'group_not_found');
      }

      const result = await service.listReconciliations({ groupId });
      res.status(200).json(result);
    },
  );

  // POST /v1/groups/:groupId/reconciliations (Treasurer only)
  router.post(
    '/v1/groups/:groupId/reconciliations',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireTreasurer,
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
        (body['recordedBalance'] !== undefined ||
          body['recordedBalancePaisa'] !== undefined ||
          body['difference'] !== undefined ||
          body['differencePaisa'] !== undefined ||
          body['status'] !== undefined)
      ) {
        throw new HttpError(
          400,
          'invalid_reconciliation_input',
          'Recorded balance and difference are computed server-side',
        );
      }

      const parsed = recordReconciliationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          'invalid_reconciliation_input',
          parsed.error.message,
        );
      }

      const idempotencyKey = extractIdempotencyKey(req);
      const result = await service.recordReconciliation({
        groupId,
        actorUserId: user.id,
        memberId: membership.membershipId,
        statementDate: parsed.data.statementDate,
        bankBalancePaisa: parsed.data.bankBalancePaisa,
        note: parsed.data.note,
        idempotencyKey,
      });

      if (result.isReplay) {
        res.setHeader('Idempotent-Replay', 'true');
      }
      res.status(201).json(result.reconciliation);
    },
  );

  return router;
}
