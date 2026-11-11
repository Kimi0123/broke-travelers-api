import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  postLedgerEntry,
  submitPayment,
  verifyPaymentSubmission,
} from '../../src/application/posting-service.js';
import { verifiedBalancePaisa } from '../../src/domain/ledger-math.js';
import { createWallClock } from '../../src/domain/wall-clock.js';
import { mapLedgerEntryRow } from '../../src/infrastructure/db/mappers.js';
import {
  closeAllTestClients,
  getTestDirectPrisma,
  getTestPrisma,
  resetTestDatabase,
  seedStandardGroup,
} from './setup.js';

describe('Concurrency Guarantees and Mutual Exclusion', () => {
  const apiPrisma = getTestPrisma();
  const directPrisma = getTestDirectPrisma();

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeAllTestClients();
  });

  it('prevents overdrawing under 10 concurrent expense attempts (repeated 5 times)', async () => {
    for (let run = 1; run <= 5; run++) {
      // Clean slate per iteration
      await resetTestDatabase();

      const fixture = await seedStandardGroup(directPrisma);

      // Seed verified balance = NPR 1,000 (100,000 paisa)
      await postLedgerEntry(apiPrisma, {
        groupId: fixture.group.id,
        actorMemberId: fixture.owner.membership.id,
        kind: 'contribution',
        title: `Seed Run ${run}`,
        magnitudePaisa: 100000,
        memberId: fixture.owner.membership.id,
      });

      // 10 concurrent attempts to spend NPR 300 (30,000 paisa) each
      // Total demand = 300,000 paisa against 100,000 paisa available.
      // Exactly 3 must succeed (leaving 10,000 paisa = NPR 100), exactly 7 must fail.
      const attempts = Array.from({ length: 10 }, (_, i) =>
        postLedgerEntry(apiPrisma, {
          groupId: fixture.group.id,
          actorMemberId: fixture.owner.membership.id,
          kind: 'expense',
          title: `Concurrent Expense ${i + 1}`,
          magnitudePaisa: 30000,
        }),
      );

      const results = await Promise.allSettled(attempts);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(3);
      expect(rejected).toHaveLength(7);

      for (const rej of rejected) {
        if (rej.status === 'rejected') {
          const reason = rej.reason as { message?: string } | undefined;
          expect(reason?.message ?? '').toMatch(/insufficient.*balance/i);
        }
      }

      // Final balance must be exactly NPR 100 (10,000 paisa)
      const rows = await directPrisma.ledgerEntry.findMany({
        where: { groupId: fixture.group.id },
      });
      const finalBalance = verifiedBalancePaisa(rows.map(mapLedgerEntryRow));
      expect(finalBalance).toBe(10000);
    }
  });

  it('handles concurrent verifications of the same submission without double-posting', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    // Member submits a payment
    const submission = await submitPayment(apiPrisma, {
      groupId: fixture.group.id,
      memberId: fixture.member1.membership.id,
      periodMonth: createWallClock(2026, 11, 1),
      paymentMethod: 'esewa',
      reference: 'CONC-VERIFY-REF-001',
    });

    // Both treasurers attempt to verify the submission simultaneously
    const attempts = [
      verifyPaymentSubmission(apiPrisma, {
        groupId: fixture.group.id,
        submissionId: submission.id,
        reviewerMemberId: fixture.owner.membership.id,
      }),
      verifyPaymentSubmission(apiPrisma, {
        groupId: fixture.group.id,
        submissionId: submission.id,
        reviewerMemberId: fixture.secondTreasurer.membership.id,
      }),
    ];

    const results = await Promise.allSettled(attempts);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one must succeed, one must fail with invalid status transition
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Exactly one ledger entry was created
    const ledgerCount = await directPrisma.ledgerEntry.count({
      where: { groupId: fixture.group.id },
    });
    expect(ledgerCount).toBe(1);

    // Exactly one submission row exists and is verified
    const subInDb = await directPrisma.paymentSubmission.findUnique({
      where: { id: submission.id },
    });
    expect(subInDb?.status).toBe('verified');
  });

  it('rejects concurrent payment submissions with identical reference via database constraint', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    const identicalRef = 'CONC-DUP-REF-12345';

    // Two members concurrently submit with the same reference
    const attempts = [
      submitPayment(apiPrisma, {
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: createWallClock(2026, 11, 1),
        paymentMethod: 'khalti',
        reference: identicalRef,
      }),
      submitPayment(apiPrisma, {
        groupId: fixture.group.id,
        memberId: fixture.member2.membership.id,
        periodMonth: createWallClock(2026, 11, 1),
        paymentMethod: 'khalti',
        reference: identicalRef,
      }),
    ];

    const results = await Promise.allSettled(attempts);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    if (rejected[0]?.status === 'rejected') {
      const reason = rejected[0].reason as { message?: string } | undefined;
      expect(reason?.message ?? '').toMatch(/already pending or verified/i);
    }
  });
});
