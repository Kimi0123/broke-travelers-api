import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { generateId } from '../../src/infrastructure/db/ids.js';
import {
  closeAllTestClients,
  getTestDirectPrisma,
  resetTestDatabase,
  seedStandardGroup,
} from './setup.js';

describe('Database CHECK Constraints and Partial Unique Indexes', () => {
  const prisma = getTestDirectPrisma();

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeAllTestClients();
  });

  describe('groups constraints', () => {
    it('rejects expected_paisa <= 0', async () => {
      const fixture = await seedStandardGroup(prisma);

      await expect(
        prisma.group.create({
          data: {
            id: generateId(),
            name: 'Invalid Group',
            expectedPaisa: 0n,
            dueDay: 15,
            createdByUserId: fixture.owner.user.id,
          },
        }),
      ).rejects.toThrow();

      await expect(
        prisma.group.create({
          data: {
            id: generateId(),
            name: 'Negative Group',
            expectedPaisa: -500n,
            dueDay: 15,
            createdByUserId: fixture.owner.user.id,
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects due_day outside 1..28 and accepts 1 and 28', async () => {
      const fixture = await seedStandardGroup(prisma);

      // due_day = 0 rejected
      await expect(
        prisma.group.create({
          data: {
            id: generateId(),
            name: 'Day 0 Group',
            expectedPaisa: 500000n,
            dueDay: 0,
            createdByUserId: fixture.owner.user.id,
          },
        }),
      ).rejects.toThrow();

      // due_day = 29 rejected
      await expect(
        prisma.group.create({
          data: {
            id: generateId(),
            name: 'Day 29 Group',
            expectedPaisa: 500000n,
            dueDay: 29,
            createdByUserId: fixture.owner.user.id,
          },
        }),
      ).rejects.toThrow();

      // due_day = 1 accepted
      const g1 = await prisma.group.create({
        data: {
          id: generateId(),
          name: 'Day 1 Group',
          expectedPaisa: 500000n,
          dueDay: 1,
          createdByUserId: fixture.owner.user.id,
        },
      });
      expect(g1.dueDay).toBe(1);

      // due_day = 28 accepted
      const g28 = await prisma.group.create({
        data: {
          id: generateId(),
          name: 'Day 28 Group',
          expectedPaisa: 500000n,
          dueDay: 28,
          createdByUserId: fixture.owner.user.id,
        },
      });
      expect(g28.dueDay).toBe(28);
    });

    it('rejects group name shorter than 2 characters', async () => {
      const fixture = await seedStandardGroup(prisma);

      await expect(
        prisma.group.create({
          data: {
            id: generateId(),
            name: 'A',
            expectedPaisa: 500000n,
            dueDay: 15,
            createdByUserId: fixture.owner.user.id,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('ledger_entries constraints', () => {
    it('rejects non-positive magnitude_paisa', async () => {
      const fixture = await seedStandardGroup(prisma);

      await expect(
        prisma.ledgerEntry.create({
          data: {
            id: generateId(),
            groupId: fixture.group.id,
            kind: 'contribution',
            title: 'Zero magnitude',
            magnitudePaisa: 0n,
            occurredAt: new Date(),
            memberId: fixture.member1.membership.id,
            actorMemberId: fixture.owner.membership.id,
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects invalid kind string on ledger_entries', async () => {
      const fixture = await seedStandardGroup(prisma);

      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO ledger_entries (id, group_id, kind, title, magnitude_paisa, occurred_at, actor_member_id)
          VALUES ('${generateId()}'::uuid, '${fixture.group.id}'::uuid, 'bogus_kind', 'Bogus', 1000, NOW(), '${fixture.owner.membership.id}'::uuid)
        `),
      ).rejects.toThrow();
    });

    it('enforces reversal rules in CHECK constraint', async () => {
      const fixture = await seedStandardGroup(prisma);

      // Create an initial expense to reverse
      const expenseId = generateId();
      await prisma.ledgerEntry.create({
        data: {
          id: expenseId,
          groupId: fixture.group.id,
          kind: 'expense',
          title: 'Permit Fees',
          magnitudePaisa: 150000n,
          occurredAt: new Date(),
          actorMemberId: fixture.owner.membership.id,
        },
      });

      // Contribution cannot have reverses_entry_id -> rejected by CHECK
      await expect(
        prisma.ledgerEntry.create({
          data: {
            id: generateId(),
            groupId: fixture.group.id,
            kind: 'contribution',
            title: 'Invalid reversal',
            magnitudePaisa: 150000n,
            occurredAt: new Date(),
            actorMemberId: fixture.owner.membership.id,
            reversesEntryId: expenseId,
          },
        }),
      ).rejects.toThrow();

      // Withdrawal cannot have reverses_entry_id -> rejected by CHECK
      await expect(
        prisma.ledgerEntry.create({
          data: {
            id: generateId(),
            groupId: fixture.group.id,
            kind: 'withdrawal',
            title: 'Invalid withdrawal reversal',
            magnitudePaisa: 150000n,
            occurredAt: new Date(),
            actorMemberId: fixture.owner.membership.id,
            reversesEntryId: expenseId,
          },
        }),
      ).rejects.toThrow();

      // Expense reversal -> accepted
      const expenseRev = await prisma.ledgerEntry.create({
        data: {
          id: generateId(),
          groupId: fixture.group.id,
          kind: 'expense',
          title: 'Reversal: Permit Fees',
          magnitudePaisa: 150000n,
          occurredAt: new Date(),
          actorMemberId: fixture.owner.membership.id,
          reversesEntryId: expenseId,
        },
      });
      expect(expenseRev.reversesEntryId).toBe(expenseId);
    });
  });

  describe('payment_submissions constraints', () => {
    it('rejects amount_paisa <= 0 and invalid status', async () => {
      const fixture = await seedStandardGroup(prisma);

      await expect(
        prisma.paymentSubmission.create({
          data: {
            id: generateId(),
            groupId: fixture.group.id,
            memberId: fixture.member1.membership.id,
            periodMonth: new Date('2026-11-01T00:00:00.000Z'),
            amountPaisa: 0n,
            paymentMethod: 'esewa',
            status: 'pending',
          },
        }),
      ).rejects.toThrow();

      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO payment_submissions (id, group_id, member_id, period_month, amount_paisa, payment_method, status)
          VALUES ('${generateId()}'::uuid, '${fixture.group.id}'::uuid, '${fixture.member1.membership.id}'::uuid, '2026-11-01', 5000, 'esewa', 'invalid_status')
        `),
      ).rejects.toThrow();
    });

    it('enforces reference uniqueness on active submissions and allows reuse after rejection', async () => {
      const fixture = await seedStandardGroup(prisma);

      const ref = 'ESEWA-REF-UNIQUE-101';

      // 1. Create first pending submission
      await prisma.paymentSubmission.create({
        data: {
          id: generateId(),
          groupId: fixture.group.id,
          memberId: fixture.member1.membership.id,
          periodMonth: new Date('2026-11-01T00:00:00.000Z'),
          amountPaisa: 500000n,
          paymentMethod: 'esewa',
          reference: ref,
          status: 'pending',
        },
      });

      // 2. Second active (pending) submission with same reference -> rejected by partial unique index
      await expect(
        prisma.paymentSubmission.create({
          data: {
            id: generateId(),
            groupId: fixture.group.id,
            memberId: fixture.member2.membership.id,
            periodMonth: new Date('2026-11-01T00:00:00.000Z'),
            amountPaisa: 500000n,
            paymentMethod: 'esewa',
            reference: ref,
            status: 'pending',
          },
        }),
      ).rejects.toThrow();

      // 3. Mark first submission rejected
      await prisma.paymentSubmission.updateMany({
        where: { groupId: fixture.group.id, reference: ref },
        data: {
          status: 'rejected',
          rejectionReason: 'wrongAmount',
        },
      });

      // 4. Now a new submission with that reference succeeds
      const newSub = await prisma.paymentSubmission.create({
        data: {
          id: generateId(),
          groupId: fixture.group.id,
          memberId: fixture.member2.membership.id,
          periodMonth: new Date('2026-11-01T00:00:00.000Z'),
          amountPaisa: 500000n,
          paymentMethod: 'esewa',
          reference: ref,
          status: 'pending',
        },
      });
      expect(newSub.reference).toBe(ref);
    });
  });

  describe('group_memberships constraints', () => {
    it('enforces active membership uniqueness per user per group and permits rejoining', async () => {
      const fixture = await seedStandardGroup(prisma);

      // Attempting to create a second active membership for member1 in the same group -> rejected
      await expect(
        prisma.groupMembership.create({
          data: {
            id: generateId(),
            groupId: fixture.group.id,
            userId: fixture.member1.user.id,
            isOwner: false,
            isTreasurer: false,
          },
        }),
      ).rejects.toThrow();

      // Soft-delete member1 (set leftAt)
      await prisma.groupMembership.update({
        where: { id: fixture.member1.membership.id },
        data: { leftAt: new Date() },
      });

      // Rejoining after soft-deletion -> accepted
      const rejoined = await prisma.groupMembership.create({
        data: {
          id: generateId(),
          groupId: fixture.group.id,
          userId: fixture.member1.user.id,
          isOwner: false,
          isTreasurer: false,
        },
      });
      expect(rejoined.userId).toBe(fixture.member1.user.id);
    });
  });

  describe('bank_reconciliations constraints', () => {
    it('rejects duplicate reconciliation on the same date for a group and negative balances', async () => {
      const fixture = await seedStandardGroup(prisma);

      const recDate = new Date('2026-11-01T00:00:00.000Z');

      // Create first reconciliation
      await prisma.bankReconciliation.create({
        data: {
          id: generateId(),
          groupId: fixture.group.id,
          statementDate: recDate,
          bankBalancePaisa: 500000n,
          recordedBalancePaisa: 500000n,
          differencePaisa: 0n,
          recordedByMemberId: fixture.owner.membership.id,
        },
      });

      // Duplicate date for same group -> rejected
      await expect(
        prisma.bankReconciliation.create({
          data: {
            id: generateId(),
            groupId: fixture.group.id,
            statementDate: recDate,
            bankBalancePaisa: 600000n,
            recordedBalancePaisa: 500000n,
            differencePaisa: 100000n,
            recordedByMemberId: fixture.owner.membership.id,
          },
        }),
      ).rejects.toThrow();

      // Negative balance -> rejected
      await expect(
        prisma.bankReconciliation.create({
          data: {
            id: generateId(),
            groupId: fixture.group.id,
            statementDate: new Date('2026-12-01T00:00:00.000Z'),
            bankBalancePaisa: -100n,
            recordedBalancePaisa: 500000n,
            differencePaisa: -500100n,
            recordedByMemberId: fixture.owner.membership.id,
          },
        }),
      ).rejects.toThrow();
    });
  });
});
