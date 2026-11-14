import type { PrismaClient } from '@prisma/client';
import { generateId } from '../../../src/infrastructure/db/ids.js';

export interface UserMemberFixture {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly firebaseUid: string;
  };
  readonly membership: {
    readonly id: string;
    readonly isOwner: boolean;
    readonly isTreasurer: boolean;
  };
}

export interface ReportFixture {
  readonly group: {
    readonly id: string;
    readonly name: string;
    readonly expectedPaisa: bigint;
    readonly dueDay: number;
    readonly createdAt: Date;
  };
  readonly nirvan: UserMemberFixture; // Owner + Treasurer
  readonly sita: UserMemberFixture; // Member
  readonly ram: UserMemberFixture; // Member
  readonly hari: UserMemberFixture; // Member
  readonly clockDate: Date;
  readonly pendingSubmissionId: string;
  readonly rejectedSubmissionId: string;
  readonly approvalRequestId: string;
  readonly reconciliationId: string;
}

/**
 * Seeds a group strictly reproducing the Dart report & dashboard story:
 * Group: 'Himalayan Crew', expected NPR 700 (70000 paisa), dueDay 5, created 2026-09-01.
 * 4 active obligated members: Nirvan, Sita, Ram, Hari.
 * Entries:
 * - Sep 2026: 4 verified contributions (700 ea) = 2800. Opening 0, Closing 2800.
 * - Oct 2026: 4 verified contributions (700 ea) = 2800.
 *             Bank interest: +NPR 100 (+10000 paisa).
 *             Group dinner: -NPR 500 (-50000 paisa).
 *             Expense reversal: -NPR 100 orig, +NPR 100 adj (net 0).
 *             Opening 2800, Closing 5200.
 * - Nov 2026: 3 verified contributions (700 ea = 2100): Nirvan, Sita, Ram.
 *             1 pending contribution: Hari NPR 700 (70000 paisa) pending verification.
 *             Opening 5200, Closing 7300, Pending 700.
 *             '3 of 4' members verified.
 * - 1 open approval: Sita requested NPR 2,000 withdrawal for 'Trip equipment'.
 * - 1 matched reconciliation on 2026-10-31: recorded 520000, bank 520000, difference 0.
 */
export async function seedReportFixture(
  prisma: PrismaClient,
): Promise<ReportFixture> {
  const clockDate = new Date('2026-11-06T06:00:00.000Z'); // November 6, 2026 NPT

  // 1. Users
  const nirvanUserId = generateId();
  const sitaUserId = generateId();
  const ramUserId = generateId();
  const hariUserId = generateId();

  await prisma.user.createMany({
    data: [
      {
        id: nirvanUserId,
        firebaseUid: `fb-${nirvanUserId}`,
        email: `nirvan-${nirvanUserId}@example.com`,
        displayName: 'Nirvan',
      },
      {
        id: sitaUserId,
        firebaseUid: `fb-${sitaUserId}`,
        email: `sita-${sitaUserId}@example.com`,
        displayName: 'Sita',
      },
      {
        id: ramUserId,
        firebaseUid: `fb-${ramUserId}`,
        email: `ram-${ramUserId}@example.com`,
        displayName: 'Ram',
      },
      {
        id: hariUserId,
        firebaseUid: `fb-${hariUserId}`,
        email: `hari-${hariUserId}@example.com`,
        displayName: 'Hari',
      },
    ],
  });

  // 2. Group
  const groupId = generateId();
  const groupCreatedAt = new Date('2026-09-01T00:00:00.000Z');

  await prisma.group.create({
    data: {
      id: groupId,
      name: 'Himalayan Crew',
      expectedPaisa: 70000n,
      dueDay: 5,
      createdAt: groupCreatedAt,
      createdByUserId: nirvanUserId,
    },
  });

  // 3. Memberships
  const nirvanMemberId = generateId();
  const sitaMemberId = generateId();
  const ramMemberId = generateId();
  const hariMemberId = generateId();

  await prisma.groupMembership.createMany({
    data: [
      {
        id: nirvanMemberId,
        groupId,
        userId: nirvanUserId,
        isOwner: true,
        isTreasurer: true,
        joinedAt: groupCreatedAt,
      },
      {
        id: sitaMemberId,
        groupId,
        userId: sitaUserId,
        isOwner: false,
        isTreasurer: false,
        joinedAt: groupCreatedAt,
      },
      {
        id: ramMemberId,
        groupId,
        userId: ramUserId,
        isOwner: false,
        isTreasurer: false,
        joinedAt: groupCreatedAt,
      },
      {
        id: hariMemberId,
        groupId,
        userId: hariUserId,
        isOwner: false,
        isTreasurer: false,
        joinedAt: groupCreatedAt,
      },
    ],
  });

  // 4. Ledger Entries
  // September 2026 — 4 contributions, all verified
  const e01Id = generateId();
  const e02Id = generateId();
  const e03Id = generateId();
  const e04Id = generateId();

  // October 2026 — 4 contributions, verified
  const e05Id = generateId();
  const e06Id = generateId();
  const e07Id = generateId();
  const e08Id = generateId();

  // October 2026 — interest + expense + reversal pair
  const e09Id = generateId(); // Bank interest
  const e10Id = generateId(); // Group dinner
  const eRevOrigId = generateId(); // Erroneous expense
  const eRevAdjId = generateId(); // Reversal of erroneous expense

  // November 2026 — 3 verified contributions
  const e11Id = generateId();
  const e12Id = generateId();
  const e13Id = generateId();

  await prisma.ledgerEntry.createMany({
    data: [
      // September
      {
        id: e01Id,
        groupId,
        kind: 'contribution',
        title: "Nirvan's contribution",
        occurredAt: new Date('2026-09-01T04:00:00.000Z'),
        magnitudePaisa: 70000n,
        paymentMethod: 'esewa',
        memberId: nirvanMemberId,
        periodMonth: new Date('2026-09-01'),
        actorMemberId: nirvanMemberId,
      },
      {
        id: e02Id,
        groupId,
        kind: 'contribution',
        title: "Sita's contribution",
        occurredAt: new Date('2026-09-02T04:00:00.000Z'),
        magnitudePaisa: 70000n,
        paymentMethod: 'khalti',
        memberId: sitaMemberId,
        periodMonth: new Date('2026-09-01'),
        actorMemberId: nirvanMemberId,
      },
      {
        id: e03Id,
        groupId,
        kind: 'contribution',
        title: "Ram's contribution",
        occurredAt: new Date('2026-09-03T04:00:00.000Z'),
        magnitudePaisa: 70000n,
        paymentMethod: 'bankTransfer',
        memberId: ramMemberId,
        periodMonth: new Date('2026-09-01'),
        actorMemberId: nirvanMemberId,
      },
      {
        id: e04Id,
        groupId,
        kind: 'contribution',
        title: "Hari's contribution",
        occurredAt: new Date('2026-09-04T04:00:00.000Z'),
        magnitudePaisa: 70000n,
        paymentMethod: 'cash',
        memberId: hariMemberId,
        periodMonth: new Date('2026-09-01'),
        actorMemberId: nirvanMemberId,
      },
      // October
      {
        id: e05Id,
        groupId,
        kind: 'contribution',
        title: "Nirvan's contribution",
        occurredAt: new Date('2026-10-01T04:00:00.000Z'),
        magnitudePaisa: 70000n,
        paymentMethod: 'esewa',
        memberId: nirvanMemberId,
        periodMonth: new Date('2026-10-01'),
        actorMemberId: nirvanMemberId,
      },
      {
        id: e06Id,
        groupId,
        kind: 'contribution',
        title: "Sita's contribution",
        occurredAt: new Date('2026-10-02T04:00:00.000Z'),
        magnitudePaisa: 70000n,
        paymentMethod: 'khalti',
        memberId: sitaMemberId,
        periodMonth: new Date('2026-10-01'),
        actorMemberId: nirvanMemberId,
      },
      {
        id: e07Id,
        groupId,
        kind: 'contribution',
        title: "Ram's contribution",
        occurredAt: new Date('2026-10-03T04:00:00.000Z'),
        magnitudePaisa: 70000n,
        paymentMethod: 'bankTransfer',
        memberId: ramMemberId,
        periodMonth: new Date('2026-10-01'),
        actorMemberId: nirvanMemberId,
      },
      {
        id: e08Id,
        groupId,
        kind: 'contribution',
        title: "Hari's contribution",
        occurredAt: new Date('2026-10-04T04:00:00.000Z'),
        magnitudePaisa: 70000n,
        paymentMethod: 'cash',
        memberId: hariMemberId,
        periodMonth: new Date('2026-10-01'),
        actorMemberId: nirvanMemberId,
      },
      {
        id: e09Id,
        groupId,
        kind: 'interest',
        title: 'Bank interest',
        occurredAt: new Date('2026-10-28T04:00:00.000Z'),
        magnitudePaisa: 10000n,
        actorMemberId: nirvanMemberId,
        note: 'Savings account interest',
      },
      {
        id: e10Id,
        groupId,
        kind: 'expense',
        title: 'Group dinner',
        occurredAt: new Date('2026-10-30T04:00:00.000Z'),
        magnitudePaisa: 50000n,
        paymentMethod: 'cash',
        actorMemberId: nirvanMemberId,
        note: 'Monthly group dinner',
      },
      {
        id: eRevOrigId,
        groupId,
        kind: 'expense',
        title: 'Erroneous snack',
        occurredAt: new Date('2026-10-20T04:00:00.000Z'),
        magnitudePaisa: 10000n,
        paymentMethod: 'cash',
        actorMemberId: nirvanMemberId,
      },
      {
        id: eRevAdjId,
        groupId,
        kind: 'expense',
        title: 'Snack correction',
        occurredAt: new Date('2026-10-21T04:00:00.000Z'),
        magnitudePaisa: 10000n,
        paymentMethod: 'cash',
        actorMemberId: nirvanMemberId,
        reversesEntryId: eRevOrigId,
      },
      // November
      {
        id: e11Id,
        groupId,
        kind: 'contribution',
        title: "Nirvan's contribution",
        occurredAt: new Date('2026-11-01T04:00:00.000Z'),
        magnitudePaisa: 70000n,
        paymentMethod: 'esewa',
        memberId: nirvanMemberId,
        periodMonth: new Date('2026-11-01'),
        actorMemberId: nirvanMemberId,
      },
      {
        id: e12Id,
        groupId,
        kind: 'contribution',
        title: "Sita's contribution",
        occurredAt: new Date('2026-11-02T04:00:00.000Z'),
        magnitudePaisa: 70000n,
        paymentMethod: 'khalti',
        memberId: sitaMemberId,
        periodMonth: new Date('2026-11-01'),
        actorMemberId: nirvanMemberId,
      },
      {
        id: e13Id,
        groupId,
        kind: 'contribution',
        title: "Ram's contribution",
        occurredAt: new Date('2026-11-03T04:00:00.000Z'),
        magnitudePaisa: 70000n,
        paymentMethod: 'bankTransfer',
        memberId: ramMemberId,
        periodMonth: new Date('2026-11-01'),
        actorMemberId: nirvanMemberId,
      },
    ],
  });

  // 5. Payment Submissions:
  // - Hari pending in November (amount NPR 700)
  const pendingSubmissionId = generateId();
  // - A rejected submission in October
  const rejectedSubmissionId = generateId();

  await prisma.paymentSubmission.createMany({
    data: [
      {
        id: pendingSubmissionId,
        groupId,
        memberId: hariMemberId,
        periodMonth: new Date('2026-11-01'),
        amountPaisa: 70000n,
        paymentMethod: 'cash',
        status: 'pending',
        submittedAt: new Date('2026-11-04T04:00:00.000Z'),
      },
      {
        id: rejectedSubmissionId,
        groupId,
        memberId: hariMemberId,
        periodMonth: new Date('2026-10-01'),
        amountPaisa: 70000n,
        paymentMethod: 'esewa',
        reference: 'TXN-REJ-999',
        status: 'rejected',
        rejectionReason: 'referenceNotFound',
        rejectionNote: 'Reference not found in statement',
        // submittedAt BEFORE Hari's verified ledger entry (e08: 2026-10-04)
        // so the verified ledger entry wins in deriveObligationStatus → verifiedCount=4
        submittedAt: new Date('2026-10-02T04:00:00.000Z'),
        reviewedByMemberId: nirvanMemberId,
        reviewedAt: new Date('2026-10-03T04:00:00.000Z'),
      },
    ],
  });

  // 6. Approval Request
  // Sita requested NPR 2,000 withdrawal for 'Trip equipment'. Nirvan voted yes. Ram & Hari need to vote.
  const approvalRequestId = generateId();
  await prisma.approvalRequest.create({
    data: {
      id: approvalRequestId,
      groupId,
      requesterMemberId: sitaMemberId,
      kind: 'withdrawal',
      title: 'Trip equipment',
      amountPaisa: 200000n,
      payee: 'Mountain Store',
      status: 'open',
      createdAt: new Date('2026-11-05T10:00:00.000Z'),
      expiresAt: new Date('2026-11-12T10:00:00.000Z'),
      eligibleVoters: {
        create: [
          { memberId: nirvanMemberId },
          { memberId: ramMemberId },
          { memberId: hariMemberId },
        ],
      },
      votes: {
        create: [
          {
            memberId: nirvanMemberId,
            approve: true,
            votedAt: new Date('2026-11-05T11:00:00.000Z'),
          },
        ],
      },
    },
  });

  // 7. Bank Reconciliation
  // 31 Oct 2026: recorded 520000, bank 520000, difference 0, matched
  const reconciliationId = generateId();
  await prisma.bankReconciliation.create({
    data: {
      id: reconciliationId,
      groupId,
      statementDate: new Date('2026-10-31'),
      bankBalancePaisa: 520000n,
      recordedBalancePaisa: 520000n,
      differencePaisa: 0n,
      recordedByMemberId: nirvanMemberId,
      recordedAt: new Date('2026-11-01T12:00:00.000Z'),
      note: 'October statement reconciliation',
    },
  });

  return {
    group: {
      id: groupId,
      name: 'Himalayan Crew',
      expectedPaisa: 70000n,
      dueDay: 5,
      createdAt: groupCreatedAt,
    },
    nirvan: {
      user: {
        id: nirvanUserId,
        email: `nirvan-${nirvanUserId}@example.com`,
        displayName: 'Nirvan',
        firebaseUid: `fb-${nirvanUserId}`,
      },
      membership: {
        id: nirvanMemberId,
        isOwner: true,
        isTreasurer: true,
      },
    },
    sita: {
      user: {
        id: sitaUserId,
        email: `sita-${sitaUserId}@example.com`,
        displayName: 'Sita',
        firebaseUid: `fb-${sitaUserId}`,
      },
      membership: {
        id: sitaMemberId,
        isOwner: false,
        isTreasurer: false,
      },
    },
    ram: {
      user: {
        id: ramUserId,
        email: `ram-${ramUserId}@example.com`,
        displayName: 'Ram',
        firebaseUid: `fb-${ramUserId}`,
      },
      membership: {
        id: ramMemberId,
        isOwner: false,
        isTreasurer: false,
      },
    },
    hari: {
      user: {
        id: hariUserId,
        email: `hari-${hariUserId}@example.com`,
        displayName: 'Hari',
        firebaseUid: `fb-${hariUserId}`,
      },
      membership: {
        id: hariMemberId,
        isOwner: false,
        isTreasurer: false,
      },
    },
    clockDate,
    pendingSubmissionId,
    rejectedSubmissionId,
    approvalRequestId,
    reconciliationId,
  };
}
