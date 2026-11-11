import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { submitPayment } from '../../src/application/posting-service.js';
import { createWallClock } from '../../src/domain/wall-clock.js';
import { withTransaction } from '../../src/infrastructure/db/client.js';
import { generateId } from '../../src/infrastructure/db/ids.js';
import {
  closeAllTestClients,
  getTestDirectPrisma,
  getTestPrisma,
  resetTestDatabase,
  seedStandardGroup,
} from './setup.js';

describe('Transaction Atomicity and Rollback Guarantees', () => {
  const apiPrisma = getTestPrisma();
  const directPrisma = getTestDirectPrisma();

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeAllTestClients();
  });

  it('rolls back completely if a failure occurs during verification steps', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    // Create a pending submission
    const sub = await submitPayment(apiPrisma, {
      groupId: fixture.group.id,
      memberId: fixture.member1.membership.id,
      periodMonth: createWallClock(2026, 11, 1),
      paymentMethod: 'esewa',
      reference: 'ATOMICITY-TEST-REF',
    });

    const failingKey = 'atomic-fail-idempotency-key';

    // Simulate verification with an injected failure at the final step before commit
    await expect(
      withTransaction(apiPrisma, async (tx) => {
        // Step 1: Update submission
        await tx.paymentSubmission.update({
          where: { id: sub.id },
          data: {
            status: 'verified',
            reviewedByMemberId: fixture.owner.membership.id,
            reviewedAt: new Date(),
          },
        });

        // Step 2: Insert ledger entry
        const entryId = generateId();
        await tx.ledgerEntry.create({
          data: {
            id: entryId,
            groupId: fixture.group.id,
            kind: 'contribution',
            title: 'Savings Contribution',
            magnitudePaisa: 500000n,
            occurredAt: new Date(),
            memberId: sub.memberId,
            periodMonth: new Date('2026-11-01T00:00:00.000Z'),
            paymentMethod: 'esewa',
            actorMemberId: fixture.owner.membership.id,
          },
        });

        // Step 3: Link submission
        await tx.paymentSubmission.update({
          where: { id: sub.id },
          data: { postedLedgerEntryId: entryId },
        });

        // Injected crash
        throw new Error(
          'Simulated network/hardware crash before transaction commit',
        );
      }),
    ).rejects.toThrow(
      'Simulated network/hardware crash before transaction commit',
    );

    // Verify database state: submission MUST remain pending
    const dbSub = await directPrisma.paymentSubmission.findUnique({
      where: { id: sub.id },
    });
    expect(dbSub?.status).toBe('pending');
    expect(dbSub?.postedLedgerEntryId).toBeNull();
    expect(dbSub?.reviewedByMemberId).toBeNull();

    // Zero ledger entries created
    const ledgerCount = await directPrisma.ledgerEntry.count({
      where: { groupId: fixture.group.id },
    });
    expect(ledgerCount).toBe(0);

    // Zero verification audit log rows created
    const auditCount = await directPrisma.auditLog.count({
      where: {
        groupId: fixture.group.id,
        action: 'payment_submission.verified',
      },
    });
    expect(auditCount).toBe(0);

    // Zero idempotency keys saved
    const keyCount = await directPrisma.idempotencyKey.count({
      where: { idempotencyKey: failingKey },
    });
    expect(keyCount).toBe(0);
  });
});
