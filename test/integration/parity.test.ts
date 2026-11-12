/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
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
  seedStandardGroup,
} from './setup.js';

describe('Flutter Parity End-to-End Scenarios', () => {
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

  const fixedNow = new Date('2026-11-09T10:00:00.000Z');

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

  it('Parity Story 1 (payment_submission_e2e_test): submit payment, verify method-scoped reference masking and activity reflection', async () => {
    // 1. Setup group with expected contribution NPR 700 (70,000 paisa)
    const fixture = await seedStandardGroup(directPrisma, {
      expectedPaisa: 70000n,
      name: 'Himalayan Trekkers',
    });

    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Initial state: 3 members verified (owner, member1, member2) -> 210,000 paisa
    for (const m of [fixture.owner, fixture.member1, fixture.member2]) {
      await directPrisma.ledgerEntry.create({
        data: {
          id: generateId(),
          groupId: fixture.group.id,
          kind: 'contribution',
          title: 'Monthly contribution',
          magnitudePaisa: 70000n,
          occurredAt: new Date('2026-11-01T10:00:00.000Z'),
          postedAt: new Date('2026-11-01T10:00:00.000Z'),
          memberId: m.membership.id,
          periodMonth: new Date('2026-11-01T00:00:00.000Z'),
          actorMemberId: fixture.owner.membership.id,
        },
      });
    }

    // 1 member pending (member3) -> 70,000 paisa
    await directPrisma.paymentSubmission.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        memberId: fixture.member3.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 70000n,
        paymentMethod: 'esewa',
        reference: 'ESW-112233',
        status: 'pending',
        submittedAt: new Date('2026-11-04T10:00:00.000Z'),
      },
    });

    // Verify initial period status: 3 of 5 verified (2,100 NPR of 3,500 NPR)
    const periodRes1 = await request(app)
      .get(`/v1/groups/${fixture.group.id}/contributions/periods/2026-11`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(periodRes1.status).toBe(200);
    expect(periodRes1.body.summary.obligatedCount).toBe(5);
    expect(periodRes1.body.summary.verifiedObligationCount).toBe(3);
    expect(periodRes1.body.summary.verifiedReceivedPaisa).toBe(210000);
    expect(periodRes1.body.summary.pendingTotalPaisa).toBe(70000);

    // 2. Member B (secondTreasurer in our fixture) submits payment
    const memberBToken = FakeTokenVerifier.createToken(
      `fb-${fixture.secondTreasurer.user.id}`,
      fixture.secondTreasurer.user.email,
      true,
    );

    const submitRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments`)
      .set('Authorization', `Bearer ${memberBToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        periodId: '2026-11',
        method: 'khalti',
        reference: 'KH-778899',
        note: 'Dues for Nov',
      });

    expect(submitRes.status).toBe(201);
    expect(submitRes.body.amountPaisa).toBe(70000);
    expect(submitRes.body.status).toBe('pending');

    // 3. Member B checks /payments/my -> reference masked as "Ref ••••8899"
    const myPaymentsRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/payments/my`)
      .set('Authorization', `Bearer ${memberBToken}`);

    expect(myPaymentsRes.status).toBe(200);
    expect(myPaymentsRes.body[0].reference).toBe('Ref ••••8899');
    expect(myPaymentsRes.body[0].paymentMethod).toBe('khalti');
    expect(myPaymentsRes.body[0].status).toBe('pendingVerification');

    // 4. Activity feed shows Member B's contribution awaiting verification
    const activityRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/transactions`)
      .set('Authorization', `Bearer ${memberBToken}`);

    expect(activityRes.status).toBe(200);
    const memberBItem = activityRes.body.items.find(
      (item: { memberId: string }) =>
        item.memberId === fixture.secondTreasurer.membership.id,
    );
    expect(memberBItem).toBeDefined();
    expect(memberBItem.amountPaisa).toBe(70000);
    expect(memberBItem.status).toBe('pendingVerification');
    expect(memberBItem.source).toBe('submission');

    // 5. Treasurer checks pending reviews -> unmasked reference "KH-778899" visible
    const pendingRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/payments/pending`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(pendingRes.status).toBe(200);
    const pendingMemberB = pendingRes.body.find(
      (item: { memberId: string }) =>
        item.memberId === fixture.secondTreasurer.membership.id,
    );
    expect(pendingMemberB).toBeDefined();
    expect(pendingMemberB.reference).toBe('KH778899');
    expect(pendingMemberB.isOwnSubmission).toBe(false);
  });

  it('Parity Story 2 (payment_verification_e2e_test): rejection with reason & note, resubmission, dual verification and final reconciliation', async () => {
    const fixture = await seedStandardGroup(directPrisma, {
      expectedPaisa: 70000n,
    });

    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    const memberBToken = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );

    // Initial state: Hari (member2) submitted payment
    const hariSubId = generateId();
    await directPrisma.paymentSubmission.create({
      data: {
        id: hariSubId,
        groupId: fixture.group.id,
        memberId: fixture.member2.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 70000n,
        paymentMethod: 'esewa',
        reference: 'ESW-HARI-01',
        status: 'pending',
        submittedAt: new Date('2026-11-04T10:00:00.000Z'),
      },
    });

    // 1. Member B submits payment
    const memberBSubRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments`)
      .set('Authorization', `Bearer ${memberBToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        periodId: '2026-11',
        method: 'khalti',
        reference: 'KH-778899',
      });
    expect(memberBSubRes.status).toBe(201);
    const memberBSubId = memberBSubRes.body.id as string;

    // 2. Treasurer rejects Member B's payment
    const rejectRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments/${memberBSubId}/reject`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        reason: 'referenceNotFound',
        note: 'No matching transfer',
      });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.submission.status).toBe('rejected');

    // 3. Member B sees rejection in /payments/my and resubmits
    const myPaymentsRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/payments/my`)
      .set('Authorization', `Bearer ${memberBToken}`);

    expect(myPaymentsRes.status).toBe(200);
    expect(myPaymentsRes.body[0].status).toBe('rejected');
    expect(myPaymentsRes.body[0].rejectionReason).toBe('referenceNotFound');
    expect(myPaymentsRes.body[0].rejectionNote).toBe('No matching transfer');

    // Member B resubmits with new reference
    const resubmitRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments`)
      .set('Authorization', `Bearer ${memberBToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        periodId: '2026-11',
        method: 'khalti',
        reference: 'KH-778900',
      });
    expect(resubmitRes.status).toBe(201);
    const newMemberBSubId = resubmitRes.body.id as string;

    // 4. Treasurer verifies Hari's payment
    const verifyHariRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments/${hariSubId}/verify`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', generateId())
      .send();
    expect(verifyHariRes.status).toBe(200);

    // 5. Treasurer verifies Member B's resubmitted payment
    const verifyMemberBRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments/${newMemberBSubId}/verify`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', generateId())
      .send();
    expect(verifyMemberBRes.status).toBe(200);

    // 6. Both are now verified in the ledger
    const ledgerCount = await directPrisma.ledgerEntry.count({
      where: {
        groupId: fixture.group.id,
        kind: 'contribution',
      },
    });
    expect(ledgerCount).toBe(2);

    // Final check on pending submissions -> 0 pending
    const finalPendingRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/payments/pending`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(finalPendingRes.body).toHaveLength(0);
  });

  it('Parity Story 3 (contributions_e2e_test): periods reflect membership changes without altering ledger totals or historical balances', async () => {
    const fixture = await seedStandardGroup(directPrisma, {
      expectedPaisa: 70000n,
    });

    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Member 1 joined in September 2026
    await directPrisma.groupMembership.update({
      where: { id: fixture.member1.membership.id },
      data: { joinedAt: new Date('2026-09-01T00:00:00.000Z') },
    });

    // Post September 2026 contribution for Member 1 (70,000 paisa)
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'Chirag Sept contribution',
        magnitudePaisa: 70000n,
        occurredAt: new Date('2026-09-10T10:00:00.000Z'),
        postedAt: new Date('2026-09-10T10:00:00.000Z'),
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-09-01T00:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
      },
    });

    // Post October 2026 contribution for Member 1 (70,000 paisa)
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'Chirag Oct contribution',
        magnitudePaisa: 70000n,
        occurredAt: new Date('2026-10-10T10:00:00.000Z'),
        postedAt: new Date('2026-10-10T10:00:00.000Z'),
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-10-01T00:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
      },
    });

    // Total ledger balance = 140,000 paisa
    const preBalance = await directPrisma.ledgerEntry.aggregate({
      where: { groupId: fixture.group.id },
      _sum: { magnitudePaisa: true },
    });
    expect(preBalance._sum.magnitudePaisa).toBe(140000n);

    // Member 1 leaves group in November 2026
    await directPrisma.groupMembership.update({
      where: { id: fixture.member1.membership.id },
      data: { leftAt: new Date('2026-11-05T00:00:00.000Z') },
    });

    // 1. Verify Member 1 removal did NOT alter ledger totals
    const postBalance = await directPrisma.ledgerEntry.aggregate({
      where: { groupId: fixture.group.id },
      _sum: { magnitudePaisa: true },
    });
    expect(postBalance._sum.magnitudePaisa).toBe(140000n);

    // 2. Member 1 is NOT obligated for November period (left before/during Nov)
    const novRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/contributions/periods/2026-11`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(novRes.status).toBe(200);
    const novObligatedIds = novRes.body.obligations.map(
      (o: { memberId: string }) => o.memberId,
    );
    expect(novObligatedIds).not.toContain(fixture.member1.membership.id);

    // 3. Member 1 WAS obligated and verified in September period
    const septRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/contributions/periods/2026-09`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(septRes.status).toBe(200);
    const m1SeptObligation = septRes.body.obligations.find(
      (o: { memberId: string }) => o.memberId === fixture.member1.membership.id,
    );
    expect(m1SeptObligation).toBeDefined();
    expect(m1SeptObligation.status).toBe('verified');
    expect(m1SeptObligation.paidPaisa).toBe(70000);
  });
});
