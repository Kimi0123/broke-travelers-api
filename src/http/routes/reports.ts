import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import {
  getAnnualReport,
  getMemberReport,
  getMonthlyReport,
  getOutflowReport,
  getReportMonths,
} from '../../application/reports-service.js';
import type { TokenVerifier } from '../../application/ports/token-verifier.js';
import { HttpError } from '../errors.js';
import { requireAuth, requireUser } from '../middleware/auth.js';
import { loadMembership } from '../middleware/membership.js';
import {
  annualReportResponseSchema,
  memberReportResponseSchema,
  monthlyReportResponseSchema,
  monthQuerySchema,
  outflowReportResponseSchema,
  reportMonthsResponseSchema,
  yearQuerySchema,
} from '../schemas/reports.js';

export interface ReportsRouteDeps {
  readonly prisma: PrismaClient;
  readonly tokenVerifier: TokenVerifier;
  readonly clock?: (() => Date) | undefined;
}

export function createReportsRouter(deps: ReportsRouteDeps): Router {
  const router = Router();

  function requireGroupId(raw: unknown): string {
    const groupId = Array.isArray(raw) ? (raw[0] as unknown) : raw;
    if (typeof groupId !== 'string' || groupId.length === 0) {
      throw new HttpError(404, 'group_not_found');
    }
    return groupId;
  }

  // GET /v1/groups/:groupId/reports/months
  router.get(
    '/v1/groups/:groupId/reports/months',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const groupId = requireGroupId(req.params['groupId']);
      res.setHeader('Cache-Control', 'no-store');

      const now = deps.clock ? deps.clock() : new Date();
      const result = await getReportMonths(deps.prisma, groupId, now);
      const response = reportMonthsResponseSchema.parse(result);
      res.status(200).json(response);
    },
  );

  // GET /v1/groups/:groupId/reports/monthly?month=YYYY-MM
  router.get(
    '/v1/groups/:groupId/reports/monthly',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const groupId = requireGroupId(req.params['groupId']);
      res.setHeader('Cache-Control', 'no-store');

      const queryResult = monthQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        throw new HttpError(400, 'invalid_request', queryResult.error.message);
      }

      const now = deps.clock ? deps.clock() : new Date();
      const result = await getMonthlyReport(deps.prisma, {
        groupId,
        monthStr: queryResult.data.month,
        now,
      });

      const response = monthlyReportResponseSchema.parse(result);
      res.status(200).json(response);
    },
  );

  // GET /v1/groups/:groupId/reports/members?month=YYYY-MM
  router.get(
    '/v1/groups/:groupId/reports/members',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const groupId = requireGroupId(req.params['groupId']);
      res.setHeader('Cache-Control', 'no-store');

      const queryResult = monthQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        throw new HttpError(400, 'invalid_request', queryResult.error.message);
      }

      const now = deps.clock ? deps.clock() : new Date();
      const result = await getMemberReport(deps.prisma, {
        groupId,
        monthStr: queryResult.data.month,
        viewerIsTreasurer: req.membership!.isTreasurer,
        viewerIsOwner: req.membership!.isOwner,
        viewerMemberId: req.membership!.membershipId,
        now,
      });

      const response = memberReportResponseSchema.parse(result);
      res.status(200).json(response);
    },
  );

  // GET /v1/groups/:groupId/reports/annual?year=YYYY
  router.get(
    '/v1/groups/:groupId/reports/annual',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const groupId = requireGroupId(req.params['groupId']);
      res.setHeader('Cache-Control', 'no-store');

      const queryResult = yearQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        throw new HttpError(400, 'invalid_request', queryResult.error.message);
      }

      const now = deps.clock ? deps.clock() : new Date();
      const result = await getAnnualReport(deps.prisma, {
        groupId,
        year: queryResult.data.year,
        now,
      });

      const response = annualReportResponseSchema.parse(result);
      res.status(200).json(response);
    },
  );

  // GET /v1/groups/:groupId/reports/expenses?year=YYYY
  router.get(
    '/v1/groups/:groupId/reports/expenses',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const groupId = requireGroupId(req.params['groupId']);
      res.setHeader('Cache-Control', 'no-store');

      const queryResult = yearQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        throw new HttpError(400, 'invalid_request', queryResult.error.message);
      }

      const now = deps.clock ? deps.clock() : new Date();
      const result = await getOutflowReport(deps.prisma, {
        groupId,
        year: queryResult.data.year,
        kind: 'expense',
        now,
      });

      const response = outflowReportResponseSchema.parse(result);
      res.status(200).json(response);
    },
  );

  // GET /v1/groups/:groupId/reports/withdrawals?year=YYYY
  router.get(
    '/v1/groups/:groupId/reports/withdrawals',
    requireAuth(deps.tokenVerifier),
    requireUser(deps.prisma),
    loadMembership(deps.prisma),
    async (req, res) => {
      const groupId = requireGroupId(req.params['groupId']);
      res.setHeader('Cache-Control', 'no-store');

      const queryResult = yearQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        throw new HttpError(400, 'invalid_request', queryResult.error.message);
      }

      const now = deps.clock ? deps.clock() : new Date();
      const result = await getOutflowReport(deps.prisma, {
        groupId,
        year: queryResult.data.year,
        kind: 'withdrawal',
        now,
      });

      const response = outflowReportResponseSchema.parse(result);
      res.status(200).json(response);
    },
  );

  return router;
}
