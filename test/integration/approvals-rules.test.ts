/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { GroupMembership, PrismaClient, User } from '@prisma/client';
import { createApp } from '../../src/http/app.js';
import type { AppConfig } from '../../src/config/env.js';
import { generateId } from '../../src/infrastructure/db/ids.js';
import { FakeTokenVerifier } from '../support/fake-token-verifier.js';
import {
  closeAllTestClients,
  getTestDirectPrisma,
  getTestPrisma,
  resetTestDatabase,
} from './setup.js';

interface MemberFixture {
  readonly user: User;
  readonly membership: GroupMembership;
  readonly token: string;
}

interface DynamicGroupFixture {
  readonly group: { id: string; name: string };
  readonly members: MemberFixture[];
  readonly owner: MemberFixture;
}

async function seedNMemberFixture(
  prisma: PrismaClient,
  count: number,
  options?: {
    readonly initialBalancePaisa?: bigint;
    readonly extraTreasurers?: number[];
  },
): Promise<DynamicGroupFixture> {
  const createdUsers: User[] = [];
  for (let i = 0; i < count; i++) {
    const id = generateId();
    const u = await prisma.user.create({
      data: {
        id,
        firebaseUid: `fb-${id}`,
        email: `user_${id.slice(0, 8)}@example.com`,
        displayName: i === 0 ? 'Group Owner' : `Member ${i}`,
      },
    });
    createdUsers.push(u);
  }

  const groupId = generateId();
  const group = await prisma.group.create({
    data: {
      id: groupId,
      name: `Group with ${count} members`,
      expectedPaisa: 500000n,
      dueDay: 15,
      createdByUserId: createdUsers[0]!.id,
    },
  });

  const memberFixtures: MemberFixture[] = [];
  for (let i = 0; i < count; i++) {
    const memId = generateId();
    const isOwner = i === 0;
    const isTreasurer =
      isOwner || (options?.extraTreasurers?.includes(i) ?? false);
    const membership = await prisma.groupMembership.create({
      data: {
        id: memId,
        groupId,
        userId: createdUsers[i]!.id,
        isOwner,
        isTreasurer,
      },
    });
    const token = FakeTokenVerifier.createToken(
      createdUsers[i]!.firebaseUid,
      createdUsers[i]!.email,
      true,
    );
    memberFixtures.push({
      user: createdUsers[i]!,
      membership,
      token,
    });
  }

  if (options?.initialBalancePaisa) {
    await prisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId,
        kind: 'contribution',
        title: 'Initial Seed Balance',
        magnitudePaisa: options.initialBalancePaisa,
        occurredAt: new Date('2026-11-01T10:00:00.000Z'),
        postedAt: new Date('2026-11-01T10:00:00.000Z'),
        actorMemberId: memberFixtures[0]!.membership.id,
        memberId: memberFixtures[0]!.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        paymentMethod: 'cash',
      },
    });
  }

  return {
    group: { id: groupId, name: group.name },
    members: memberFixtures,
    owner: memberFixtures[0]!,
  };
}

describe('Approvals Deep Coverage & Edge Rules HTTP Suite', () => {
  const prisma = getTestPrisma();
  const directPrisma = getTestDirectPrisma();

  const testConfig: AppConfig = {
    PORT: 3000,
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    TRUST_PROXY_HOPS: 1,
    REQUIRE_VERIFIED_EMAIL: true,
    DATABASE_URL: process.env['DATABASE_URL'] ?? '',
  };

  const app = createApp({
    prisma,
    config: testConfig,
    tokenVerifier: new FakeTokenVerifier(),
    logger: pino({ level: 'silent' }),
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeAllTestClients();
  });

  // =========================================================================
  // 1. Table-driven votesNeeded and Early Rejection for eligible counts 2..8
  // =========================================================================
  describe('1. votesNeeded and early rejection table-driven (eligible 2..8)', () => {
    const TABLE = [
      { eligible: 2, roster: 3, votesNeeded: 2, minRejectionsForEarly: 1 },
      { eligible: 3, roster: 4, votesNeeded: 2, minRejectionsForEarly: 2 },
      { eligible: 4, roster: 5, votesNeeded: 3, minRejectionsForEarly: 2 },
      { eligible: 5, roster: 6, votesNeeded: 3, minRejectionsForEarly: 3 },
      { eligible: 6, roster: 7, votesNeeded: 4, minRejectionsForEarly: 3 },
      { eligible: 7, roster: 8, votesNeeded: 4, minRejectionsForEarly: 4 },
      { eligible: 8, roster: 9, votesNeeded: 5, minRejectionsForEarly: 4 },
    ];

    for (const row of TABLE) {
      it(`evaluates eligible=${row.eligible} (roster=${row.roster}): votesNeeded=${row.votesNeeded}, earlyRejectionAt=${row.minRejectionsForEarly}`, async () => {
        const fixture = await seedNMemberFixture(directPrisma, row.roster, {
          initialBalancePaisa: 5000000n,
        });

        const requester = fixture.members[0]!;
        const voters = fixture.members.slice(1);
        expect(voters).toHaveLength(row.eligible);

        // A. Approval path: approve exactly votesNeeded-1 times -> open, one more -> approved
        const reqA = await request(app)
          .post(`/v1/groups/${fixture.group.id}/approvals`)
          .set('Authorization', `Bearer ${requester.token}`)
          .set('Idempotency-Key', generateId())
          .send({
            kind: 'expense',
            amountPaisa: 10000,
            title: `Table approval ${row.eligible}`,
            payee: 'Store',
          });
        expect(reqA.status).toBe(201);
        expect(reqA.body.eligibleCount).toBe(row.eligible);
        expect(reqA.body.votesNeeded).toBe(row.votesNeeded);

        const approvalIdA = reqA.body.id;

        // Vote approve votesNeeded - 1 times
        for (let i = 0; i < row.votesNeeded - 1; i++) {
          const vRes = await request(app)
            .post(
              `/v1/groups/${fixture.group.id}/approvals/${approvalIdA}/votes`,
            )
            .set('Authorization', `Bearer ${voters[i]!.token}`)
            .set('Idempotency-Key', generateId())
            .send({ vote: 'approve' });
          expect(vRes.status).toBe(200);
          expect(vRes.body.status).toBe('open');
          expect(vRes.body.approveCount).toBe(i + 1);
        }

        // Final deciding vote
        const finalApprove = await request(app)
          .post(`/v1/groups/${fixture.group.id}/approvals/${approvalIdA}/votes`)
          .set('Authorization', `Bearer ${voters[row.votesNeeded - 1]!.token}`)
          .set('Idempotency-Key', generateId())
          .send({ vote: 'approve' });
        expect(finalApprove.status).toBe(200);
        expect(finalApprove.body.status).toBe('approved');
        expect(finalApprove.body.approveCount).toBe(row.votesNeeded);

        // B. Rejection path: reject minRejectionsForEarly - 1 times -> open, one more -> rejected
        const reqB = await request(app)
          .post(`/v1/groups/${fixture.group.id}/approvals`)
          .set('Authorization', `Bearer ${requester.token}`)
          .set('Idempotency-Key', generateId())
          .send({
            kind: 'withdrawal',
            amountPaisa: 20000,
            title: `Table rejection ${row.eligible}`,
            payee: 'Vendor',
          });
        expect(reqB.status).toBe(201);
        const approvalIdB = reqB.body.id;

        for (let i = 0; i < row.minRejectionsForEarly - 1; i++) {
          const vRes = await request(app)
            .post(
              `/v1/groups/${fixture.group.id}/approvals/${approvalIdB}/votes`,
            )
            .set('Authorization', `Bearer ${voters[i]!.token}`)
            .set('Idempotency-Key', generateId())
            .send({ vote: 'reject' });
          expect(vRes.status).toBe(200);
          expect(vRes.body.status).toBe('open');
          expect(vRes.body.rejectCount).toBe(i + 1);
        }

        // Final deciding rejection triggers early rejection
        const finalReject = await request(app)
          .post(`/v1/groups/${fixture.group.id}/approvals/${approvalIdB}/votes`)
          .set(
            'Authorization',
            `Bearer ${voters[row.minRejectionsForEarly - 1]!.token}`,
          )
          .set('Idempotency-Key', generateId())
          .send({ vote: 'reject' });
        expect(finalReject.status).toBe(200);
        expect(finalReject.body.status).toBe('rejected');
        expect(finalReject.body.rejectCount).toBe(row.minRejectionsForEarly);
      });
    }
  });

  // =========================================================================
  // 2. Voting Idempotency, Duplicate Rejection & Conflict
  // =========================================================================
  it('enforces single-vote invariant, exact replay with header, and conflict detection', async () => {
    const fixture = await seedNMemberFixture(directPrisma, 4, {
      initialBalancePaisa: 1000000n,
    });
    const requester = fixture.members[0]!;
    const voter = fixture.members[1]!;

    const createRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${requester.token}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'expense',
        amountPaisa: 50000,
        title: 'Dinner Bill',
        payee: 'Restaurant',
      });
    expect(createRes.status).toBe(201);
    const approvalId = createRes.body.id;

    const voteKey = 'vote_idempotency_key_12345';

    // First vote
    const vote1 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${voter.token}`)
      .set('Idempotency-Key', voteKey)
      .send({ vote: 'approve' });
    expect(vote1.status).toBe(200);
    expect(vote1.headers['idempotent-replay']).toBeUndefined();
    expect(vote1.body.approveCount).toBe(1);

    // Exact replay with same key -> 200 with Idempotent-Replay: true
    const replay = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${voter.token}`)
      .set('Idempotency-Key', voteKey)
      .send({ vote: 'approve' });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.id).toBe(vote1.body.id);

    // Conflict: same key with different body -> 409 idempotency_conflict
    const conflict = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${voter.token}`)
      .set('Idempotency-Key', voteKey)
      .send({ vote: 'reject' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('idempotency_conflict');

    // Second vote with NEW key -> 409 already_voted
    const secondVote = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${voter.token}`)
      .set('Idempotency-Key', generateId())
      .send({ vote: 'approve' });
    expect(secondVote.status).toBe(409);
    expect(secondVote.body.error.code).toBe('already_voted');
  });

  // =========================================================================
  // 3. Idempotency Key Validation & Actor Scoping on Cancel, Execute, Vote
  // =========================================================================
  it('validates idempotency keys and respects actor scoping across operations', async () => {
    const fixture = await seedNMemberFixture(directPrisma, 4, {
      initialBalancePaisa: 1000000n,
      extraTreasurers: [1],
    });
    const requester = fixture.members[0]!;
    const voter1 = fixture.members[1]!;
    const voter2 = fixture.members[2]!;

    const reqRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${requester.token}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'withdrawal',
        amountPaisa: 30000,
        title: 'Gear Purchase',
        payee: 'Gear Store',
      });
    expect(reqRes.status).toBe(201);
    const approvalId = reqRes.body.id;

    // A. Missing idempotency key on vote -> 400 idempotency_key_required
    const noKeyVote = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${voter1.token}`)
      .send({ vote: 'approve' });
    expect(noKeyVote.status).toBe(400);
    expect(noKeyVote.body.error.code).toBe('idempotency_key_required');

    // B. Malformed key (too short < 8 chars) -> 400 invalid_idempotency_key
    const badKeyVote = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${voter1.token}`)
      .set('Idempotency-Key', 'short')
      .send({ vote: 'approve' });
    expect(badKeyVote.status).toBe(400);
    expect(badKeyVote.body.error.code).toBe('invalid_idempotency_key');

    // C. Actor scoping: voter1 and voter2 use the SAME key string -> both succeed
    const sharedKey = 'shared_voter_key_99999';
    const voteV1 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${voter1.token}`)
      .set('Idempotency-Key', sharedKey)
      .send({ vote: 'approve' });
    expect(voteV1.status).toBe(200);

    const voteV2 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${voter2.token}`)
      .set('Idempotency-Key', sharedKey)
      .send({ vote: 'approve' });
    expect(voteV2.status).toBe(200);
    expect(voteV2.body.approveCount).toBe(2);

    // D. Missing key on cancel
    const noKeyCancel = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/cancel`)
      .set('Authorization', `Bearer ${requester.token}`);
    expect(noKeyCancel.status).toBe(400);
    expect(noKeyCancel.body.error.code).toBe('idempotency_key_required');

    // E. Missing key on execute
    const noKeyExec = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/execute`)
      .set('Authorization', `Bearer ${voter1.token}`)
      .send({ method: 'cash' });
    expect(noKeyExec.status).toBe(400);
    expect(noKeyExec.body.error.code).toBe('idempotency_key_required');
  });

  // =========================================================================
  // 4. Cancellation Rules & Status Preconditions
  // =========================================================================
  it('enforces cancellation permissions and status preconditions', async () => {
    const fixture = await seedNMemberFixture(directPrisma, 4, {
      initialBalancePaisa: 1000000n,
      extraTreasurers: [1],
    });
    const requester = fixture.members[0]!;
    const otherMember = fixture.members[1]!;
    const voter = fixture.members[2]!;

    // Create approval
    const createRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${requester.token}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'expense',
        amountPaisa: 40000,
        title: 'Cancel Test',
        payee: 'Shop',
      });
    const approvalId = createRes.body.id;

    // Non-requester cannot cancel -> 403 forbidden
    const nonReqCancel = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/cancel`)
      .set('Authorization', `Bearer ${otherMember.token}`)
      .set('Idempotency-Key', generateId());
    expect(nonReqCancel.status).toBe(403);
    expect(nonReqCancel.body.error.code).toBe('forbidden');

    // Requester cancels open request -> 200, status becomes cancelled
    const cancelRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/cancel`)
      .set('Authorization', `Bearer ${requester.token}`)
      .set('Idempotency-Key', generateId());
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('cancelled');

    // Canceling an already-cancelled request -> 409 approval_not_open
    const cancelAgain = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/cancel`)
      .set('Authorization', `Bearer ${requester.token}`)
      .set('Idempotency-Key', generateId());
    expect(cancelAgain.status).toBe(409);
    expect(cancelAgain.body.error.code).toBe('approval_not_open');

    // Check audit log: approval.cancelled written exactly once
    const cancelAudits = await directPrisma.auditLog.findMany({
      where: {
        groupId: fixture.group.id,
        action: 'approval.cancelled',
      },
    });
    expect(cancelAudits).toHaveLength(1);

    // Voting on cancelled request -> 409 approval_not_open
    const voteCancelled = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${voter.token}`)
      .set('Idempotency-Key', generateId())
      .send({ vote: 'approve' });
    expect(voteCancelled.status).toBe(409);
    expect(voteCancelled.body.error.code).toBe('approval_not_open');
  });

  // =========================================================================
  // 5. Execution Preconditions, Client Tampering & Live Balance Guard
  // =========================================================================
  it('enforces execution role gates, rejects client financial fields, and re-checks live balance', async () => {
    const fixture = await seedNMemberFixture(directPrisma, 4, {
      initialBalancePaisa: 50000n, // Exactly NPR 500
      extraTreasurers: [1],
    });
    const requester = fixture.members[0]!;
    const treasurer = fixture.members[1]!;
    const plainMember = fixture.members[2]!;
    const voter = fixture.members[3]!;

    // Create approval for NPR 500 (50,000 paisa)
    const createRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${requester.token}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'expense',
        amountPaisa: 50000,
        title: 'Original Expense Title',
        payee: 'Approved Payee LLC',
      });
    expect(createRes.status).toBe(201);
    const approvalId = createRes.body.id;

    // Try executing while still open -> 409 approval_not_approved
    const earlyExec = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/execute`)
      .set('Authorization', `Bearer ${treasurer.token}`)
      .set('Idempotency-Key', generateId())
      .send({ method: 'cash' });
    expect(earlyExec.status).toBe(409);
    expect(earlyExec.body.error.code).toBe('approval_not_approved');

    // Approve the request (needs 2 votes for eligible=3)
    await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${treasurer.token}`)
      .set('Idempotency-Key', generateId())
      .send({ vote: 'approve' });

    await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${voter.token}`)
      .set('Idempotency-Key', generateId())
      .send({ vote: 'approve' });

    // Non-treasurer attempts execution -> 403 forbidden
    const nonTreasExec = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/execute`)
      .set('Authorization', `Bearer ${plainMember.token}`)
      .set('Idempotency-Key', generateId())
      .send({ method: 'cash' });
    expect(nonTreasExec.status).toBe(403);
    expect(nonTreasExec.body.error.code).toBe('forbidden');

    // Client tampering: sending amount, title, or payee in execute body -> 400 invalid_approval_input
    const tamperExec = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/execute`)
      .set('Authorization', `Bearer ${treasurer.token}`)
      .set('Idempotency-Key', generateId())
      .send({
        method: 'cash',
        amountPaisa: 10000,
        title: 'Hacked Title',
        payee: 'Hacker',
      });
    expect(tamperExec.status).toBe(400);
    expect(tamperExec.body.error.code).toBe('invalid_approval_input');

    // Invalid payment method -> 400 invalid_approval_input
    const badMethodExec = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/execute`)
      .set('Authorization', `Bearer ${treasurer.token}`)
      .set('Idempotency-Key', generateId())
      .send({ method: 'bitcoin' });
    expect(badMethodExec.status).toBe(400);
    expect(badMethodExec.body.error.code).toBe('invalid_approval_input');

    // Live balance re-check failure:
    // Spend NPR 100 via direct transaction, leaving only NPR 400 (40,000 paisa)
    await request(app)
      .post(`/v1/groups/${fixture.group.id}/transactions`)
      .set('Authorization', `Bearer ${treasurer.token}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'expense',
        amountPaisa: 10000,
        title: 'Intermediate Expense',
        occurredAt: new Date().toISOString(),
      });

    // Execute approved request of NPR 500 when only NPR 400 remains -> 409 insufficient_balance
    const balanceFailExec = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/execute`)
      .set('Authorization', `Bearer ${treasurer.token}`)
      .set('Idempotency-Key', generateId())
      .send({ method: 'cash' });
    expect(balanceFailExec.status).toBe(409);
    expect(balanceFailExec.body.error.code).toBe('insufficient_balance');

    // Ensure request remains approved
    const statusCheck = await request(app)
      .get(`/v1/groups/${fixture.group.id}/approvals/${approvalId}`)
      .set('Authorization', `Bearer ${treasurer.token}`);
    expect(statusCheck.body.status).toBe('approved');

    // Deposit more funds so balance is NPR 1,400
    await request(app)
      .post(`/v1/groups/${fixture.group.id}/transactions`)
      .set('Authorization', `Bearer ${treasurer.token}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'interest',
        amountPaisa: 100000,
        title: 'Interest Deposit',
        occurredAt: new Date().toISOString(),
      });

    // Execute now succeeds
    const execSuccess = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/execute`)
      .set('Authorization', `Bearer ${treasurer.token}`)
      .set('Idempotency-Key', generateId())
      .send({ method: 'cash' });
    expect(execSuccess.status).toBe(200);
    expect(execSuccess.body.status).toBe('executed');

    // Verify created ledger entry attributes match the stored request exactly
    const executedTxId = execSuccess.body.executedTransactionId;
    expect(executedTxId).toMatch(/^ledger:/);
    const ledgerRawId = (executedTxId as string).replace('ledger:', '');

    const ledgerRow = await directPrisma.ledgerEntry.findUnique({
      where: { id: ledgerRawId },
    });
    expect(ledgerRow).not.toBeNull();
    expect(Number(ledgerRow!.magnitudePaisa)).toBe(50000);
    expect(ledgerRow!.title).toBe('Original Expense Title');
    expect(ledgerRow!.kind).toBe('expense');
  });

  // =========================================================================
  // 6. Concurrency Guarantees (Repeated 5 times in a loop)
  // =========================================================================
  describe('6. Concurrency Guarantees (repeated 5 times)', () => {
    it('(a) dual treasurers executing the same approved request at once', async () => {
      for (let run = 1; run <= 5; run++) {
        await resetTestDatabase();
        const fixture = await seedNMemberFixture(directPrisma, 4, {
          initialBalancePaisa: 500000n,
          extraTreasurers: [1],
        });
        const requester = fixture.members[2]!;
        const treasurer1 = fixture.members[0]!;
        const treasurer2 = fixture.members[1]!;

        const req = await request(app)
          .post(`/v1/groups/${fixture.group.id}/approvals`)
          .set('Authorization', `Bearer ${requester.token}`)
          .set('Idempotency-Key', generateId())
          .send({
            kind: 'expense',
            amountPaisa: 100000,
            title: `Concurrent Exec ${run}`,
            payee: 'Vendor',
          });
        const approvalId = req.body.id;

        // Approve
        await request(app)
          .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
          .set('Authorization', `Bearer ${treasurer1.token}`)
          .set('Idempotency-Key', generateId())
          .send({ vote: 'approve' });
        await request(app)
          .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
          .set('Authorization', `Bearer ${treasurer2.token}`)
          .set('Idempotency-Key', generateId())
          .send({ vote: 'approve' });

        // Concurrent execution with different keys
        const [res1, res2] = await Promise.all([
          request(app)
            .post(
              `/v1/groups/${fixture.group.id}/approvals/${approvalId}/execute`,
            )
            .set('Authorization', `Bearer ${treasurer1.token}`)
            .set('Idempotency-Key', generateId())
            .send({ method: 'cash' }),
          request(app)
            .post(
              `/v1/groups/${fixture.group.id}/approvals/${approvalId}/execute`,
            )
            .set('Authorization', `Bearer ${treasurer2.token}`)
            .set('Idempotency-Key', generateId())
            .send({ method: 'cash' }),
        ]);

        const statuses = [res1.status, res2.status].sort();
        expect(statuses).toEqual([200, 409]);

        const conflictRes = res1.status === 409 ? res1 : res2;
        expect(conflictRes.body.error.code).toBe('approval_already_executed');

        // Exactly one ledger row written
        const ledgerRows = await directPrisma.ledgerEntry.findMany({
          where: { groupId: fixture.group.id, kind: 'expense' },
        });
        expect(ledgerRows).toHaveLength(1);

        // Exactly one approval.executed audit row
        const execAudits = await directPrisma.auditLog.findMany({
          where: {
            groupId: fixture.group.id,
            action: 'approval.executed',
          },
        });
        expect(execAudits).toHaveLength(1);
      }
    });

    it('(b) concurrent deciding votes yield consistent final status and exactly one approval.decided audit row', async () => {
      for (let run = 1; run <= 5; run++) {
        await resetTestDatabase();
        // 5 members -> eligible=4, votesNeeded=3
        const fixture = await seedNMemberFixture(directPrisma, 5, {
          initialBalancePaisa: 500000n,
        });
        const requester = fixture.members[0]!;
        const voter1 = fixture.members[1]!;
        const voter2 = fixture.members[2]!;
        const voter3 = fixture.members[3]!;

        const req = await request(app)
          .post(`/v1/groups/${fixture.group.id}/approvals`)
          .set('Authorization', `Bearer ${requester.token}`)
          .set('Idempotency-Key', generateId())
          .send({
            kind: 'withdrawal',
            amountPaisa: 50000,
            title: `Vote Race ${run}`,
            payee: 'Payee',
          });
        const approvalId = req.body.id;

        // 3 eligible voters vote approve in parallel
        await Promise.all([
          request(app)
            .post(
              `/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`,
            )
            .set('Authorization', `Bearer ${voter1.token}`)
            .set('Idempotency-Key', generateId())
            .send({ vote: 'approve' }),
          request(app)
            .post(
              `/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`,
            )
            .set('Authorization', `Bearer ${voter2.token}`)
            .set('Idempotency-Key', generateId())
            .send({ vote: 'approve' }),
          request(app)
            .post(
              `/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`,
            )
            .set('Authorization', `Bearer ${voter3.token}`)
            .set('Idempotency-Key', generateId())
            .send({ vote: 'approve' }),
        ]);

        // Check final status is approved
        const detail = await request(app)
          .get(`/v1/groups/${fixture.group.id}/approvals/${approvalId}`)
          .set('Authorization', `Bearer ${requester.token}`);
        expect(detail.body.status).toBe('approved');
        expect(detail.body.approveCount).toBeGreaterThanOrEqual(3);

        // Exactly ONE approval.decided audit log entry
        const decidedAudits = await directPrisma.auditLog.findMany({
          where: {
            groupId: fixture.group.id,
            action: 'approval.decided',
          },
        });
        expect(decidedAudits).toHaveLength(1);
      }
    });

    it('(c) 5 concurrent identical execute requests with the SAME idempotency key', async () => {
      for (let run = 1; run <= 5; run++) {
        await resetTestDatabase();
        const fixture = await seedNMemberFixture(directPrisma, 4, {
          initialBalancePaisa: 500000n,
        });
        const requester = fixture.members[1]!;
        const treasurer = fixture.members[0]!;

        const req = await request(app)
          .post(`/v1/groups/${fixture.group.id}/approvals`)
          .set('Authorization', `Bearer ${requester.token}`)
          .set('Idempotency-Key', generateId())
          .send({
            kind: 'expense',
            amountPaisa: 25000,
            title: `Replay Exec ${run}`,
            payee: 'Store',
          });
        const approvalId = req.body.id;

        // Approve
        await request(app)
          .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
          .set('Authorization', `Bearer ${treasurer.token}`)
          .set('Idempotency-Key', generateId())
          .send({ vote: 'approve' });
        await request(app)
          .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
          .set('Authorization', `Bearer ${fixture.members[2]!.token}`)
          .set('Idempotency-Key', generateId())
          .send({ vote: 'approve' });

        const sameKey = `exec_same_key_${run}_12345678`;

        // 5 concurrent requests with identical idempotency key
        const responses = await Promise.all(
          Array.from({ length: 5 }, () =>
            request(app)
              .post(
                `/v1/groups/${fixture.group.id}/approvals/${approvalId}/execute`,
              )
              .set('Authorization', `Bearer ${treasurer.token}`)
              .set('Idempotency-Key', sameKey)
              .send({ method: 'cash' }),
          ),
        );

        for (const res of responses) {
          expect(res.status).toBe(200);
          expect(res.body.status).toBe('executed');
          expect(res.body.executedTransactionId).toBe(
            responses[0]!.body.executedTransactionId,
          );
        }

        // Exactly one ledger row written
        const ledgerRows = await directPrisma.ledgerEntry.findMany({
          where: { groupId: fixture.group.id, kind: 'expense' },
        });
        expect(ledgerRows).toHaveLength(1);
      }
    });
  });

  // =========================================================================
  // 7. Expiry Boundaries Through Controllable Clock
  // =========================================================================
  describe('7. Expiry boundaries through controllable clock', () => {
    it('flips status at exact 7-day NPT boundary, blocks voting/execution, and keeps approved immune to expiry', async () => {
      let currentClock = new Date('2026-11-01T10:00:00.000Z');

      const timedApp = createApp({
        prisma,
        config: testConfig,
        tokenVerifier: new FakeTokenVerifier(),
        clock: () => currentClock,
        logger: pino({ level: 'silent' }),
      });

      const fixture = await seedNMemberFixture(directPrisma, 4, {
        initialBalancePaisa: 1000000n,
        extraTreasurers: [1],
      });
      const requester = fixture.members[0]!;
      const voter = fixture.members[1]!;

      // Create approval at 2026-11-01T10:00:00.000Z
      const reqRes = await request(timedApp)
        .post(`/v1/groups/${fixture.group.id}/approvals`)
        .set('Authorization', `Bearer ${requester.token}`)
        .set('Idempotency-Key', generateId())
        .send({
          kind: 'expense',
          amountPaisa: 50000,
          title: 'Clock Test',
          payee: 'Clock Payee',
        });
      expect(reqRes.status).toBe(201);
      const approvalId = reqRes.body.id;
      expect(reqRes.body.status).toBe('open');

      // 7 days later: 2026-11-08T10:00:00.000Z
      // 1 second BEFORE expiry: 2026-11-08T09:59:59.000Z -> still open
      currentClock = new Date('2026-11-08T09:59:59.000Z');
      const beforeRes = await request(timedApp)
        .get(`/v1/groups/${fixture.group.id}/approvals/${approvalId}`)
        .set('Authorization', `Bearer ${requester.token}`);
      expect(beforeRes.body.status).toBe('open');

      // AT EXACT expiry: 2026-11-08T10:00:00.000Z -> flips to expired
      currentClock = new Date('2026-11-08T10:00:00.000Z');
      const exactRes = await request(timedApp)
        .get(`/v1/groups/${fixture.group.id}/approvals/${approvalId}`)
        .set('Authorization', `Bearer ${requester.token}`);
      expect(exactRes.body.status).toBe('expired');

      // 1 second AFTER expiry: 2026-11-08T10:00:01.000Z -> expired
      currentClock = new Date('2026-11-08T10:00:01.000Z');
      const afterRes = await request(timedApp)
        .get(`/v1/groups/${fixture.group.id}/approvals/${approvalId}`)
        .set('Authorization', `Bearer ${requester.token}`);
      expect(afterRes.body.status).toBe('expired');

      // Voting after expiry -> 409 approval_not_open
      const voteAfter = await request(timedApp)
        .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
        .set('Authorization', `Bearer ${voter.token}`)
        .set('Idempotency-Key', generateId())
        .send({ vote: 'approve' });
      expect(voteAfter.status).toBe(409);
      expect(voteAfter.body.error.code).toBe('approval_not_open');

      // Approved request is NEVER reported as expired:
      // Reset clock to creation time and create an approved request
      currentClock = new Date('2026-11-01T10:00:00.000Z');
      const approvedReq = await request(timedApp)
        .post(`/v1/groups/${fixture.group.id}/approvals`)
        .set('Authorization', `Bearer ${requester.token}`)
        .set('Idempotency-Key', generateId())
        .send({
          kind: 'expense',
          amountPaisa: 60000,
          title: 'Immune Approval',
          payee: 'Immune Store',
        });
      const approvedId = approvedReq.body.id;

      // Approve it (needs 2 votes)
      await request(timedApp)
        .post(`/v1/groups/${fixture.group.id}/approvals/${approvedId}/votes`)
        .set('Authorization', `Bearer ${fixture.members[1]!.token}`)
        .set('Idempotency-Key', generateId())
        .send({ vote: 'approve' });
      await request(timedApp)
        .post(`/v1/groups/${fixture.group.id}/approvals/${approvedId}/votes`)
        .set('Authorization', `Bearer ${fixture.members[2]!.token}`)
        .set('Idempotency-Key', generateId())
        .send({ vote: 'approve' });

      // Fast-forward 10 days into the future
      currentClock = new Date('2026-11-11T10:00:00.000Z');
      const fastForwardRes = await request(timedApp)
        .get(`/v1/groups/${fixture.group.id}/approvals/${approvedId}`)
        .set('Authorization', `Bearer ${requester.token}`);
      expect(fastForwardRes.body.status).toBe('approved');
    });
  });

  // =========================================================================
  // 8. Visibility, Leaks & 404 Uniformity
  // =========================================================================
  describe('8. Visibility, leak prevention, and 404 uniformity', () => {
    it('verifies exact keys on list/detail, prevents credential exposure, and guarantees 404 uniformity', async () => {
      const fixture = await seedNMemberFixture(directPrisma, 4, {
        initialBalancePaisa: 1000000n,
      });
      const requester = fixture.members[0]!;
      const voter = fixture.members[1]!;

      const reqRes = await request(app)
        .post(`/v1/groups/${fixture.group.id}/approvals`)
        .set('Authorization', `Bearer ${requester.token}`)
        .set('Idempotency-Key', generateId())
        .send({
          kind: 'expense',
          amountPaisa: 20000,
          title: 'Exact Keys Check',
          payee: 'Test Vendor',
        });
      const approvalId = reqRes.body.id;

      await request(app)
        .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
        .set('Authorization', `Bearer ${voter.token}`)
        .set('Idempotency-Key', generateId())
        .send({ vote: 'approve' });

      // List endpoint
      const listRes = await request(app)
        .get(`/v1/groups/${fixture.group.id}/approvals`)
        .set('Authorization', `Bearer ${requester.token}`);
      expect(listRes.status).toBe(200);
      expect(
        Object.keys(listRes.body as Record<string, unknown>).sort(),
      ).toEqual(['hasMore', 'items', 'nextCursor'].sort());

      // Verify list items never expose emails or firebase uids
      const serializedList = JSON.stringify(listRes.body);
      expect(serializedList).not.toContain('password');
      expect(serializedList).not.toContain('email');
      expect(serializedList).not.toContain('fb-');

      // Detail endpoint
      const detailRes = await request(app)
        .get(`/v1/groups/${fixture.group.id}/approvals/${approvalId}`)
        .set('Authorization', `Bearer ${requester.token}`);
      expect(detailRes.status).toBe(200);

      // Detail votes exposure: voter vote includes memberId, memberName, choice, at
      expect(detailRes.body.votes).toHaveLength(1);
      const voteItem = detailRes.body.votes[0];
      expect(Object.keys(voteItem as Record<string, unknown>).sort()).toEqual(
        ['at', 'choice', 'memberId', 'memberName'].sort(),
      );

      // 404 Uniformity across all approvals routes
      const nonMemberId = generateId();
      await directPrisma.user.create({
        data: {
          id: nonMemberId,
          firebaseUid: `fb-${nonMemberId}`,
          email: 'outsider@example.com',
          displayName: 'Outsider',
        },
      });
      const outsiderToken = FakeTokenVerifier.createToken(
        `fb-${nonMemberId}`,
        'outsider@example.com',
        true,
      );

      const check404 = (res: request.Response) => {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('group_not_found');
        expect(res.body.error.message).toBe('Group not found or access denied');
        expect(res.body.error.requestId).toMatch(/^req_/);
      };

      const outList = await request(app)
        .get(`/v1/groups/${fixture.group.id}/approvals`)
        .set('Authorization', `Bearer ${outsiderToken}`);
      check404(outList);

      const outDetail = await request(app)
        .get(`/v1/groups/${fixture.group.id}/approvals/${approvalId}`)
        .set('Authorization', `Bearer ${outsiderToken}`);
      check404(outDetail);

      const outVote = await request(app)
        .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .set('Idempotency-Key', generateId())
        .send({ vote: 'approve' });
      check404(outVote);

      const outCancel = await request(app)
        .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/cancel`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .set('Idempotency-Key', generateId());
      check404(outCancel);

      const outExec = await request(app)
        .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/execute`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .set('Idempotency-Key', generateId())
        .send({ method: 'cash' });
      check404(outExec);
    });
  });
});
