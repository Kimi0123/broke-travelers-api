/* eslint-disable @typescript-eslint/no-unsafe-member-access */
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

describe('Activity & Transactions Keyset Pagination HTTP Integration', () => {
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

  it('paginates activity items deterministically across 3 pages using keyset pagination', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const token = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Create 7 ledger entries with distinct occurredAt timestamps
    const createdIds: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const id = generateId();
      createdIds.push(id);
      await directPrisma.ledgerEntry.create({
        data: {
          id,
          groupId: fixture.group.id,
          kind: 'interest',
          title: `Interest Payment ${i}`,
          magnitudePaisa: BigInt(i * 1000),
          occurredAt: new Date(`2026-11-0${i}T10:00:00.000Z`),
          postedAt: new Date(`2026-11-0${i}T10:00:00.000Z`),
          actorMemberId: fixture.owner.membership.id,
        },
      });
    }

    // Page 1: limit 3 -> items 7, 6, 5
    const page1Res = await request(app)
      .get(`/v1/groups/${fixture.group.id}/transactions?limit=3`)
      .set('Authorization', `Bearer ${token}`);

    expect(page1Res.status).toBe(200);
    expect(page1Res.body.items).toHaveLength(3);
    expect(page1Res.body.hasMore).toBe(true);
    expect(page1Res.body.nextCursor).toBeDefined();
    expect(page1Res.body.items[0].rawId).toBe(createdIds[6]); // Day 7
    expect(page1Res.body.items[1].rawId).toBe(createdIds[5]); // Day 6
    expect(page1Res.body.items[2].rawId).toBe(createdIds[4]); // Day 5

    // Page 2: with cursor from page 1 -> items 4, 3, 2
    const page2Res = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/transactions?limit=3&cursor=${encodeURIComponent(
          page1Res.body.nextCursor as string,
        )}`,
      )
      .set('Authorization', `Bearer ${token}`);

    expect(page2Res.status).toBe(200);
    expect(page2Res.body.items).toHaveLength(3);
    expect(page2Res.body.hasMore).toBe(true);
    expect(page2Res.body.nextCursor).toBeDefined();
    expect(page2Res.body.items[0].rawId).toBe(createdIds[3]); // Day 4
    expect(page2Res.body.items[1].rawId).toBe(createdIds[2]); // Day 3
    expect(page2Res.body.items[2].rawId).toBe(createdIds[1]); // Day 2

    // Page 3: with cursor from page 2 -> item 1, hasMore = false
    const page3Res = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/transactions?limit=3&cursor=${encodeURIComponent(
          page2Res.body.nextCursor as string,
        )}`,
      )
      .set('Authorization', `Bearer ${token}`);

    expect(page3Res.status).toBe(200);
    expect(page3Res.body.items).toHaveLength(1);
    expect(page3Res.body.hasMore).toBe(false);
    expect(page3Res.body.nextCursor).toBeNull();
    expect(page3Res.body.items[0].rawId).toBe(createdIds[0]); // Day 1
  });

  it('rejects tampered or invalid cursor with 400 invalid_cursor', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const token = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    const res = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/transactions?cursor=not-a-valid-base64-cursor!!!`,
      )
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_cursor');
  });

  it('GET /v1/groups/:groupId/transactions/:transactionId returns single item for both ledger and submission sources', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const token = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // 1. Ledger entry
    const ledgerId = generateId();
    await directPrisma.ledgerEntry.create({
      data: {
        id: ledgerId,
        groupId: fixture.group.id,
        kind: 'interest',
        title: 'Monthly Interest',
        magnitudePaisa: 15000n,
        occurredAt: new Date('2026-11-01T10:00:00.000Z'),
        postedAt: new Date('2026-11-01T10:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
      },
    });

    const ledgerRes1 = await request(app)
      .get(`/v1/groups/${fixture.group.id}/transactions/ledger:${ledgerId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(ledgerRes1.status).toBe(200);
    expect(ledgerRes1.body.source).toBe('ledger');
    expect(ledgerRes1.body.rawId).toBe(ledgerId);

    // Bare UUID lookup fails with 404 transaction_not_found
    const ledgerRes2 = await request(app)
      .get(`/v1/groups/${fixture.group.id}/transactions/${ledgerId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(ledgerRes2.status).toBe(404);
    expect(ledgerRes2.body.error.code).toBe('transaction_not_found');

    // 2. Submission entry
    const subId = generateId();
    await directPrisma.paymentSubmission.create({
      data: {
        id: subId,
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'esewa',
        reference: 'ESW-LOOKUP-TEST',
        status: 'pending',
        submittedAt: new Date('2026-11-02T10:00:00.000Z'),
      },
    });

    const subRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/transactions/submission:${subId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(subRes.status).toBe(200);
    expect(subRes.body.source).toBe('submission');
    expect(subRes.body.rawId).toBe(subId);
    expect(subRes.body.status).toBe('pendingVerification');

    // 3. Stale submission link after verification resolves to the posted ledger entry
    const verifiedLedgerId = generateId();
    await directPrisma.ledgerEntry.create({
      data: {
        id: verifiedLedgerId,
        groupId: fixture.group.id,
        kind: 'contribution',
        title: "Chirag Member's contribution",
        magnitudePaisa: 500000n,
        occurredAt: new Date('2026-11-02T10:00:00.000Z'),
        postedAt: new Date('2026-11-02T11:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        paymentMethod: 'esewa',
      },
    });
    const verifiedSubId = generateId();
    await directPrisma.paymentSubmission.create({
      data: {
        id: verifiedSubId,
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'esewa',
        reference: 'ESW-VERIFIED-TEST',
        status: 'verified',
        submittedAt: new Date('2026-11-02T10:00:00.000Z'),
        postedLedgerEntryId: verifiedLedgerId,
      },
    });

    const resolvedRes = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/transactions/submission:${verifiedSubId}`,
      )
      .set('Authorization', `Bearer ${token}`);
    expect(resolvedRes.status).toBe(200);
    expect(resolvedRes.body.id).toBe(`ledger:${verifiedLedgerId}`);
    expect(resolvedRes.body.source).toBe('ledger');
    expect(resolvedRes.body.rawId).toBe(verifiedLedgerId);
    expect(resolvedRes.body.status).toBe('verified');

    // 4. Rejected submission visibility rules
    const rejectedSubId = generateId();
    await directPrisma.paymentSubmission.create({
      data: {
        id: rejectedSubId,
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'esewa',
        reference: 'ESW-REJECTED-TEST',
        status: 'rejected',
        rejectionReason: 'wrongAmount',
        submittedAt: new Date('2026-11-02T10:00:00.000Z'),
      },
    });

    const submitterToken = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );
    const treasurerToken = token; // Owner is treasurer
    const otherMemberToken = FakeTokenVerifier.createToken(
      `fb-${fixture.member2.user.id}`,
      fixture.member2.user.email,
      true,
    );

    // Submitter can view their own rejected submission
    const submitterViewRes = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/transactions/submission:${rejectedSubId}`,
      )
      .set('Authorization', `Bearer ${submitterToken}`);
    expect(submitterViewRes.status).toBe(200);
    expect(submitterViewRes.body.id).toBe(`submission:${rejectedSubId}`);
    expect(submitterViewRes.body.status).toBe('rejected');

    // Treasurer can view any rejected submission
    const treasurerViewRes = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/transactions/submission:${rejectedSubId}`,
      )
      .set('Authorization', `Bearer ${treasurerToken}`);
    expect(treasurerViewRes.status).toBe(200);
    expect(treasurerViewRes.body.id).toBe(`submission:${rejectedSubId}`);
    expect(treasurerViewRes.body.status).toBe('rejected');

    // Another plain member receives 404 transaction_not_found
    const otherViewRes = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/transactions/submission:${rejectedSubId}`,
      )
      .set('Authorization', `Bearer ${otherMemberToken}`);
    expect(otherViewRes.status).toBe(404);
    expect(otherViewRes.body.error.code).toBe('transaction_not_found');

    // Unknown transaction -> 404 transaction_not_found
    const missingRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/transactions/ledger:${generateId()}`)
      .set('Authorization', `Bearer ${token}`);
    expect(missingRes.status).toBe(404);
    expect(missingRes.body.error.code).toBe('transaction_not_found');
  });
});
