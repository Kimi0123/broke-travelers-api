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

describe('Payment Reviews HTTP Integration', () => {
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

  it('verify submission atomically updates status, posts 1 ledger entry, creates audit log and updates activity view', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    // Treasurer token (owner)
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Member 1 submission
    const subId = generateId();
    await directPrisma.paymentSubmission.create({
      data: {
        id: subId,
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'esewa',
        reference: 'ESW-12345678',
        status: 'pending',
        submittedAt: new Date('2026-11-10T10:00:00.000Z'),
      },
    });

    const res = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments/${subId}/verify`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send();

    expect(res.status).toBe(200);
    expect(res.body.submission.status).toBe('verified');
    expect(res.body.submission.postedLedgerEntryId).toBeDefined();
    expect(res.body.ledgerEntry).toBeDefined();
    expect(res.body.ledgerEntry.kind).toBe('contribution');
    expect(res.body.ledgerEntry.magnitudePaisa).toBe(500000);

    // Verify exactly 1 ledger entry in database
    const ledgerCount = await directPrisma.ledgerEntry.count({
      where: { groupId: fixture.group.id },
    });
    expect(ledgerCount).toBe(1);

    // Verify audit log recorded
    const auditLogs = await directPrisma.auditLog.findMany({
      where: {
        groupId: fixture.group.id,
        action: 'payment_submission.verified',
      },
    });
    expect(auditLogs).toHaveLength(1);

    // Verify activity view shows 1 item with status verified
    const activityRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/transactions`)
      .set('Authorization', `Bearer ${treasurerToken}`);

    expect(activityRes.status).toBe(200);
    expect(activityRes.body.items).toHaveLength(1);
    expect(activityRes.body.items[0].status).toBe('verified');
    expect(activityRes.body.items[0].source).toBe('ledger');
  });

  it('reject submission updates status, records reason & note, and writes audit log', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    const subId = generateId();
    await directPrisma.paymentSubmission.create({
      data: {
        id: subId,
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'khalti',
        reference: 'KH-888888',
        status: 'pending',
        submittedAt: new Date('2026-11-10T10:00:00.000Z'),
      },
    });

    const res = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments/${subId}/reject`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        reason: 'referenceNotFound',
        note: 'No payment with reference KH-888888 found in bank statement',
      });

    expect(res.status).toBe(200);
    expect(res.body.submission.status).toBe('rejected');
    expect(res.body.submission.rejectionReason).toBe('referenceNotFound');
    expect(res.body.submission.rejectionNote).toBe(
      'No payment with reference KH-888888 found in bank statement',
    );

    // No ledger entries posted
    const ledgerCount = await directPrisma.ledgerEntry.count({
      where: { groupId: fixture.group.id },
    });
    expect(ledgerCount).toBe(0);

    // Audit log created
    const auditLogs = await directPrisma.auditLog.findMany({
      where: {
        groupId: fixture.group.id,
        action: 'payment_submission.rejected',
      },
    });
    expect(auditLogs).toHaveLength(1);
  });

  it('separation of duties: treasurer cannot verify own payment when another treasurer exists', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    // Owner is a treasurer. Second treasurer exists (Bina)
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    const secondTreasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.secondTreasurer.user.id}`,
      fixture.secondTreasurer.user.email,
      true,
    );

    // Owner creates a submission
    const ownerSubId = generateId();
    await directPrisma.paymentSubmission.create({
      data: {
        id: ownerSubId,
        groupId: fixture.group.id,
        memberId: fixture.owner.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'bankTransfer',
        reference: 'TXN-OWNER-01',
        status: 'pending',
        submittedAt: new Date('2026-11-10T10:00:00.000Z'),
      },
    });

    // Owner attempts to verify own payment -> 403 cannot_review_own_payment
    const ownVerifyRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments/${ownerSubId}/verify`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', generateId())
      .send();

    expect(ownVerifyRes.status).toBe(403);
    expect(ownVerifyRes.body.error.code).toBe('cannot_review_own_payment');

    // Second treasurer verifies owner's payment -> 200 OK
    const otherVerifyRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments/${ownerSubId}/verify`)
      .set('Authorization', `Bearer ${secondTreasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send();

    expect(otherVerifyRes.status).toBe(200);
    expect(otherVerifyRes.body.submission.status).toBe('verified');
  });

  it('separation of duties: sole treasurer CAN verify own payment when no other treasurer exists', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    // Remove treasurer role from secondTreasurer
    await directPrisma.groupMembership.update({
      where: { id: fixture.secondTreasurer.membership.id },
      data: { isTreasurer: false },
    });

    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Owner creates a submission
    const ownerSubId = generateId();
    await directPrisma.paymentSubmission.create({
      data: {
        id: ownerSubId,
        groupId: fixture.group.id,
        memberId: fixture.owner.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'cash',
        reference: null,
        status: 'pending',
        submittedAt: new Date('2026-11-10T10:00:00.000Z'),
      },
    });

    // Sole treasurer can verify own payment
    const res = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments/${ownerSubId}/verify`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', generateId())
      .send();

    expect(res.status).toBe(200);
    expect(res.body.submission.status).toBe('verified');
  });

  it('double review returns 409 already_reviewed', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    const subId = generateId();
    await directPrisma.paymentSubmission.create({
      data: {
        id: subId,
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'esewa',
        reference: 'ESW-12345678',
        status: 'pending',
        submittedAt: new Date('2026-11-10T10:00:00.000Z'),
      },
    });

    // Verify first time
    const res1 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments/${subId}/verify`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send();
    expect(res1.status).toBe(200);

    // Attempt second review with new idempotency key -> 409 already_reviewed
    const res2 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments/${subId}/reject`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ reason: 'wrongAmount' });

    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('already_reviewed');
  });

  it('concurrent review race condition: exactly 1 ledger entry posted', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurer1Token = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );
    const treasurer2Token = FakeTokenVerifier.createToken(
      `fb-${fixture.secondTreasurer.user.id}`,
      fixture.secondTreasurer.user.email,
      true,
    );

    const subId = generateId();
    await directPrisma.paymentSubmission.create({
      data: {
        id: subId,
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'esewa',
        reference: 'ESW-CONCURRENT',
        status: 'pending',
        submittedAt: new Date('2026-11-10T10:00:00.000Z'),
      },
    });

    // Send two concurrent verify requests
    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/v1/groups/${fixture.group.id}/payments/${subId}/verify`)
        .set('Authorization', `Bearer ${treasurer1Token}`)
        .set('Idempotency-Key', generateId())
        .send(),
      request(app)
        .post(`/v1/groups/${fixture.group.id}/payments/${subId}/verify`)
        .set('Authorization', `Bearer ${treasurer2Token}`)
        .set('Idempotency-Key', generateId())
        .send(),
    ]);

    const statuses = [r1.status, r2.status].sort();
    // One must succeed (200) and one must conflict (409 already_reviewed)
    expect(statuses).toEqual([200, 409]);

    const ledgerEntries = await directPrisma.ledgerEntry.findMany({
      where: { groupId: fixture.group.id },
    });
    expect(ledgerEntries).toHaveLength(1);
  });
});
