import { z } from 'zod';

export const updateTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('payments') }),
  z.object({ type: z.literal('verifyPayments') }),
  z.object({
    type: z.literal('approvalDetail'),
    approvalId: z.string().uuid(),
  }),
  z.object({ type: z.literal('reconciliation') }),
  z.object({ type: z.literal('contributions') }),
  z.object({ type: z.literal('none') }),
]);

export const updateItemSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum([
    'announcement',
    'reminder',
    'paymentVerification',
    'approval',
    'reconciliation',
  ]),
  title: z.string(),
  body: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  isRead: z.boolean(),
  target: updateTargetSchema,
});

export const updatesResponseSchema = z.object({
  updates: z.array(updateItemSchema),
});

export const markUpdatesReadRequestSchema = z.object({
  ids: z
    .array(z.string().min(1).max(100))
    .min(1, 'At least one update ID is required')
    .max(50, 'Cannot mark more than 50 updates at once'),
});

export const markUpdatesReadResponseSchema = z.object({
  markedCount: z.number().int().nonnegative(),
});

export const unreadUpdatesCountResponseSchema = z.object({
  unreadCount: z.number().int().nonnegative(),
});
