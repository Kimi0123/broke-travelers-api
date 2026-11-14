import { z } from 'zod';
import { paymentMethodSchema } from './financial.js';

export const approvalKindSchema = z.enum(['withdrawal', 'expense']);

export const approvalStatusSchema = z.enum([
  'open',
  'approved',
  'rejected',
  'cancelled',
  'expired',
  'executed',
]);

export const createApprovalRequestSchema = z
  .object({
    kind: approvalKindSchema,
    amountPaisa: z.number().int().positive().max(1000000000),
    title: z.string().trim().min(2).max(60),
    payee: z.string().trim().min(2).max(60),
    description: z.string().trim().max(200).optional().nullable(),
  })
  .strict();

export const voteApprovalRequestSchema = z
  .object({
    vote: z.enum(['approve', 'reject']).optional(),
    approve: z.boolean().optional(),
  })
  .refine(
    (data) => data.vote !== undefined || data.approve !== undefined,
    'Either vote or approve must be provided',
  );

export const executeApprovalRequestSchema = z
  .object({
    method: paymentMethodSchema.optional(),
  })
  .strict();
