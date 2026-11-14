import { z } from 'zod';

export const dashboardMemberStatusSchema = z.object({
  memberId: z.string().uuid(),
  displayName: z.string(),
  expectedAmountPaisa: z.number().int().nonnegative(),
  status: z.enum([
    'notSubmitted',
    'pendingVerification',
    'verified',
    'rejected',
    'overdue',
  ]),
  isCurrentUser: z.boolean(),
});

export const dashboardUpcomingDeadlineSchema = z.object({
  title: z.string(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  outstandingMemberCount: z.number().int().nonnegative(),
});

export const dashboardBalanceHistoryPointSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  verifiedBalanceAtMonthEndPaisa: z.number().int(),
  isCurrentMonth: z.boolean(),
});

export const dashboardActivityItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['contribution', 'expense', 'interest', 'withdrawal']),
  title: z.string(),
  occurredAt: z.string().datetime({ offset: true }),
  amountPaisa: z.number().int().positive(),
  status: z.enum([
    'notSubmitted',
    'pendingVerification',
    'verified',
    'rejected',
    'overdue',
  ]),
  signedAmountPaisa: z.number().int(),
});

export const dashboardSummaryResponseSchema = z.object({
  groupName: z.string(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  verifiedBalancePaisa: z.number().int(),
  pendingAmountPaisa: z.number().int().nonnegative(),
  monthlyTargetPaisa: z.number().int().nonnegative(),
  verifiedThisPeriodPaisa: z.number().int().nonnegative(),
  remainingToTargetPaisa: z.number().int().nonnegative(),
  verifiedMemberCount: z.number().int().nonnegative(),
  totalMemberCount: z.number().int().nonnegative(),
  members: z.array(dashboardMemberStatusSchema),
  recentActivity: z.array(dashboardActivityItemSchema),
  upcomingDeadlines: z.array(dashboardUpcomingDeadlineSchema),
  balanceHistory: z.array(dashboardBalanceHistoryPointSchema),
  openApprovalsCount: z.number().int().nonnegative(),
  needsYourVote: z.boolean(),
  lastReconciledAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  lastReconciliationDifferencePaisa: z.number().int().nullable(),
  lastReconciliationStatus: z.enum(['matched', 'mismatch']).nullable(),
});
