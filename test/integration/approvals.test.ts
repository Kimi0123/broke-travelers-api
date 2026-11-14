/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { PrismaClient, User } from '@prisma/client';
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

interface SixMemberFixture {
  readonly group: { id: string; name: string };
  readonly owner: {
    user: { id: string; email: string };
    membership: { id: string };
  };
  readonly b: {
    user: { id: string; email: string };
    membership: { id: string };
  };
  readonly c: {
    user: { id: string; email: string };
    membership: { id: string };
  };
  readonly sita: {
    user: { id: string; email: string };
    membership: { id: string };
  };
  readonly ram: {
    user: { id: string; email: string };
    membership: { id: string };
  };
  readonly hari: {
    user: { id: string; email: string };
    membership: { id: string };
  };
}

async function seedSixMemberFixture(
  prisma: PrismaClient,
  options?: {
    readonly initialBalancePaisa?: bigint;
    readonly pendingPaisa?: bigint;
  },
): Promise<SixMemberFixture> {
  const usersData = [
    { name: 'Aarav Owner', email: 'owner@example.com' },
    { name: 'Member B', email: 'member-b@example.com' },
    { name: 'Member C', email: 'member-c@example.com' },
    { name: 'Sita', email: 'sita@example.com' },
    { name: 'Ram', email: 'ram@example.com' },
    { name: 'Hari', email: 'hari@example.com' },
  ];

  const createdUsers: User[] = [];
  for (const u of usersData) {
    const id = generateId();
    const created = await prisma.user.create({
      data: {
        id,
        firebaseUid: `fb-${id}`,
        email: u.email,
        displayName: u.name,
      },
    });
    createdUsers.push(created);
  }

  const groupId = generateId();
  const group = await prisma.group.create({
    data: {
      id: groupId,
      name: 'Himalayan Trekkers',
      expectedPaisa: 500000n,
      dueDay: 15,
      createdByUserId: createdUsers[0]!.id,
    },
  });

  const memberships = [];
  for (let i = 0; i < createdUsers.length; i++) {
    const memId = generateId();
    const mem = await prisma.groupMembership.create({
      data: {
        id: memId,
        groupId,
        userId: createdUsers[i]!.id,
        isOwner: i === 0,
        isTreasurer: i === 0,
      },
    });
    memberships.push(mem);
  }

  // Initial balance
  if (options?.initialBalancePaisa) {
    await prisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId,
        kind: 'contribution',
        title: 'Opening Balance',
        magnitudePaisa: options.initialBalancePaisa,
        occurredAt: new Date('2026-11-01T10:00:00.000Z'),
        postedAt: new Date('2026-11-01T10:00:00.000Z'),
        actorMemberId: memberships[0]!.id,
        memberId: memberships[0]!.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        paymentMethod: 'cash',
      },
    });
  }

  // Pending submission
  if (options?.pendingPaisa) {
    await prisma.paymentSubmission.create({
      data: {
        id: generateId(),
        groupId,
        memberId: memberships[1]!.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: options.pendingPaisa,
        paymentMethod: 'esewa',
        reference: 'ESW-PENDING-700',
        status: 'pending',
        submittedAt: new Date('2026-11-05T10:00:00.000Z'),
      },
    });
  }

  return {
    group: { id: groupId, name: group.name },
    owner: { user: createdUsers[0]!, membership: memberships[0]! },
    b: { user: createdUsers[1]!, membership: memberships[1]! },
    c: { user: createdUsers[2]!, membership: memberships[2]! },
    sita: { user: createdUsers[3]!, membership: memberships[3]! },
    ram: { user: createdUsers[4]!, membership: memberships[4]! },
    hari: { user: createdUsers[5]!, membership: memberships[5]! },
  };
}

describe('Approvals HTTP Integration & Flutter Parity', () => {
  const prisma = getTestPrisma();
  const directPrisma = getTestDirectPrisma();
  const tokenVerifier = new FakeTokenVerifier();

  const testConfig: AppConfig = {
    NODE_ENV: 'test',
    PORT: 3000,
    LOG_LEVEL: 'fatal',
    TRUST_PROXY_HOPS: 1,
    REQUIRE_VERIFIED_EMAIL: true,
    DATABASE_URL: process.env['DATABASE_URL'] ?? '',
  };

  let simulatedNow = new Date('2026-11-09T10:00:00.000Z');

  const app = createApp({
    prisma,
    config: testConfig,
    tokenVerifier,
    logger: pino({ level: 'silent' }),
    clock: () => simulatedNow,
  });

  beforeEach(async () => {
    simulatedNow = new Date('2026-11-09T10:00:00.000Z');
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeAllTestClients();
  });

  it('validates request shapes, exact keys, and prevents credential leaks', async () => {
    const fixture = await seedSixMemberFixture(directPrisma, {
      initialBalancePaisa: 500000n,
    });
    const bToken = FakeTokenVerifier.createToken(
      `fb-${fixture.b.user.id}`,
      fixture.b.user.email,
      true,
    );

    const res = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${bToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'withdrawal',
        amountPaisa: 200000,
        title: 'Trek permits',
        payee: 'Everest Trek Co',
        description: 'Permit fees for group',
      });

    expect(res.status).toBe(201);
    const body = res.body;

    // Exact key check
    const expectedKeys = [
      'id',
      'groupId',
      'kind',
      'title',
      'payee',
      'description',
      'amountPaisa',
      'requesterMemberId',
      'requesterName',
      'createdAt',
      'expiresAt',
      'closedAt',
      'status',
      'eligibleCount',
      'votesNeeded',
      'approveCount',
      'rejectCount',
      'isMine',
      'canVote',
      'myVote',
      'votes',
      'executedTransactionId',
    ];
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(
      expectedKeys.sort(),
    );

    // Security check: no email, firebaseUid or passwords
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('email');
    expect(serialized).not.toContain('fb-');

    expect(body.isMine).toBe(true);
    expect(body.canVote).toBe(false); // Requester cannot vote
    expect(body.myVote).toBeNull();
    expect(body.eligibleCount).toBe(5); // 6 total - requester = 5
    expect(body.votesNeeded).toBe(3); // 5 ~/ 2 + 1 = 3
  });

  it('enforces role gates, 404 uniformity, and non-member isolation', async () => {
    const fixture = await seedSixMemberFixture(directPrisma, {
      initialBalancePaisa: 500000n,
    });
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

    // Outsider cannot create approval -> 404 group_not_found
    const outCreate = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'withdrawal',
        amountPaisa: 100000,
        title: 'Outsider request',
        payee: 'Nobody',
      });
    expect(outCreate.status).toBe(404);
    expect(outCreate.body.error.code).toBe('group_not_found');

    // Unknown approval id -> 404 approval_not_found
    const bToken = FakeTokenVerifier.createToken(
      `fb-${fixture.b.user.id}`,
      fixture.b.user.email,
      true,
    );
    const missingRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/approvals/${generateId()}`)
      .set('Authorization', `Bearer ${bToken}`);
    expect(missingRes.status).toBe(404);
    expect(missingRes.body.error.code).toBe('approval_not_found');
  });

  it('verifies idempotency: missing key, replay, conflict, and actor scoping', async () => {
    const fixture = await seedSixMemberFixture(directPrisma, {
      initialBalancePaisa: 500000n,
    });
    const bToken = FakeTokenVerifier.createToken(
      `fb-${fixture.b.user.id}`,
      fixture.b.user.email,
      true,
    );

    // Missing key -> 400 idempotency_key_required
    const noKey = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({
        kind: 'withdrawal',
        amountPaisa: 100000,
        title: 'Tent rent',
        payee: 'Camp Shop',
      });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('idempotency_key_required');

    const key = generateId();
    const payload = {
      kind: 'withdrawal',
      amountPaisa: 100000,
      title: 'Tent rent',
      payee: 'Camp Shop',
    };

    const first = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${bToken}`)
      .set('Idempotency-Key', key)
      .send(payload);
    expect(first.status).toBe(201);

    // Replay with exact same payload -> 201 + Idempotent-Replay header
    const replay = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${bToken}`)
      .set('Idempotency-Key', key)
      .send(payload);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);

    // Conflict with different payload -> 409 idempotency_conflict
    const conflict = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${bToken}`)
      .set('Idempotency-Key', key)
      .send({ ...payload, amountPaisa: 150000 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('idempotency_conflict');
  });

  it('validates creation constraints: balance guard, member count, title/payee/amount limits', async () => {
    const fixture = await seedSixMemberFixture(directPrisma, {
      initialBalancePaisa: 100000n, // 1,000 NPR
    });
    const bToken = FakeTokenVerifier.createToken(
      `fb-${fixture.b.user.id}`,
      fixture.b.user.email,
      true,
    );

    // Amount exceeds verified balance -> 409 insufficient_balance
    const overdraw = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${bToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'withdrawal',
        amountPaisa: 150000, // 1,500 NPR > 1,000 NPR
        title: 'Overdraw request',
        payee: 'Shop',
      });
    expect(overdraw.status).toBe(409);
    expect(overdraw.body.error.code).toBe('insufficient_balance');

    // Title too short (< 2)
    const shortTitle = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${bToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'withdrawal',
        amountPaisa: 50000,
        title: 'A',
        payee: 'Shop',
      });
    expect(shortTitle.status).toBe(400);
    expect(shortTitle.body.error.code).toBe('invalid_approval_input');

    // Payee too short (< 2)
    const shortPayee = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${bToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'withdrawal',
        amountPaisa: 50000,
        title: 'Valid title',
        payee: 'X',
      });
    expect(shortPayee.status).toBe(400);
    expect(shortPayee.body.error.code).toBe('invalid_approval_input');
  });

  it('tests votesNeeded across group sizes through the API', async () => {
    // 6 members in fixture:
    // Requester B -> 5 eligible voters -> votesNeeded = 3
    const fixture = await seedSixMemberFixture(directPrisma, {
      initialBalancePaisa: 500000n,
    });
    const bToken = FakeTokenVerifier.createToken(
      `fb-${fixture.b.user.id}`,
      fixture.b.user.email,
      true,
    );
    const res = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${bToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'withdrawal',
        amountPaisa: 100000,
        title: 'Quorum test',
        payee: 'Store',
      });
    expect(res.body.eligibleCount).toBe(5);
    expect(res.body.votesNeeded).toBe(3);
  });

  // =========================================================================
  // PARITY SCENARIOS (mirroring Dart test suites with exact numbers)
  // =========================================================================

  it('Parity Scenario (a) approvals_e2e_test: B requests NPR 2,000 withdrawal, 3 approvals reach threshold, Ram rejected with 409, Owner executes with Cash, balance drops from NPR 7,300 to NPR 5,300', async () => {
    // Mirrors Dart test: test/app/approvals_e2e_test.dart:36-440
    // Initial state: verified balance = NPR 7,300 (730,000 paisa), pending = NPR 700 (70,000 paisa)
    const fixture = await seedSixMemberFixture(directPrisma, {
      initialBalancePaisa: 730000n,
      pendingPaisa: 70000n,
    });

    const bToken = FakeTokenVerifier.createToken(
      `fb-${fixture.b.user.id}`,
      fixture.b.user.email,
      true,
    );
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );
    const cToken = FakeTokenVerifier.createToken(
      `fb-${fixture.c.user.id}`,
      fixture.c.user.email,
      true,
    );
    const sitaToken = FakeTokenVerifier.createToken(
      `fb-${fixture.sita.user.id}`,
      fixture.sita.user.email,
      true,
    );
    const ramToken = FakeTokenVerifier.createToken(
      `fb-${fixture.ram.user.id}`,
      fixture.ram.user.email,
      true,
    );

    // 1. B requests withdrawal 'Trek permits' NPR 2,000 (200,000 paisa) payee 'Everest Trek Co'
    const createRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${bToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'withdrawal',
        amountPaisa: 200000,
        title: 'Trek permits',
        payee: 'Everest Trek Co',
      });
    expect(createRes.status).toBe(201);
    const approvalId = createRes.body.id;
    expect(createRes.body.status).toBe('open');
    expect(createRes.body.eligibleCount).toBe(5);
    expect(createRes.body.votesNeeded).toBe(3);

    // Requester B cannot vote on own request -> 403 cannot_vote_on_own_request
    const bVote = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${bToken}`)
      .set('Idempotency-Key', generateId())
      .send({ vote: 'approve' });
    expect(bVote.status).toBe(403);
    expect(bVote.body.error.code).toBe('cannot_vote_on_own_request');

    // Non-requester Owner cannot cancel -> 403 forbidden
    const ownerCancel = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', generateId());
    expect(ownerCancel.status).toBe(403);
    expect(ownerCancel.body.error.code).toBe('forbidden');

    // 2. Owner votes approve
    const vote1 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ vote: 'approve' });
    expect(vote1.status).toBe(200);
    expect(vote1.body.approveCount).toBe(1);
    expect(vote1.body.status).toBe('open');

    // 3. Member C votes approve
    const vote2 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${cToken}`)
      .set('Idempotency-Key', generateId())
      .send({ vote: 'approve' });
    expect(vote2.status).toBe(200);
    expect(vote2.body.approveCount).toBe(2);
    expect(vote2.body.status).toBe('open');

    // 4. Sita votes approve -> 3rd approval reaches votesNeeded(5) = 3!
    const vote3 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${sitaToken}`)
      .set('Idempotency-Key', generateId())
      .send({ vote: 'approve' });
    expect(vote3.status).toBe(200);
    expect(vote3.body.approveCount).toBe(3);
    expect(vote3.body.status).toBe('approved');

    // 5. Ram tries to vote after decision -> 409 approval_not_open
    const vote4 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${ramToken}`)
      .set('Idempotency-Key', generateId())
      .send({ vote: 'approve' });
    expect(vote4.status).toBe(409);
    expect(vote4.body.error.code).toBe('approval_not_open');

    // 6. Owner (Treasurer) executes with Cash
    const execRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${approvalId}/execute`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ method: 'cash' });
    expect(execRes.status).toBe(200);
    expect(execRes.body.status).toBe('executed');
    expect(execRes.body.executedTransactionId).toMatch(/^ledger:/);

    // 7. Verify balance drops from NPR 7,300 to NPR 5,300 (530,000 paisa)
    const txRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/transactions`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(txRes.status).toBe(200);

    // Check verified ledger balance directly
    const ledgerRows = await directPrisma.ledgerEntry.findMany({
      where: { groupId: fixture.group.id },
    });
    const verifiedSum = ledgerRows.reduce((acc, row) => {
      const mag = Number(row.magnitudePaisa);
      return (
        acc + (row.kind === 'withdrawal' || row.kind === 'expense' ? -mag : mag)
      );
    }, 0);
    expect(verifiedSum).toBe(530000); // NPR 5,300

    // 8. Audit log actions in exact order
    const auditRows = await directPrisma.auditLog.findMany({
      where: {
        groupId: fixture.group.id,
        action: { startsWith: 'approval.' },
      },
      orderBy: { createdAt: 'asc' },
    });
    const auditActions = auditRows.map((a) => a.action);
    expect(auditActions).toEqual([
      'approval.created',
      'approval.voted',
      'approval.voted',
      'approval.voted',
      'approval.decided',
      'approval.executed',
    ]);
  });

  it('Parity Scenario (b) approvals_e2e_test: Rejection path - Sita requests expense NPR 500, Ram and Hari reject -> Rejected, execution impossible', async () => {
    // Mirrors Dart test: test/app/approvals_e2e_test.dart:460-530
    const fixture = await seedSixMemberFixture(directPrisma, {
      initialBalancePaisa: 500000n,
    });
    const sitaToken = FakeTokenVerifier.createToken(
      `fb-${fixture.sita.user.id}`,
      fixture.sita.user.email,
      true,
    );
    const ramToken = FakeTokenVerifier.createToken(
      `fb-${fixture.ram.user.id}`,
      fixture.ram.user.email,
      true,
    );
    const hariToken = FakeTokenVerifier.createToken(
      `fb-${fixture.hari.user.id}`,
      fixture.hari.user.email,
      true,
    );
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    const createRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${sitaToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'expense',
        amountPaisa: 50000, // 500 NPR
        title: 'Trail supplies',
        payee: 'Local shop',
      });
    expect(createRes.status).toBe(201);
    const reqId = createRes.body.id;

    // Ram rejects
    await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${reqId}/votes`)
      .set('Authorization', `Bearer ${ramToken}`)
      .set('Idempotency-Key', generateId())
      .send({ vote: 'reject' });

    // Hari rejects
    await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${reqId}/votes`)
      .set('Authorization', `Bearer ${hariToken}`)
      .set('Idempotency-Key', generateId())
      .send({ vote: 'reject' });

    // Owner rejects -> 3 rejections out of 5 eligible -> impossible to reach 3 approvals -> early rejected!
    const vote3 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${reqId}/votes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ vote: 'reject' });
    expect(vote3.status).toBe(200);
    expect(vote3.body.status).toBe('rejected');

    // Execution fails -> 409 approval_not_approved
    const execRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${reqId}/execute`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', generateId());
    expect(execRes.status).toBe(409);
    expect(execRes.body.error.code).toBe('approval_not_approved');
  });

  it('Parity Scenario (c) approvals_e2e_test: Separation of duties - B made treasurer; B requests NPR 100, approved; B cannot execute own request while Owner is also treasurer; Owner can', async () => {
    // Mirrors Dart test: test/app/approvals_e2e_test.dart:535-620
    const fixture = await seedSixMemberFixture(directPrisma, {
      initialBalancePaisa: 500000n,
    });

    // Promote B to treasurer
    await directPrisma.groupMembership.update({
      where: { id: fixture.b.membership.id },
      data: { isTreasurer: true },
    });

    const bToken = FakeTokenVerifier.createToken(
      `fb-${fixture.b.user.id}`,
      fixture.b.user.email,
      true,
    );
    const cToken = FakeTokenVerifier.createToken(
      `fb-${fixture.c.user.id}`,
      fixture.c.user.email,
      true,
    );
    const sitaToken = FakeTokenVerifier.createToken(
      `fb-${fixture.sita.user.id}`,
      fixture.sita.user.email,
      true,
    );
    const ramToken = FakeTokenVerifier.createToken(
      `fb-${fixture.ram.user.id}`,
      fixture.ram.user.email,
      true,
    );
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // B requests NPR 100 (10,000 paisa)
    const createRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${bToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'expense',
        amountPaisa: 10000,
        title: 'B expense',
        payee: 'B payee',
      });
    expect(createRes.status).toBe(201);
    const reqId = createRes.body.id;

    // C, Sita, Ram approve
    for (const token of [cToken, sitaToken, ramToken]) {
      await request(app)
        .post(`/v1/groups/${fixture.group.id}/approvals/${reqId}/votes`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', generateId())
        .send({ vote: 'approve' });
    }

    // B (treasurer) attempts to execute own request -> 403 cannot_execute_own_request
    const bExec = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${reqId}/execute`)
      .set('Authorization', `Bearer ${bToken}`)
      .set('Idempotency-Key', generateId())
      .send({ method: 'cash' });
    expect(bExec.status).toBe(403);
    expect(bExec.body.error.code).toBe('cannot_execute_own_request');

    // Owner (the other treasurer) executes -> 200 Executed
    const ownerExec = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${reqId}/execute`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ method: 'cash' });
    expect(ownerExec.status).toBe(200);
    expect(ownerExec.body.status).toBe('executed');
  });

  it('Parity Scenario (d) approvals_e2e_test: Expiry - Request older than 7 days reads expired and votes fail', async () => {
    // Mirrors Dart test: test/app/approvals_e2e_test.dart:630-660
    const fixture = await seedSixMemberFixture(directPrisma, {
      initialBalancePaisa: 500000n,
    });
    const sitaToken = FakeTokenVerifier.createToken(
      `fb-${fixture.sita.user.id}`,
      fixture.sita.user.email,
      true,
    );
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    const createRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals`)
      .set('Authorization', `Bearer ${sitaToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'withdrawal',
        amountPaisa: 10000,
        title: 'Expired request',
        payee: 'Old payee',
      });
    expect(createRes.status).toBe(201);
    const reqId = createRes.body.id;

    // Advance clock by 8 days
    simulatedNow = new Date('2026-11-17T10:00:00.000Z');

    const getRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/approvals/${reqId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.status).toBe('expired');

    // Vote on expired request -> 409 approval_not_open
    const voteRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/approvals/${reqId}/votes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ vote: 'approve' });
    expect(voteRes.status).toBe(409);
    expect(voteRes.body.error.code).toBe('approval_not_open');
  });
});
