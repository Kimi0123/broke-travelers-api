import { z } from 'zod';

export const recordReconciliationRequestSchema = z
  .object({
    statementDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
    bankBalancePaisa: z.number().int().min(0).max(1000000000),
    note: z.string().trim().max(200).optional().nullable(),
  })
  .strict();
