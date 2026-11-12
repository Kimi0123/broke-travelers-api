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

describe('Payments HTTP Integration', () => {
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

  it('submits payment successfully with server-derived expected amount', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const token = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );

    const res = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', generateId())
      .send({
        periodId: '2026-11',
        method: 'esewa',
        reference: 'ESW-12345678',
        note: 'November dues',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.amountPaisa).toBe(500000); // 5000 NPR from group configuration
    expect(res.body.status).toBe('pending');
    expect(res.body.memberId).toBe(fixture.member1.membership.id);
  });

  it('rejects client-supplied amount with 400 invalid_payment_input', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const token = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );

    const res = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', generateId())
      .send({
        periodId: '2026-11',
        method: 'esewa',
        reference: 'ESW-12345678',
        amount: 500000,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_payment_input');
  });

  it('rejects submission for period that is not open (out of range)', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const token = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );

    // Group only exists for November 2026, 2026-05 is before group creation
    const res = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', generateId())
      .send({
        periodId: '2026-05',
        method: 'esewa',
        reference: 'ESW-12345678',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('period_not_open');
  });

  it('rejects submission for non-obligated member with 400 not_obligated', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    // Add past ledger entry so October 2026 is open
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'October seed',
        magnitudePaisa: 500000n,
        occurredAt: new Date('2026-10-10T10:00:00.000Z'),
        postedAt: new Date('2026-10-10T10:00:00.000Z'),
        memberId: fixture.owner.membership.id,
        periodMonth: new Date('2026-10-01T00:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
      },
    });

    // Update member1 to have joined in November 2026
    await directPrisma.groupMembership.update({
      where: { id: fixture.member1.membership.id },
      data: { joinedAt: new Date('2026-11-01T00:00:00.000Z') },
    });

    const token = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );

    const res = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', generateId())
      .send({
        periodId: '2026-10',
        method: 'esewa',
        reference: 'ESW-12345678',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('not_obligated');
  });

  it('rejects duplicate submission for period already submitted or verified (409 already_submitted)', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const token = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );

    // First submission
    const res1 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', generateId())
      .send({
        periodId: '2026-11',
        method: 'esewa',
        reference: 'ESW-11111111',
      });
    expect(res1.status).toBe(201);

    // Second submission by same member for same period with DIFFERENT idempotency key
    const res2 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', generateId())
      .send({
        periodId: '2026-11',
        method: 'khalti',
        reference: 'KH-22222222',
      });
    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('already_submitted');
  });

  it('rejects duplicate reference for same method (409 duplicate_reference), allows same reference across methods', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const token1 = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );
    const token2 = FakeTokenVerifier.createToken(
      `fb-${fixture.member2.user.id}`,
      fixture.member2.user.email,
      true,
    );

    // Member 1 submits with reference ESW-99999999 via esewa
    const res1 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments`)
      .set('Authorization', `Bearer ${token1}`)
      .set('Idempotency-Key', generateId())
      .send({
        periodId: '2026-11',
        method: 'esewa',
        reference: 'ESW-99999999',
      });
    expect(res1.status).toBe(201);

    // Member 2 submits with same reference via esewa -> 409 duplicate_reference
    const res2 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments`)
      .set('Authorization', `Bearer ${token2}`)
      .set('Idempotency-Key', generateId())
      .send({
        periodId: '2026-11',
        method: 'esewa',
        reference: 'esw 99999999', // normalized matches
      });
    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('duplicate_reference');

    // Member 2 submits with same reference via khalti -> allowed (cross-method)
    const res3 = await request(app)
      .post(`/v1/groups/${fixture.group.id}/payments`)
      .set('Authorization', `Bearer ${token2}`)
      .set('Idempotency-Key', generateId())
      .send({
        periodId: '2026-11',
        method: 'khalti',
        reference: 'ESW-99999999',
      });
    expect(res3.status).toBe(201);
  });

  it('GET /payments/my masks references correctly for varying lengths', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const token = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );

    // Test masking lengths by directly creating past submissions or ledger entries
    // Length 12: 'ESW123456789' -> 'Ref ••••6789'
    await directPrisma.paymentSubmission.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'esewa',
        reference: 'ESW123456789',
        status: 'pending',
        submittedAt: new Date('2026-11-10T10:00:00.000Z'),
      },
    });

    // Length 5: '12345' -> 'Ref ••••2345'
    await directPrisma.paymentSubmission.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-10-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'khalti',
        reference: '12345',
        status: 'rejected',
        rejectionReason: 'wrongAmount',
        submittedAt: new Date('2026-10-10T10:00:00.000Z'),
      },
    });

    // Length 4: '1234' -> 'Ref ••••1234'
    await directPrisma.paymentSubmission.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-09-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'bankTransfer',
        reference: '1234',
        status: 'verified',
        submittedAt: new Date('2026-09-10T10:00:00.000Z'),
      },
    });

    // Length 3: '123' -> 'Ref ••••'
    await directPrisma.paymentSubmission.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-08-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'cash',
        reference: '123',
        status: 'verified',
        submittedAt: new Date('2026-08-10T10:00:00.000Z'),
      },
    });

    const res = await request(app)
      .get(`/v1/groups/${fixture.group.id}/payments/my`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);

    const ref12 = res.body.find(
      (p: { paymentMethod: string }) => p.paymentMethod === 'esewa',
    );
    const ref5 = res.body.find(
      (p: { paymentMethod: string }) => p.paymentMethod === 'khalti',
    );
    const ref4 = res.body.find(
      (p: { paymentMethod: string }) => p.paymentMethod === 'bankTransfer',
    );
    const ref3 = res.body.find(
      (p: { paymentMethod: string }) => p.paymentMethod === 'cash',
    );

    expect(ref12.reference).toBe('Ref ••••6789');
    expect(ref5.reference).toBe('Ref ••••2345');
    expect(ref4.reference).toBe('Ref ••••');
    expect(ref3.reference).toBe('Ref ••••');
  });

  it('GET /payments/pending exposes unmasked reference and marks isOwnSubmission', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    // Treasurer token (owner)
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Member 1 submission
    await directPrisma.paymentSubmission.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'esewa',
        reference: 'RAW-ESW-12345678',
        status: 'pending',
        submittedAt: new Date('2026-11-10T10:00:00.000Z'),
      },
    });

    // Owner (treasurer) own submission
    await directPrisma.paymentSubmission.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        memberId: fixture.owner.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'khalti',
        reference: 'RAW-KHL-87654321',
        status: 'pending',
        submittedAt: new Date('2026-11-11T10:00:00.000Z'),
      },
    });

    const res = await request(app)
      .get(`/v1/groups/${fixture.group.id}/payments/pending`)
      .set('Authorization', `Bearer ${treasurerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const m1Sub = res.body.find(
      (p: { memberId: string }) => p.memberId === fixture.member1.membership.id,
    );
    const ownerSub = res.body.find(
      (p: { memberId: string }) => p.memberId === fixture.owner.membership.id,
    );

    expect(m1Sub.reference).toBe('RAW-ESW-12345678'); // Unmasked
    expect(m1Sub.isOwnSubmission).toBe(false);

    expect(ownerSub.reference).toBe('RAW-KHL-87654321'); // Unmasked
    expect(ownerSub.isOwnSubmission).toBe(true);
  });
});
