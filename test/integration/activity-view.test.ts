import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { generateId } from '../../src/infrastructure/db/ids.js';
import {
  closeAllTestClients,
  getTestDirectPrisma,
  resetTestDatabase,
  seedStandardGroup,
} from './setup.js';

describe('Activity View (v_activity_items) and Keyset Pagination', () => {
  const prisma = getTestDirectPrisma();

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeAllTestClients();
  });

  it('correctly unions ledger entries and pending submissions with keyset pagination', async () => {
    const fixture = await seedStandardGroup(prisma);

    // Create 15 items: 8 ledger entries and 7 unposted submissions across distinct times
    const baseTime = new Date('2026-11-01T10:00:00.000Z').getTime();

    // Insert 8 ledger entries
    for (let i = 0; i < 8; i++) {
      const occurredAt = new Date(baseTime + i * 3600 * 1000);
      await prisma.ledgerEntry.create({
        data: {
          id: generateId(),
          groupId: fixture.group.id,
          kind: 'contribution',
          title: `Ledger Entry ${i + 1}`,
          magnitudePaisa: 500000n,
          occurredAt,
          memberId: fixture.owner.membership.id,
          periodMonth: new Date('2026-11-01T00:00:00.000Z'),
          actorMemberId: fixture.owner.membership.id,
        },
      });
    }

    // Insert 7 submissions (5 pending, 2 rejected)
    for (let i = 8; i < 15; i++) {
      const submittedAt = new Date(baseTime + i * 3600 * 1000);
      const isRejected = i >= 13;
      await prisma.paymentSubmission.create({
        data: {
          id: generateId(),
          groupId: fixture.group.id,
          memberId: fixture.member1.membership.id,
          periodMonth: new Date('2026-11-01T00:00:00.000Z'),
          amountPaisa: 500000n,
          paymentMethod: 'esewa',
          reference: `REF-ACT-${i}`,
          status: isRejected ? 'rejected' : 'pending',
          rejectionReason: isRejected ? 'other' : null,
          submittedAt,
        },
      });
    }

    // Query entire view
    const allItems = await prisma.$queryRaw<
      { id: string; source: string; status: string; occurred_at: Date }[]
    >`
      SELECT id, source, status, occurred_at
      FROM v_activity_items
      WHERE group_id = ${fixture.group.id}::uuid
      ORDER BY occurred_at DESC, id DESC
    `;

    expect(allItems).toHaveLength(15);

    // Verify union sources
    const ledgerItems = allItems.filter((i) => i.source === 'ledger');
    const subItems = allItems.filter((i) => i.source === 'submission');
    expect(ledgerItems).toHaveLength(8);
    expect(subItems).toHaveLength(7);

    // Keyset pagination: Page 1 (limit 6)
    const page1 = await prisma.$queryRaw<{ id: string; occurred_at: Date }[]>`
      SELECT id, occurred_at
      FROM v_activity_items
      WHERE group_id = ${fixture.group.id}::uuid
      ORDER BY occurred_at DESC, id DESC
      LIMIT 6
    `;
    expect(page1).toHaveLength(6);
    expect(page1.map((p) => p.id)).toEqual(
      allItems.slice(0, 6).map((a) => a.id),
    );

    // Page 2 using cursor from last item of Page 1
    const cursor = page1[page1.length - 1];
    expect(cursor).toBeDefined();

    const page2 = await prisma.$queryRaw<{ id: string; occurred_at: Date }[]>`
      SELECT id, occurred_at
      FROM v_activity_items
      WHERE group_id = ${fixture.group.id}::uuid
        AND (occurred_at, id) < (${cursor!.occurred_at}, ${cursor!.id})
      ORDER BY occurred_at DESC, id DESC
      LIMIT 6
    `;
    expect(page2).toHaveLength(6);
    expect(page2.map((p) => p.id)).toEqual(
      allItems.slice(6, 12).map((a) => a.id),
    );

    // Page 3: remaining 3 items
    const cursor2 = page2[page2.length - 1];
    const page3 = await prisma.$queryRaw<{ id: string; occurred_at: Date }[]>`
      SELECT id, occurred_at
      FROM v_activity_items
      WHERE group_id = ${fixture.group.id}::uuid
        AND (occurred_at, id) < (${cursor2!.occurred_at}, ${cursor2!.id})
      ORDER BY occurred_at DESC, id DESC
      LIMIT 6
    `;
    expect(page3).toHaveLength(3);
    expect(page3.map((p) => p.id)).toEqual(
      allItems.slice(12, 15).map((a) => a.id),
    );

    // Ensure all 15 items were retrieved with zero overlap or skips
    const paginatedIds = [...page1, ...page2, ...page3].map((p) => p.id);
    expect(paginatedIds).toEqual(allItems.map((a) => a.id));
  });
});
