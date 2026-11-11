import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { InsufficientBalanceError } from '../../src/application/errors.js';
import { postLedgerEntry } from '../../src/application/posting-service.js';
import { verifiedBalancePaisa } from '../../src/domain/ledger-math.js';
import { mapLedgerEntryRow } from '../../src/infrastructure/db/mappers.js';
import {
  closeAllTestClients,
  getTestDirectPrisma,
  getTestPrisma,
  resetTestDatabase,
  seedStandardGroup,
} from './setup.js';

describe('Balance Guard and Server-side Audit Timestamps', () => {
  const apiPrisma = getTestPrisma();
  const directPrisma = getTestDirectPrisma();

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeAllTestClients();
  });

  it('prevents overdrawing verified balance and uses server-generated audit timestamps', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    // Seed initial balance of NPR 500 (50,000 paisa)
    await postLedgerEntry(apiPrisma, {
      groupId: fixture.group.id,
      actorMemberId: fixture.owner.membership.id,
      kind: 'contribution',
      title: 'Initial Seed Contribution',
      magnitudePaisa: 50000,
      memberId: fixture.member1.membership.id,
    });

    const checkBalance = async () => {
      const rows = await directPrisma.ledgerEntry.findMany({
        where: { groupId: fixture.group.id },
      });
      return verifiedBalancePaisa(rows.map(mapLedgerEntryRow));
    };

    expect(await checkBalance()).toBe(50000);

    // 1. Attempt to post expense of NPR 600 (60,000 paisa) -> fails with insufficient_balance
    await expect(
      postLedgerEntry(apiPrisma, {
        groupId: fixture.group.id,
        actorMemberId: fixture.owner.membership.id,
        kind: 'expense',
        title: 'Overdrawing Expense',
        magnitudePaisa: 60000,
      }),
    ).rejects.toThrow(InsufficientBalanceError);

    // Verify balance is unchanged and no entry created
    expect(await checkBalance()).toBe(50000);

    // 2. Post expense of NPR 400 (40,000 paisa) -> succeeds
    const expenseEntry = await postLedgerEntry(apiPrisma, {
      groupId: fixture.group.id,
      actorMemberId: fixture.owner.membership.id,
      kind: 'expense',
      title: 'Guide Fees',
      magnitudePaisa: 40000,
    });
    expect(expenseEntry.magnitudePaisa).toBe(40000);
    expect(await checkBalance()).toBe(10000); // NPR 100 remaining

    // 3. Post withdrawal of NPR 100 (10,000 paisa) -> succeeds, balance is NPR 0
    await postLedgerEntry(apiPrisma, {
      groupId: fixture.group.id,
      actorMemberId: fixture.owner.membership.id,
      kind: 'withdrawal',
      title: 'Member Payout',
      magnitudePaisa: 10000,
    });
    expect(await checkBalance()).toBe(0);

    // 4. Post expense of NPR 1 (1 paisa) against zero balance -> fails with insufficient_balance
    await expect(
      postLedgerEntry(apiPrisma, {
        groupId: fixture.group.id,
        actorMemberId: fixture.owner.membership.id,
        kind: 'expense',
        title: 'Tiny Expense',
        magnitudePaisa: 1,
      }),
    ).rejects.toThrow(InsufficientBalanceError);

    expect(await checkBalance()).toBe(0);

    // 5. Verify audit log created_at timestamp is server-generated
    const auditLogs = await directPrisma.auditLog.findMany({
      where: { groupId: fixture.group.id },
    });

    const now = Date.now();
    for (const log of auditLogs) {
      const logTime = log.createdAt.getTime();
      // Server timestamp should be within 10 seconds of now
      expect(Math.abs(now - logTime)).toBeLessThan(10000);
    }
  });
});
