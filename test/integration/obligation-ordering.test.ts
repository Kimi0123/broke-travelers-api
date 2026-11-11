import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { deriveObligationStatus } from '../../src/domain/obligation-status.js';
import { createWallClock } from '../../src/domain/wall-clock.js';
import { generateId } from '../../src/infrastructure/db/ids.js';
import {
  mapSubmissionToLedgerEntry,
  sortBySeqAsc,
} from '../../src/infrastructure/db/mappers.js';
import {
  closeAllTestClients,
  getTestDirectPrisma,
  resetTestDatabase,
  seedStandardGroup,
} from './setup.js';

describe('Obligation Status Tie-Breaking on Monotonic Sequence', () => {
  const prisma = getTestDirectPrisma();

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeAllTestClients();
  });

  it('resolves identical timestamps deterministically by sequence number (seq ASC)', async () => {
    const fixture = await seedStandardGroup(prisma);

    // Identical submitted_at timestamp down to the millisecond
    const exactTimestamp = new Date('2026-11-10T12:00:00.000Z');
    const periodDate = new Date('2026-11-01T00:00:00.000Z');

    // First submission: rejected
    const sub1 = await prisma.paymentSubmission.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: periodDate,
        amountPaisa: 500000n,
        paymentMethod: 'esewa',
        reference: 'TIE-BREAK-REF-001',
        status: 'rejected',
        rejectionReason: 'wrongAmount',
        submittedAt: exactTimestamp,
      },
    });

    // Second submission: pending (submitted slightly later, thus assigned higher seq by identity)
    const sub2 = await prisma.paymentSubmission.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: periodDate,
        amountPaisa: 500000n,
        paymentMethod: 'esewa',
        reference: 'TIE-BREAK-REF-002',
        status: 'pending',
        submittedAt: exactTimestamp,
      },
    });

    expect(sub2.seq).toBeGreaterThan(sub1.seq);

    // Fetch submissions ordered by seq ASC (creation order)
    const rawRows = await prisma.paymentSubmission.findMany({
      where: {
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
      },
      orderBy: { seq: 'asc' },
    });

    const entries = sortBySeqAsc(rawRows.map(mapSubmissionToLedgerEntry));

    // Evaluate obligation status: the second submission (seq 2, pending) must win the tie
    const status = deriveObligationStatus({
      entries,
      memberId: fixture.member1.membership.id,
      periodStart: createWallClock(2026, 11, 1),
      anchorPeriodStart: createWallClock(2026, 11, 1),
    });

    expect(status).toBe('pendingVerification');
  });
});
