import { z } from 'zod';

export const activityKindSchema = z.enum([
  'contribution',
  'expense',
  'interest',
  'withdrawal',
]);

export const recordableKindSchema = z.enum(['expense', 'interest']);

export const paymentMethodSchema = z.enum([
  'esewa',
  'khalti',
  'bankTransfer',
  'cash',
]);

export const paymentStatusSchema = z.enum([
  'verified',
  'pendingVerification',
  'rejected',
]);

export const rejectionReasonSchema = z.enum([
  'notReceived',
  'wrongAmount',
  'referenceNotFound',
  'other',
]);

export const obligationStatusSchema = z.enum([
  'verified',
  'pendingVerification',
  'overdue',
  'dueSoon',
  'notSubmitted',
  'rejected',
]);

export const periodSummarySchema = z.object({
  id: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  month: z.string(),
  dueDate: z.string(),
  expectedTotalPaisa: z.number().int(),
  verifiedReceivedPaisa: z.number().int(),
  pendingTotalPaisa: z.number().int(),
  obligatedCount: z.number().int(),
  verifiedObligationCount: z.number().int(),
  isCurrent: z.boolean(),
  aggregateStatus: obligationStatusSchema,
});

export const obligationSchema = z.object({
  memberId: z.string().uuid(),
  memberName: z.string(),
  isCurrentUser: z.boolean(),
  expectedPaisa: z.number().int(),
  paidPaisa: z.number().int(),
  status: obligationStatusSchema,
  recordedAt: z.string().nullable(),
});

export const periodDetailSchema = z.object({
  summary: periodSummarySchema,
  obligations: z.array(obligationSchema),
});

export const submitPaymentRequestSchema = z
  .object({
    periodId: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    method: paymentMethodSchema,
    reference: z.string().optional().nullable(),
    note: z.string().max(200).optional().nullable(),
    amount: z.unknown().optional(),
    amountPaisa: z.unknown().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.amount !== undefined || val.amountPaisa !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Client cannot supply payment amount',
      });
    }
  });

export const submitPaymentResponseSchema = z.object({
  id: z.string(),
  groupId: z.string().uuid(),
  memberId: z.string().uuid(),
  periodMonth: z.string(),
  amountPaisa: z.number().int(),
  paymentMethod: paymentMethodSchema,
  reference: z.string().nullable(),
  note: z.string().nullable(),
  status: z.literal('pending'),
  submittedAt: z.string(),
});

export const myPaymentItemSchema = z.object({
  id: z.string(),
  periodMonth: z.string(),
  amountPaisa: z.number().int(),
  paymentMethod: paymentMethodSchema,
  reference: z.string().nullable(),
  note: z.string().nullable(),
  status: z.enum(['pending', 'pendingVerification', 'verified', 'rejected']),
  submittedAt: z.string(),
  rejectionReason: rejectionReasonSchema.nullable().optional(),
  rejectionNote: z.string().nullable().optional(),
});

export const pendingReviewItemSchema = z.object({
  submissionId: z.string(),
  memberId: z.string().uuid(),
  memberName: z.string(),
  periodMonth: z.string(),
  amountPaisa: z.number().int(),
  paymentMethod: paymentMethodSchema,
  reference: z.string().nullable(),
  note: z.string().nullable(),
  submittedAt: z.string(),
  isOwnSubmission: z.boolean(),
});

export const rejectPaymentRequestSchema = z.object({
  reason: rejectionReasonSchema,
  note: z.string().max(200).optional().nullable(),
});

export const recordTransactionRequestSchema = z.object({
  kind: recordableKindSchema,
  amountPaisa: z.number().int().min(1).max(1_000_000_000),
  occurredAt: z.string(),
  title: z.string().min(2).max(60),
  note: z.string().max(200).optional().nullable(),
  method: paymentMethodSchema.optional().nullable(),
});

export const reverseTransactionRequestSchema = z.object({
  reason: z.string().min(3).max(200),
});

export const activityItemSchema = z.object({
  id: z.string(),
  source: z.enum(['ledger', 'submission']),
  rawId: z.string().uuid(),
  kind: activityKindSchema,
  title: z.string(),
  amountPaisa: z.number().int(),
  status: paymentStatusSchema,
  occurredAt: z.string(),
  memberId: z.string().uuid().nullable(),
  memberName: z.string().nullable(),
  paymentMethod: paymentMethodSchema.nullable(),
  note: z.string().nullable(),
  reversesTransactionId: z.string().nullable(),
  reversedByTransactionId: z.string().nullable(),
  signedAmountPaisa: z.number().int(),
  postedAt: z.string().optional(),
  actorMemberId: z.string().uuid().optional(),
});

export const activityListResponseSchema = z.object({
  items: z.array(activityItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export const memberDetailResponseSchema = z.object({
  member: z.object({
    id: z.string().uuid(),
    displayName: z.string(),
    roles: z.array(z.string()),
    joinedAt: z.string(),
    isCurrentUser: z.boolean(),
    currentPeriodStatus: obligationStatusSchema,
  }),
  verifiedTotalPaisa: z.number().int(),
  pendingTotalPaisa: z.number().int(),
  verifiedMonthCount: z.number().int(),
  history: z.array(
    z.object({
      month: z.string(),
      expectedPaisa: z.number().int(),
      paidPaisa: z.number().int(),
      status: obligationStatusSchema,
      recordedAt: z.string().nullable(),
    }),
  ),
});
