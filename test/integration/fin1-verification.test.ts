import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  rejectPaymentSubmission,
  submitPayment,
  verifyPaymentSubmission,
} from '../../src/application/posting-service.js';
import { createWallClock } from '../../src/domain/wall-clock.js';
import {
  closeAllTestClients,
  getTestDirectPrisma,
  getTestPrisma,
  resetTestDatabase,
  seedStandardGroup,
} from './setup.js';

describe('FIN-1 Resolution: Submissions vs Ledger Integration', () => {
  const apiPrisma = getTestPrisma();
  const directPrisma = getTestDirectPrisma();

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeAllTestClients();
  });

  it('executes full verification lifecycle atomically and updates v_activity_items', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    // 1. Member submits payment via submitPayment
    const submission = await submitPayment(apiPrisma, {
      groupId: fixture.group.id,
      memberId: fixture.member1.membership.id,
      periodMonth: createWallClock(2026, 11, 1),
      paymentMethod: 'esewa',
      reference: 'ESEWA-FIN1-VERIFY-001',
      note: 'November contribution',
    });

    expect(submission.status).toBe('pending');
    expect(submission.amountPaisa).toBe(500000); // 5,000 NPR derived by server

    // 2. Query v_activity_items view before verification
    const beforeItems = await directPrisma.$queryRaw<
      { id: string; source: string; status: string; raw_id: string }[]
    >`SELECT id, source, status, raw_id FROM v_activity_items WHERE group_id = ${fixture.group.id}::uuid`;

    expect(beforeItems).toHaveLength(1);
    expect(beforeItems[0]?.source).toBe('submission');
    expect(beforeItems[0]?.status).toBe('pending');
    expect(beforeItems[0]?.raw_id).toBe(submission.id);

    // 3. Treasurer verifies submission with an idempotency key
    const idempotencyKey = 'verify-fin1-key-001';
    const result1 = await verifyPaymentSubmission(apiPrisma, {
      groupId: fixture.group.id,
      submissionId: submission.id,
      reviewerMemberId: fixture.owner.membership.id,
      idempotencyKey,
    });

    expect(result1.submission.status).toBe('verified');
    expect(result1.submission.reviewedByMemberId).toBe(
      fixture.owner.membership.id,
    );
    expect(result1.submission.postedLedgerEntryId).toBe(result1.ledgerEntry.id);
    expect(result1.ledgerEntry.kind).toBe('contribution');
    expect(result1.ledgerEntry.magnitudePaisa).toBe(500000);

    // 4. Verify exactly one ledger row was created in the database
    const ledgerCount = await directPrisma.ledgerEntry.count({
      where: { groupId: fixture.group.id },
    });
    expect(ledgerCount).toBe(1);

    // 5. Verify audit log entry was created
    const auditCount = await directPrisma.auditLog.count({
      where: {
        groupId: fixture.group.id,
        action: 'payment_submission.verified',
      },
    });
    expect(auditCount).toBe(1);

    // 6. Query v_activity_items view: must show item ONCE from source = 'ledger'
    const afterItems = await directPrisma.$queryRaw<
      { id: string; source: string; status: string; raw_id: string }[]
    >`SELECT id, source, status, raw_id FROM v_activity_items WHERE group_id = ${fixture.group.id}::uuid`;

    expect(afterItems).toHaveLength(1);
    expect(afterItems[0]?.source).toBe('ledger');
    expect(afterItems[0]?.status).toBe('verified');
    expect(afterItems[0]?.raw_id).toBe(result1.ledgerEntry.id);

    // 7. Calling verify again with the same idempotency key returns identical result without extra rows
    const result2 = await verifyPaymentSubmission(apiPrisma, {
      groupId: fixture.group.id,
      submissionId: submission.id,
      reviewerMemberId: fixture.owner.membership.id,
      idempotencyKey,
    });

    expect(result2.submission.id).toBe(result1.submission.id);
    expect(result2.ledgerEntry.id).toBe(result1.ledgerEntry.id);

    const ledgerCountAfterReplay = await directPrisma.ledgerEntry.count({
      where: { groupId: fixture.group.id },
    });
    expect(ledgerCountAfterReplay).toBe(1);
  });

  it('executes rejection lifecycle without creating ledger entries', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    const submission = await submitPayment(apiPrisma, {
      groupId: fixture.group.id,
      memberId: fixture.member2.membership.id,
      periodMonth: createWallClock(2026, 11, 1),
      paymentMethod: 'khalti',
      reference: 'KH-REJECT-001',
    });

    const rejectResult = await rejectPaymentSubmission(apiPrisma, {
      groupId: fixture.group.id,
      submissionId: submission.id,
      reviewerMemberId: fixture.owner.membership.id,
      rejectionReason: 'wrongAmount',
      rejectionNote: 'Deposited 4,000 instead of required 5,000',
    });

    expect(rejectResult.submission.status).toBe('rejected');
    expect(rejectResult.submission.rejectionReason).toBe('wrongAmount');

    // Exactly zero ledger entries created
    const ledgerCount = await directPrisma.ledgerEntry.count({
      where: { groupId: fixture.group.id },
    });
    expect(ledgerCount).toBe(0);

    // Appears in v_activity_items as rejected submission
    const items = await directPrisma.$queryRaw<
      { id: string; source: string; status: string }[]
    >`SELECT id, source, status FROM v_activity_items WHERE group_id = ${fixture.group.id}::uuid`;

    expect(items).toHaveLength(1);
    expect(items[0]?.source).toBe('submission');
    expect(items[0]?.status).toBe('rejected');
  });
});
