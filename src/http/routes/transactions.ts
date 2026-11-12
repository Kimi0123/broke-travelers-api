import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import { TransactionsService } from '../../application/transactions-service.js';
import type { ActivityKind } from '../../domain/enums.js';
import { HttpError } from '../errors.js';
import {
  extractIdempotencyKey,
  requireIdempotencyKey,
} from '../middleware/idempotency-key.js';
import { requireAuth, requireUser } from '../middleware/auth.js';
import { loadMembership, requireTreasurer } from '../middleware/membership.js';
import { parsePaginationParams } from '../helpers/pagination.js';
import {
  recordTransactionRequestSchema,
  reverseTransactionRequestSchema,
} from '../schemas/financial.js';

export interface TransactionsRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
}

export function createTransactionsRouter(deps: TransactionsRouteDeps): Router {
  const router = Router();
  const service = new TransactionsService(deps.prisma, deps.clock);

  // GET /v1/groups/:groupId/transactions
  router.get(
    '/v1/groups/:groupId/transactions',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      if (!groupId) {
        throw new HttpError(404, 'group_not_found');
      }

      const { limit, cursor } = parsePaginationParams(req.query);

      const rawKind = req.query['kind'];
      const kindStr = Array.isArray(rawKind) ? rawKind[0] : rawKind;
      const kind =
        typeof kindStr === 'string' ? (kindStr as ActivityKind) : undefined;

      const rawStatus = req.query['status'];
      const statusStr = Array.isArray(rawStatus) ? rawStatus[0] : rawStatus;
      const status = typeof statusStr === 'string' ? statusStr : undefined;

      const result = await service.listTransactions({
        groupId,
        limit,
        cursor,
        kind,
        status,
      });

      res.status(200).json(result);
    },
  );

  // GET /v1/groups/:groupId/transactions/:transactionId
  router.get(
    '/v1/groups/:groupId/transactions/:transactionId',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      const rawTxId = req.params['transactionId'];
      const transactionId = Array.isArray(rawTxId) ? rawTxId[0] : rawTxId;

      if (!groupId || !transactionId) {
        throw new HttpError(404, 'transaction_not_found');
      }

      const result = await service.getTransaction({ groupId, transactionId });
      res.status(200).json(result);
    },
  );

  // POST /v1/groups/:groupId/transactions
  router.post(
    '/v1/groups/:groupId/transactions',
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

      const parsed = recordTransactionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          'invalid_transaction_input',
          parsed.error.message,
        );
      }

      const idempotencyKey = extractIdempotencyKey(req);
      const result = await service.recordTransaction({
        groupId,
        actorMemberId: membership.membershipId,
        actorUserId: user.id,
        kind: parsed.data.kind,
        amountPaisa: parsed.data.amountPaisa,
        occurredAt: parsed.data.occurredAt,
        title: parsed.data.title,
        note: parsed.data.note,
        method: parsed.data.method,
        idempotencyKey,
      });

      res.status(201).json(result);
    },
  );

  // POST /v1/groups/:groupId/transactions/:transactionId/reverse
  router.post(
    '/v1/groups/:groupId/transactions/:transactionId/reverse',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    requireTreasurer,
    requireIdempotencyKey,
    async (req, res) => {
      const rawGroupId = req.params['groupId'];
      const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
      const rawTxId = req.params['transactionId'];
      const transactionId = Array.isArray(rawTxId) ? rawTxId[0] : rawTxId;
      const user = req.user;
      const membership = req.membership;

      if (!groupId || !transactionId || !user || !membership) {
        throw new HttpError(404, 'transaction_not_found');
      }

      const parsed = reverseTransactionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          'invalid_transaction_input',
          parsed.error.message,
        );
      }

      const idempotencyKey = extractIdempotencyKey(req);
      const result = await service.reverseTransaction({
        groupId,
        transactionId,
        actorMemberId: membership.membershipId,
        actorUserId: user.id,
        reason: parsed.data.reason,
        idempotencyKey,
      });

      res.status(201).json(result);
    },
  );

  return router;
}
