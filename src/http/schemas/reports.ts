import { z } from 'zod';

export const monthQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be in YYYY-MM format'),
});

export const yearQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
});

export const reportMonthsResponseSchema = z.object({
  earliestMonth: z.string().regex(/^\d{4}-\d{2}$/),
  anchorMonth: z.string().regex(/^\d{4}-\d{2}$/),
  selectableMonths: z.array(z.string().regex(/^\d{4}-\d{2}$/)),
  selectableYears: z.array(z.number().int()),
});

export const monthlyReportResponseSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  openingPaisa: z.number().int(),
  contributionsPaisa: z.number().int().nonnegative(),
  interestPaisa: z.number().int().nonnegative(),
  expensesPaisa: z.number().int().nonnegative(),
  withdrawalsPaisa: z.number().int().nonnegative(),
  closingPaisa: z.number().int(),
  pendingPaisa: z.number().int().nonnegative(),
  obligatedCount: z.number().int().nonnegative(),
  verifiedCount: z.number().int().nonnegative(),
  expectedTotalPaisa: z.number().int().nonnegative(),
  outstandingPaisa: z.number().int().nonnegative(),
});

export const memberReportRowSchema = z.object({
  memberId: z.string().uuid(),
  name: z.string(),
  expectedPaisa: z.number().int().nonnegative(),
  verifiedPaisa: z.number().int().nonnegative(),
  pendingPaisa: z.number().int().nonnegative().nullable(),
  outstandingPaisa: z.number().int().nonnegative(),
  status: z.enum([
    'notSubmitted',
    'pendingVerification',
    'verified',
    'rejected',
    'overdue',
  ]),
});

export const memberReportResponseSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  rows: z.array(memberReportRowSchema),
  expectedTotalPaisa: z.number().int().nonnegative(),
  verifiedTotalPaisa: z.number().int().nonnegative(),
  pendingTotalPaisa: z.number().int().nonnegative(),
  outstandingTotalPaisa: z.number().int().nonnegative(),
});

export const annualMonthRowSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  contributionsPaisa: z.number().int().nonnegative(),
  interestPaisa: z.number().int().nonnegative(),
  expensesPaisa: z.number().int().nonnegative(),
  withdrawalsPaisa: z.number().int().nonnegative(),
  netPaisa: z.number().int(),
  closingPaisa: z.number().int(),
});

export const annualReportResponseSchema = z.object({
  year: z.number().int(),
  months: z.array(annualMonthRowSchema),
  contributionsPaisa: z.number().int().nonnegative(),
  interestPaisa: z.number().int().nonnegative(),
  expensesPaisa: z.number().int().nonnegative(),
  withdrawalsPaisa: z.number().int().nonnegative(),
  netPaisa: z.number().int(),
  closingPaisa: z.number().int(),
});

export const outflowRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountPaisa: z.number().int().positive(),
  isReversed: z.boolean(),
  isReversal: z.boolean(),
});

export const outflowMonthTotalSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  totalPaisa: z.number().int().nonnegative(),
});

export const outflowReportResponseSchema = z.object({
  year: z.number().int(),
  kind: z.enum(['expense', 'withdrawal']),
  rows: z.array(outflowRowSchema),
  totalPaisa: z.number().int().nonnegative(),
  monthTotals: z.array(outflowMonthTotalSchema),
});
