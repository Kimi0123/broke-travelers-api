/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
/**
 * Updates End-to-End Story
 *
 * Mirrors test/app/updates_e2e_test.dart in the Flutter repo.
 *
 * Story (clock pinned to 2026-11-06 06:00 UTC):
 * 1. Hari submits a Nov payment -> sees "Payment awaiting verification" in his feed.
 *    Treasurer verifies it -> Hari now sees "Payment verified" and pending disappears.
 *    Unread count increments, then drops after mark-read.
 * 2. An approval request is created targeting Sita as eligible voter.
 *    Sita sees "Vote needed: Trek Maps". After Sita votes, item disappears.
 * 3. A matched bank reconciliation is recorded.
 *    All active members (Sita and Hari) see "Bank reconciliation matched".
 */
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
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

describe('Updates E2E Story (Dart updates_e2e_test parity)', () => {
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

  // Pinned to 2026-11-06 06:00 UTC (matches Dart story: now = DateTime(2026, 11, 6))
  const fixedNow = new Date('2026-11-06T06:00:00.000Z');

  const app = createApp({
    prisma,
    config: testConfig,
    tokenVerifier,
    logger: pino({ level: 'silent' }),
    clock: () => fixedNow,
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeAllTestClients();
  });

  it('Scenario 1: Hari sees pending, Treasurer verifies -> Hari sees verified; unread count tracks correctly', async () => {
    // -------------------------------------------------------------------------
    // Seed: group, users, memberships
    // -------------------------------------------------------------------------
    const groupCreatedAt = new Date('2026-09-01T00:00:00.000Z');

    const nirvanUserId = generateId();
    const hariUserId = generateId();

    await directPrisma.user.createMany({
      data: [
        {
          id: nirvanUserId,
          firebaseUid: `fb-nirvan-${nirvanUserId}`,
          email: `nirvan-${nirvanUserId}@example.com`,
          displayName: 'Nirvan',
        },
        {
          id: hariUserId,
          firebaseUid: `fb-hari-${hariUserId}`,
          email: `hari-${hariUserId}@example.com`,
          displayName: 'Hari',
        },
      ],
    });

    const groupId = generateId();
    await directPrisma.group.create({
      data: {
        id: groupId,
        name: 'Himalayan Crew',
        expectedPaisa: 70000n,
        dueDay: 5,
        createdAt: groupCreatedAt,
        createdByUserId: nirvanUserId,
      },
    });

    const nirvanMemberId = generateId();
    const hariMemberId = generateId();
    await directPrisma.groupMembership.createMany({
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
          id: hariMemberId,
          groupId,
          userId: hariUserId,
          isOwner: false,
          isTreasurer: false,
          joinedAt: groupCreatedAt,
        },
      ],
    });

    // -------------------------------------------------------------------------
    // Hari submits a November payment
    // -------------------------------------------------------------------------
    const hariToken = FakeTokenVerifier.createToken(
      `fb-hari-${hariUserId}`,
      `hari-${hariUserId}@example.com`,
      true,
    );

    const submitRes = await request(app)
      .post(`/v1/groups/${groupId}/payments`)
      .set('Authorization', `Bearer ${hariToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        periodId: '2026-11',
        method: 'cash',
      });
    expect(submitRes.status).toBe(201);
    const submissionId: string = submitRes.body.id;

    // -------------------------------------------------------------------------
    // Hari checks his feed: sees "Payment awaiting verification"
    // -------------------------------------------------------------------------
    const feedRes1 = await request(app)
      .get(`/v1/groups/${groupId}/updates`)
      .set('Authorization', `Bearer ${hariToken}`);
    expect(feedRes1.status).toBe(200);
    const hariItems1 = feedRes1.body.updates;
    const pendingItem = hariItems1.find(
      (u: { title: string }) => u.title === 'Payment awaiting verification',
    );
    expect(pendingItem).toBeDefined();
    expect(pendingItem.isRead).toBe(false);
    expect(pendingItem.id).toBe(`pay-${submissionId}-pending`);

    // -------------------------------------------------------------------------
    // Unread count before mark-read
    // -------------------------------------------------------------------------
    const countRes1 = await request(app)
      .get(`/v1/groups/${groupId}/updates/unread-count`)
      .set('Authorization', `Bearer ${hariToken}`);
    expect(countRes1.status).toBe(200);
    expect(countRes1.body.unreadCount).toBeGreaterThanOrEqual(1);
    const unreadBefore: number = countRes1.body.unreadCount;

    // -------------------------------------------------------------------------
    // Hari marks the pending item as read
    // -------------------------------------------------------------------------
    const markRes = await request(app)
      .post(`/v1/groups/${groupId}/updates/read`)
      .set('Authorization', `Bearer ${hariToken}`)
      .send({ ids: [pendingItem.id] });
    expect(markRes.status).toBe(200);
    expect(markRes.body.markedCount).toBe(1);

    const countRes2 = await request(app)
      .get(`/v1/groups/${groupId}/updates/unread-count`)
      .set('Authorization', `Bearer ${hariToken}`);
    expect(countRes2.status).toBe(200);
    expect(countRes2.body.unreadCount).toBe(unreadBefore - 1);

    // -------------------------------------------------------------------------
    // Treasurer verifies Hari's payment
    // -------------------------------------------------------------------------
    const nirvanToken = FakeTokenVerifier.createToken(
      `fb-nirvan-${nirvanUserId}`,
      `nirvan-${nirvanUserId}@example.com`,
      true,
    );
    const verifyRes = await request(app)
      .post(`/v1/groups/${groupId}/payments/${submissionId}/verify`)
      .set('Authorization', `Bearer ${nirvanToken}`)
      .set('Idempotency-Key', generateId());
    expect(verifyRes.status).toBe(200);

    // -------------------------------------------------------------------------
    // After verification: "Payment awaiting verification" is GONE;
    //   "Payment verified" appears in Hari's feed.
    // Mirrors Dart: expect pending gone, verified visible.
    // -------------------------------------------------------------------------
    const feedRes2 = await request(app)
      .get(`/v1/groups/${groupId}/updates`)
      .set('Authorization', `Bearer ${hariToken}`);
    expect(feedRes2.status).toBe(200);
    const hariItems2 = feedRes2.body.updates;

    const pendingGone = hariItems2.find(
      (u: { title: string }) => u.title === 'Payment awaiting verification',
    );
    expect(pendingGone).toBeUndefined();

    const verifiedItem = hariItems2.find(
      (u: { title: string }) => u.title === 'Payment verified',
    );
    expect(verifiedItem).toBeDefined();
    expect(verifiedItem.body).toContain('NPR 700');
    expect(verifiedItem.body).toContain('November 2026');
    // Previously the pending was read; verified item is a NEW id -> unread
    expect(verifiedItem.isRead).toBe(false);

    // mark-all-read brings unread count to 0
    const readAllRes = await request(app)
      .post(`/v1/groups/${groupId}/updates/read-all`)
      .set('Authorization', `Bearer ${hariToken}`);
    expect(readAllRes.status).toBe(200);

    const countRes3 = await request(app)
      .get(`/v1/groups/${groupId}/updates/unread-count`)
      .set('Authorization', `Bearer ${hariToken}`);
    expect(countRes3.status).toBe(200);
    expect(countRes3.body.unreadCount).toBe(0);
  });

  it('Scenario 2: Open approval -> Sita sees "Vote needed"; after Sita votes item disappears', async () => {
    // -------------------------------------------------------------------------
    // Seed: group with Nirvan (owner/treasurer), Sita (member), Hari (member)
    // -------------------------------------------------------------------------
    const groupCreatedAt = new Date('2026-09-01T00:00:00.000Z');

    const nirvanUserId = generateId();
    const sitaUserId = generateId();
    const hariUserId = generateId();

    await directPrisma.user.createMany({
      data: [
        {
          id: nirvanUserId,
          firebaseUid: `fb-nirvan-${nirvanUserId}`,
          email: `nirvan-${nirvanUserId}@example.com`,
          displayName: 'Nirvan',
        },
        {
          id: sitaUserId,
          firebaseUid: `fb-sita-${sitaUserId}`,
          email: `sita-${sitaUserId}@example.com`,
          displayName: 'Sita',
        },
        {
          id: hariUserId,
          firebaseUid: `fb-hari-${hariUserId}`,
          email: `hari-${hariUserId}@example.com`,
          displayName: 'Hari',
        },
      ],
    });

    const groupId = generateId();
    await directPrisma.group.create({
      data: {
        id: groupId,
        name: 'Himalayan Crew',
        expectedPaisa: 70000n,
        dueDay: 5,
        createdAt: groupCreatedAt,
        createdByUserId: nirvanUserId,
      },
    });

    const nirvanMemberId = generateId();
    const sitaMemberId = generateId();
    const hariMemberId = generateId();
    await directPrisma.groupMembership.createMany({
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
          id: hariMemberId,
          groupId,
          userId: hariUserId,
          isOwner: false,
          isTreasurer: false,
          joinedAt: groupCreatedAt,
        },
      ],
    });

    // -------------------------------------------------------------------------
    // Seed verified ledger entry so group balance >= 50000 (NPR 500 for approval)
    // -------------------------------------------------------------------------
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId,
        kind: 'contribution',
        title: "Nirvan's contribution",
        occurredAt: new Date('2026-09-01T04:00:00.000Z'),
        magnitudePaisa: 210000n, // NPR 2100 >= NPR 500
        paymentMethod: 'esewa',
        memberId: nirvanMemberId,
        periodMonth: new Date('2026-09-01'),
        actorMemberId: nirvanMemberId,
      },
    });

    // -------------------------------------------------------------------------
    // Nirvan creates an approval request (expense: "Trek Maps", NPR 500)
    // Eligible voters: Sita and Hari (Nirvan is requester, excluded)
    // -------------------------------------------------------------------------
    const nirvanToken = FakeTokenVerifier.createToken(
      `fb-nirvan-${nirvanUserId}`,
      `nirvan-${nirvanUserId}@example.com`,
      true,
    );

    const approvalRes = await request(app)
      .post(`/v1/groups/${groupId}/approvals`)
      .set('Authorization', `Bearer ${nirvanToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'expense',
        title: 'Trek Maps',
        payee: 'Map Store',
        amountPaisa: 50000,
        description: 'Maps for hike',
      });
    expect(approvalRes.status).toBe(201);
    const approvalId: string = approvalRes.body.id;

    // -------------------------------------------------------------------------
    // Sita's feed: sees "Vote needed: Trek Maps"
    // Mirrors Dart: expect(find.text('Vote needed: Trek Maps'), findsOneWidget)
    // -------------------------------------------------------------------------
    const sitaToken = FakeTokenVerifier.createToken(
      `fb-sita-${sitaUserId}`,
      `sita-${sitaUserId}@example.com`,
      true,
    );

    const sitaFeed1 = await request(app)
      .get(`/v1/groups/${groupId}/updates`)
      .set('Authorization', `Bearer ${sitaToken}`);
    expect(sitaFeed1.status).toBe(200);
    const voteItem = sitaFeed1.body.updates.find(
      (u: { title: string }) => u.title === 'Vote needed: Trek Maps',
    );
    expect(voteItem).toBeDefined();
    expect(voteItem.id).toBe(`appr-${approvalId}-needs-vote`);
    expect(voteItem.target.approvalId).toBe(approvalId);

    // -------------------------------------------------------------------------
    // Sita votes YES
    // -------------------------------------------------------------------------
    const voteRes = await request(app)
      .post(`/v1/groups/${groupId}/approvals/${approvalId}/votes`)
      .set('Authorization', `Bearer ${sitaToken}`)
      .set('Idempotency-Key', generateId())
      .send({ approve: true });
    expect(voteRes.status).toBe(200);

    // -------------------------------------------------------------------------
    // After Sita votes, "Vote needed: Trek Maps" is GONE from her feed.
    // Mirrors Dart: expect(find.text('Vote needed: Trek Maps'), findsNothing)
    // -------------------------------------------------------------------------
    const sitaFeed2 = await request(app)
      .get(`/v1/groups/${groupId}/updates`)
      .set('Authorization', `Bearer ${sitaToken}`);
    expect(sitaFeed2.status).toBe(200);
    const voteItemGone = sitaFeed2.body.updates.find(
      (u: { title: string }) => u.title === 'Vote needed: Trek Maps',
    );
    expect(voteItemGone).toBeUndefined();
  });

  it('Scenario 3: Bank reconciliation recorded -> all active members see "Bank reconciliation matched"', async () => {
    // -------------------------------------------------------------------------
    // Seed: group with Nirvan (owner/treasurer) and Sita (member)
    // -------------------------------------------------------------------------
    const groupCreatedAt = new Date('2026-09-01T00:00:00.000Z');

    const nirvanUserId = generateId();
    const sitaUserId = generateId();

    await directPrisma.user.createMany({
      data: [
        {
          id: nirvanUserId,
          firebaseUid: `fb-nirvan-${nirvanUserId}`,
          email: `nirvan-${nirvanUserId}@example.com`,
          displayName: 'Nirvan',
        },
        {
          id: sitaUserId,
          firebaseUid: `fb-sita-${sitaUserId}`,
          email: `sita-${sitaUserId}@example.com`,
          displayName: 'Sita',
        },
      ],
    });

    const groupId = generateId();
    await directPrisma.group.create({
      data: {
        id: groupId,
        name: 'Himalayan Crew',
        expectedPaisa: 70000n,
        dueDay: 5,
        createdAt: groupCreatedAt,
        createdByUserId: nirvanUserId,
      },
    });

    const nirvanMemberId = generateId();
    const sitaMemberId = generateId();
    await directPrisma.groupMembership.createMany({
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
      ],
    });

    // Seed a verified ledger entry so the group has a recordedBalance > 0
    // 530000 paisa = NPR 5,300; this is what the reconciliation must match.
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId,
        kind: 'contribution',
        title: "Nirvan's contribution",
        occurredAt: new Date('2026-09-01T04:00:00.000Z'),
        magnitudePaisa: 530000n, // 530000 paisa = NPR 5,300
        paymentMethod: 'esewa',
        memberId: nirvanMemberId,
        periodMonth: new Date('2026-09-01'),
        actorMemberId: nirvanMemberId,
      },
    });

    // -------------------------------------------------------------------------
    // Treasurer records a matched reconciliation for 2026-11-05
    // Recorded balance = 530000 paisa (from the seeded ledger entry above).
    // bankBalancePaisa matches -> difference 0 -> status 'matched'.
    // Mirrors Dart: statementDate: DateTime(2026, 11, 5), bank=530000, diff=0
    // -------------------------------------------------------------------------
    const nirvanToken = FakeTokenVerifier.createToken(
      `fb-nirvan-${nirvanUserId}`,
      `nirvan-${nirvanUserId}@example.com`,
      true,
    );

    const reconRes = await request(app)
      .post(`/v1/groups/${groupId}/reconciliations`)
      .set('Authorization', `Bearer ${nirvanToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: '2026-11-05',
        bankBalancePaisa: 530000,
        note: 'All reconciled',
      });
    expect(reconRes.status).toBe(201);
    const reconId: string = reconRes.body.id;

    // -------------------------------------------------------------------------
    // Both Nirvan (treasurer) AND Sita (plain member) see the reconciliation item.
    // Mirrors Dart: Sita sees 'Bank reconciliation matched' and
    //   'Reconciliation for 5 Nov 2026 matched'
    // -------------------------------------------------------------------------
    const sitaToken = FakeTokenVerifier.createToken(
      `fb-sita-${sitaUserId}`,
      `sita-${sitaUserId}@example.com`,
      true,
    );

    for (const [label, token] of [
      ['Nirvan (treasurer)', nirvanToken],
      ['Sita (plain member)', sitaToken],
    ] as [string, string][]) {
      const feedRes = await request(app)
        .get(`/v1/groups/${groupId}/updates`)
        .set('Authorization', `Bearer ${token}`);
      expect(feedRes.status).toBe(200);

      const reconItem = feedRes.body.updates.find(
        (u: { id: string }) => u.id === `rec-${reconId}`,
      );
      expect(
        reconItem,
        `${label} should see reconciliation item`,
      ).toBeDefined();
      expect(reconItem.title).toBe('Bank reconciliation matched');
      // Mirrors Dart: 'Reconciliation for 5 Nov 2026 matched'
      expect(reconItem.body).toContain('5 Nov 2026');
      expect(reconItem.body).toContain('matched');
      expect(reconItem.target.type).toBe('reconciliation');
    }
  });
});
