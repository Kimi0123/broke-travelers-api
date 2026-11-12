/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
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

describe('Member Detail HTTP Integration', () => {
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

  const fixedNow = new Date('2026-11-15T08:00:00.000Z');

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

  it('returns member profile, verified total, pending total, verified month count, and history', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    // Member 1 has:
    // 1. Verified contribution for 2026-10 (500,000 paisa)
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'Chirag Member contribution',
        magnitudePaisa: 500000n,
        occurredAt: new Date('2026-10-10T10:00:00.000Z'),
        postedAt: new Date('2026-10-10T10:00:00.000Z'),
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-10-01T00:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
      },
    });

    // 2. Pending contribution submission for 2026-11 (500,000 paisa)
    await directPrisma.paymentSubmission.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'esewa',
        reference: 'ESW-M1-NOV',
        status: 'pending',
        submittedAt: new Date('2026-11-05T10:00:00.000Z'),
      },
    });

    // Self viewing (Member 1 viewing Member 1)
    const m1Token = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );

    const res = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/members/${fixture.member1.membership.id}`,
      )
      .set('Authorization', `Bearer ${m1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.member.id).toBe(fixture.member1.membership.id);
    expect(res.body.member.isCurrentUser).toBe(true);
    expect(res.body.verifiedTotalPaisa).toBe(500000);
    expect(res.body.pendingTotalPaisa).toBe(500000);
    expect(res.body.verifiedMonthCount).toBe(1);
    expect(res.body.history).toHaveLength(2); // 2026-11 and 2026-10

    // History is newest month first
    expect(res.body.history[0].status).toBe('pendingVerification');
    expect(res.body.history[0].paidPaisa).toBe(500000);
    expect(res.body.history[1].status).toBe('verified');
    expect(res.body.history[1].paidPaisa).toBe(500000);
  });

  it('privacy filter: non-treasurer viewing another member sees pendingTotal = 0 and paidPaisa = 0 on pending row', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    // Member 1 has a pending submission
    await directPrisma.paymentSubmission.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'esewa',
        reference: 'SECRET-REF-1234',
        status: 'pending',
        submittedAt: new Date('2026-11-05T10:00:00.000Z'),
      },
    });

    // Member 2 (regular member, NOT a treasurer) views Member 1
    const m2Token = FakeTokenVerifier.createToken(
      `fb-${fixture.member2.user.id}`,
      fixture.member2.user.email,
      true,
    );

    const res = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/members/${fixture.member1.membership.id}`,
      )
      .set('Authorization', `Bearer ${m2Token}`);

    expect(res.status).toBe(200);
    expect(res.body.member.isCurrentUser).toBe(false);
    // Privacy: pendingTotal is masked to 0
    expect(res.body.pendingTotalPaisa).toBe(0);

    // Status is visible, but paid amount is masked to 0
    const novRow = res.body.history[0];
    expect(novRow.status).toBe('pendingVerification');
    expect(novRow.paidPaisa).toBe(0);

    // Treasurer views Member 1 -> sees full pendingTotal and paidPaisa
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    const treasurerRes = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/members/${fixture.member1.membership.id}`,
      )
      .set('Authorization', `Bearer ${treasurerToken}`);

    expect(treasurerRes.status).toBe(200);
    expect(treasurerRes.body.pendingTotalPaisa).toBe(500000);
    expect(treasurerRes.body.history[0].paidPaisa).toBe(500000);
  });

  it('returns 404 member_not_found for removed or unknown member', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const token = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Soft remove member 3
    await directPrisma.groupMembership.update({
      where: { id: fixture.member3.membership.id },
      data: { leftAt: new Date('2026-11-01T00:00:00.000Z') },
    });

    // Looking up removed member -> 404 member_not_found
    const removedRes = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/members/${fixture.member3.membership.id}`,
      )
      .set('Authorization', `Bearer ${token}`);

    expect(removedRes.status).toBe(404);
    expect(removedRes.body.error.code).toBe('member_not_found');

    // Unknown member UUID -> 404 member_not_found
    const unknownRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/members/${generateId()}`)
      .set('Authorization', `Bearer ${token}`);

    expect(unknownRes.status).toBe(404);
    expect(unknownRes.body.error.code).toBe('member_not_found');
  });
});
