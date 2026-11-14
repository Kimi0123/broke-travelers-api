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

describe('Reconciliations Deep Coverage & Edge Rules HTTP Suite', () => {
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

  // Fixed clock: 2026-11-09 UTC = 2026-11-09 15:45 NPT (NPT today is Nov 9)
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

  // ---------------------------------------------------------------------------
  // 1. Idempotency key validation and replay
  // ---------------------------------------------------------------------------
  it('1. validates idempotency key (missing/malformed), replays with Idempotent-Replay, and rejects conflicting bodies', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // (a) Missing Idempotency-Key header -> 400 idempotency_key_required
    const missingKeyRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .send({ statementDate: '2026-10-31', bankBalancePaisa: 100000 });
    expect(missingKeyRes.status).toBe(400);
    expect(missingKeyRes.body.error.code).toBe('idempotency_key_required');

    // (b) Malformed key (too short / bad chars) -> 400 invalid_idempotency_key
    const malformedKeyRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', '!!!bad')
      .send({ statementDate: '2026-10-31', bankBalancePaisa: 100000 });
    expect(malformedKeyRes.status).toBe(400);
    expect(malformedKeyRes.body.error.code).toBe('invalid_idempotency_key');

    // (c) First POST with valid key -> 201
    const idempotencyKey = generateId();
    const firstRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ statementDate: '2026-10-31', bankBalancePaisa: 100000 });
    expect(firstRes.status).toBe(201);
    expect(firstRes.headers['idempotent-replay']).toBeUndefined();

    // (d) Same key, same body -> 201 Idempotent-Replay: true (cached response)
    const replayRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ statementDate: '2026-10-31', bankBalancePaisa: 100000 });
    expect(replayRes.status).toBe(201);
    expect(replayRes.headers['idempotent-replay']).toBe('true');
    // Returned body must equal the original response
    expect(replayRes.body.id).toBe(firstRes.body.id);

    // (e) Same key, different body -> 409 idempotency_conflict
    const conflictRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ statementDate: '2026-10-31', bankBalancePaisa: 999999 });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error.code).toBe('idempotency_conflict');
  });

  // ---------------------------------------------------------------------------
  // 1b. Actor scoping: same key string from two different actors does NOT collide
  // ---------------------------------------------------------------------------
  it('1b. actor scoping: same idempotency key string from two treasurers creates two independent DB rows', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );
    const treasurer2Token = FakeTokenVerifier.createToken(
      `fb-${fixture.secondTreasurer.user.id}`,
      fixture.secondTreasurer.user.email,
      true,
    );

    const sharedKey = generateId();

    // Owner records Oct 31
    const ownerRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', sharedKey)
      .send({ statementDate: '2026-10-31', bankBalancePaisa: 100000 });
    expect(ownerRes.status).toBe(201);

    // Treasurer2 reuses the same key string but for a DIFFERENT date
    // This would succeed because the idempotency lookup scopes by actorUserId too,
    // so the same key belongs to a different actor -> treated as a fresh request.
    // But Oct 31 is now already recorded, so we use Oct 30 for treasurer2.
    const tr2Res = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurer2Token}`)
      .set('Idempotency-Key', sharedKey)
      .send({ statementDate: '2026-10-30', bankBalancePaisa: 50000 });
    expect(tr2Res.status).toBe(201);

    // Two distinct DB rows
    const rows = await directPrisma.bankReconciliation.findMany({
      where: { groupId: fixture.group.id },
    });
    expect(rows).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // 2. Concurrent duplicate statement date -> exactly 1×201, rest 409
  // ---------------------------------------------------------------------------
  it('2. concurrent duplicate statement date -> exactly 1 success and N-1 reconciliation_already_recorded', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Fire 5 concurrent POSTs with different idempotency keys but same statement date
    const statementDate = '2026-10-31';
    const results = await Promise.all(
      Array.from({ length: 5 }).map(() =>
        request(app)
          .post(`/v1/groups/${fixture.group.id}/reconciliations`)
          .set('Authorization', `Bearer ${treasurerToken}`)
          .set('Idempotency-Key', generateId())
          .send({ statementDate, bankBalancePaisa: 100000 }),
      ),
    );

    const statuses = results.map((r) => r.status);
    const created = statuses.filter((s) => s === 201);
    const conflict = statuses.filter((s) => s === 409);
    expect(created).toHaveLength(1);
    expect(conflict).toHaveLength(4);
    // Verify every 409 carries the right error code
    for (const r of results.filter((r) => r.status === 409)) {
      expect(r.body.error.code).toBe('reconciliation_already_recorded');
    }

    // Exactly 1 DB row for this date
    const rows = await directPrisma.bankReconciliation.findMany({
      where: { groupId: fixture.group.id },
    });
    expect(rows).toHaveLength(1);

    // Exactly 1 audit log entry
    const audits = await directPrisma.auditLog.findMany({
      where: { groupId: fixture.group.id, action: 'reconciliation.recorded' },
    });
    expect(audits).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 3. Difference sign: bank higher (+) and bank lower (-)
  // ---------------------------------------------------------------------------
  it('3. difference sign: bank higher gives positive diff, bank lower gives negative diff', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Seed a ledger entry: recorded balance = 300,000 paisa on Oct 31
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'Seed contribution',
        magnitudePaisa: 300000n,
        occurredAt: new Date('2026-10-25T10:00:00.000Z'),
        postedAt: new Date('2026-10-25T10:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-10-01T00:00:00.000Z'),
        paymentMethod: 'bankTransfer',
      },
    });

    // Bank higher: bank=400,000 paisa, recorded=300,000 -> diff=+100,000 (mismatch)
    const higherRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ statementDate: '2026-10-31', bankBalancePaisa: 400000 });
    expect(higherRes.status).toBe(201);
    expect(higherRes.body.differencePaisa).toBe(100000); // positive: bank higher
    expect(higherRes.body.status).toBe('mismatch');

    // Bank lower: bank=200,000 paisa, recorded=300,000 -> diff=-100,000 (mismatch)
    const lowerRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ statementDate: '2026-10-30', bankBalancePaisa: 200000 });
    expect(lowerRes.status).toBe(201);
    expect(lowerRes.body.differencePaisa).toBe(-100000); // negative: bank lower
    expect(lowerRes.body.status).toBe('mismatch');

    // Bank equals recorded -> status matched, diff=0
    const matchedRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ statementDate: '2026-10-29', bankBalancePaisa: 300000 });
    expect(matchedRes.status).toBe(201);
    expect(matchedRes.body.differencePaisa).toBe(0);
    expect(matchedRes.body.status).toBe('matched');
  });

  // ---------------------------------------------------------------------------
  // 4. bankBalancePaisa boundary validation
  // ---------------------------------------------------------------------------
  it('4. bankBalancePaisa: 0 accepted; negative/above ceiling/non-integer rejected', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // 0 is accepted (empty-balance scenario)
    const zeroRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ statementDate: '2026-10-31', bankBalancePaisa: 0 });
    expect(zeroRes.status).toBe(201);
    expect(zeroRes.body.bankBalancePaisa).toBe(0);

    // Negative -> 400 invalid_reconciliation_input
    const negRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ statementDate: '2026-10-30', bankBalancePaisa: -1 });
    expect(negRes.status).toBe(400);
    expect(negRes.body.error.code).toBe('invalid_reconciliation_input');

    // Above ceiling (> 1,000,000,000) -> 400 invalid_reconciliation_input
    const ceilingRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ statementDate: '2026-10-29', bankBalancePaisa: 1000000001 });
    expect(ceilingRes.status).toBe(400);
    expect(ceilingRes.body.error.code).toBe('invalid_reconciliation_input');

    // Non-integer (float) -> 400 invalid_reconciliation_input
    const floatRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ statementDate: '2026-10-28', bankBalancePaisa: 100.5 });
    expect(floatRes.status).toBe(400);
    expect(floatRes.body.error.code).toBe('invalid_reconciliation_input');
  });

  // ---------------------------------------------------------------------------
  // 5. Note length boundary: 200 chars accepted, 201 chars rejected
  // ---------------------------------------------------------------------------
  it('5. note: 200-char note accepted, 201-char note rejected', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    const note200 = 'a'.repeat(200);
    const okRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: '2026-10-31',
        bankBalancePaisa: 0,
        note: note200,
      });
    expect(okRes.status).toBe(201);

    const note201 = 'a'.repeat(201);
    const badRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: '2026-10-30',
        bankBalancePaisa: 0,
        note: note201,
      });
    expect(badRes.status).toBe(400);
    expect(badRes.body.error.code).toBe('invalid_reconciliation_input');
  });

  // ---------------------------------------------------------------------------
  // 6. Statement date = today in NPT accepted; tomorrow rejected (NPT midnight boundary)
  // ---------------------------------------------------------------------------
  it('6. statement date = today in NPT accepted; tomorrow in NPT rejected at midnight boundary', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // NPT is UTC+05:45. 2026-11-09T18:14:59Z = 23:59:59 NPT on 2026-11-09 (still today)
    simulatedNow = new Date('2026-11-09T18:14:59.000Z'); // 23:59:59 NPT Nov 9
    const todayNpt = '2026-11-09';
    const tomorrowNpt = '2026-11-10';

    const todayRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ statementDate: todayNpt, bankBalancePaisa: 0 });
    expect(todayRes.status).toBe(201); // today in NPT is valid

    const tomorrowBeforeMidnight = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ statementDate: tomorrowNpt, bankBalancePaisa: 0 });
    expect(tomorrowBeforeMidnight.status).toBe(400);
    expect(tomorrowBeforeMidnight.body.error.code).toBe(
      'invalid_statement_date',
    );

    // 2026-11-09T18:15:00Z = 00:00:00 NPT on 2026-11-10 (now today is Nov 10)
    simulatedNow = new Date('2026-11-09T18:15:00.000Z'); // 00:00:00 NPT Nov 10

    // Nov 10 is now today in NPT -> accepted
    const nowTodayRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ statementDate: tomorrowNpt, bankBalancePaisa: 0 });
    expect(nowTodayRes.status).toBe(201);

    // Nov 11 is tomorrow now -> rejected
    const nov11Res = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ statementDate: '2026-11-11', bankBalancePaisa: 0 });
    expect(nov11Res.status).toBe(400);
    expect(nov11Res.body.error.code).toBe('invalid_statement_date');
  });

  // ---------------------------------------------------------------------------
  // 7. Client-sent computed fields (recordedBalancePaisa, differencePaisa, status) rejected
  // ---------------------------------------------------------------------------
  it('7. client-sent computed fields are rejected with invalid_reconciliation_input', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // recordedBalancePaisa rejected
    const recBalRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: '2026-10-31',
        bankBalancePaisa: 100000,
        recordedBalancePaisa: 100000,
      });
    expect(recBalRes.status).toBe(400);
    expect(recBalRes.body.error.code).toBe('invalid_reconciliation_input');

    // differencePaisa rejected
    const diffRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: '2026-10-31',
        bankBalancePaisa: 100000,
        differencePaisa: 0,
      });
    expect(diffRes.status).toBe(400);
    expect(diffRes.body.error.code).toBe('invalid_reconciliation_input');

    // status field rejected
    const statusRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: '2026-10-31',
        bankBalancePaisa: 100000,
        status: 'matched',
      });
    expect(statusRes.status).toBe(400);
    expect(statusRes.body.error.code).toBe('invalid_reconciliation_input');
  });

  // ---------------------------------------------------------------------------
  // 8. GET recorded-balance: any active member can call; 0 before entries; correct after entry/reversal
  // ---------------------------------------------------------------------------
  it('8. recorded-balance: readable by any member; 0 before entries; updates after ledger changes', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );
    const memberToken = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );

    // Before any ledger entries -> 0
    const emptyRes = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/reconciliations/recorded-balance?date=2026-10-31`,
      )
      .set('Authorization', `Bearer ${memberToken}`);
    expect(emptyRes.status).toBe(200);
    expect(emptyRes.body.recordedBalancePaisa).toBe(0);

    // Seed an expense entry: magnitudePaisa = 200,000 (counts as positive into balance)
    const originalEntryId = generateId();
    await directPrisma.ledgerEntry.create({
      data: {
        id: originalEntryId,
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'Oct contribution',
        magnitudePaisa: 200000n,
        occurredAt: new Date('2026-10-20T10:00:00.000Z'),
        postedAt: new Date('2026-10-20T10:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-10-01T00:00:00.000Z'),
        paymentMethod: 'bankTransfer',
      },
    });

    // After entry -> 200,000
    const afterRes = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/reconciliations/recorded-balance?date=2026-10-31`,
      )
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(afterRes.status).toBe(200);
    expect(afterRes.body.recordedBalancePaisa).toBe(200000);
    expect(afterRes.body.date).toBe('2026-10-31');

    // Any active member (not just treasurer) can read it
    const memberReadRes = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/reconciliations/recorded-balance?date=2026-10-31`,
      )
      .set('Authorization', `Bearer ${memberToken}`);
    expect(memberReadRes.status).toBe(200);
    expect(memberReadRes.body.recordedBalancePaisa).toBe(200000);

    // Seed a reversal entry: interest (inflow) with reversesEntryId flips to negative,
    // reducing the balance. Constraint: reversesEntryId only allowed with kind in ('expense','interest').
    const reversalEntryId = generateId();
    await directPrisma.ledgerEntry.create({
      data: {
        id: reversalEntryId,
        groupId: fixture.group.id,
        kind: 'interest', // DB constraint: reversesEntryId only allowed with expense/interest
        title: 'Reversal of Oct contribution',
        magnitudePaisa: 200000n,
        occurredAt: new Date('2026-10-25T10:00:00.000Z'),
        postedAt: new Date('2026-10-25T10:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
        reversesEntryId: originalEntryId,
      },
    });

    // After reversal -> balance should be 0 (contribution reversed)
    const afterReversalRes = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/reconciliations/recorded-balance?date=2026-10-31`,
      )
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(afterReversalRes.status).toBe(200);
    expect(afterReversalRes.body.recordedBalancePaisa).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 9. Ledger and submission counts unchanged after reconciliation POST
  // ---------------------------------------------------------------------------
  it('9. reconciliation POST does not alter ledger or submission rows', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Seed one ledger entry
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'Oct contribution',
        magnitudePaisa: 100000n,
        occurredAt: new Date('2026-10-15T10:00:00.000Z'),
        postedAt: new Date('2026-10-15T10:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-10-01T00:00:00.000Z'),
        paymentMethod: 'bankTransfer',
      },
    });

    const ledgerCountBefore = await directPrisma.ledgerEntry.count({
      where: { groupId: fixture.group.id },
    });
    const submissionCountBefore = await directPrisma.paymentSubmission.count({
      where: { groupId: fixture.group.id },
    });

    await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ statementDate: '2026-10-31', bankBalancePaisa: 100000 });

    const ledgerCountAfter = await directPrisma.ledgerEntry.count({
      where: { groupId: fixture.group.id },
    });
    const submissionCountAfter = await directPrisma.paymentSubmission.count({
      where: { groupId: fixture.group.id },
    });

    expect(ledgerCountAfter).toBe(ledgerCountBefore);
    expect(submissionCountAfter).toBe(submissionCountBefore);
  });

  // ---------------------------------------------------------------------------
  // 10. History ordering (newest statement date first) and credential exposure prevention
  // ---------------------------------------------------------------------------
  it('10. list ordered by newest statement date first; response includes recordedByName but not email/firebaseUid', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Record three reconciliations in reverse chronological order
    const dates = ['2026-10-15', '2026-10-31', '2026-10-20'];
    for (const date of dates) {
      await request(app)
        .post(`/v1/groups/${fixture.group.id}/reconciliations`)
        .set('Authorization', `Bearer ${treasurerToken}`)
        .set('Idempotency-Key', generateId())
        .send({ statementDate: date, bankBalancePaisa: 0 });
    }

    const listRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`);
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect((listRes.body as unknown[]).length).toBe(3);

    // Should be ordered newest statement date first
    const statementDates = (
      listRes.body as Array<{ statementDate: string }>
    ).map((r) => r.statementDate);
    expect(statementDates[0]).toBe('2026-10-31');
    expect(statementDates[1]).toBe('2026-10-20');
    expect(statementDates[2]).toBe('2026-10-15');

    // Each item must have recordedByName but NOT email, firebaseUid, or password
    const serialized = JSON.stringify(listRes.body);
    expect(serialized).toContain('recordedByName');
    expect(serialized).not.toContain('@example.com');
    expect(serialized).not.toContain('firebaseUid');
    expect(serialized).not.toContain('password');
  });
});
