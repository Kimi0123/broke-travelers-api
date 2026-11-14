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

describe('Bank Reconciliations HTTP Integration & Flutter Parity', () => {
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

  // Fixed time: November 9, 2026 NPT
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

  it('validates exact keys, prevent leaks, and ensures non-treasurer cannot record but can read', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );
    const memberToken = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );

    // Regular member attempts to record reconciliation -> 403 forbidden
    const forbiddenRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${memberToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: '2026-10-31',
        bankBalancePaisa: 520000,
      });
    expect(forbiddenRes.status).toBe(403);
    expect(forbiddenRes.body.error.code).toBe('forbidden');

    // Treasurer records reconciliation -> 201
    const createRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: '2026-10-31',
        bankBalancePaisa: 0,
        note: 'End of October statement',
      });
    expect(createRes.status).toBe(201);
    const body = createRes.body;

    const expectedKeys = [
      'id',
      'groupId',
      'statementDate',
      'bankBalancePaisa',
      'recordedBalancePaisa',
      'differencePaisa',
      'status',
      'note',
      'recordedByMemberId',
      'recordedByName',
      'recordedAt',
    ];
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(
      expectedKeys.sort(),
    );

    // Security leak check: never expose credentials or Firebase UIDs
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('email');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain(fixture.owner.user.firebaseUid);
    expect(serialized).not.toContain(fixture.member1.user.firebaseUid);

    // Regular member CAN read reconciliations list -> 200
    const listRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].id).toBe(body.id);

    // Regular member CAN read recorded-balance endpoint -> 200
    const balRes = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/reconciliations/recorded-balance?date=2026-10-31`,
      )
      .set('Authorization', `Bearer ${memberToken}`);
    expect(balRes.status).toBe(200);
    expect(balRes.body.date).toBe('2026-10-31');
    expect(balRes.body.recordedBalancePaisa).toBeDefined();
  });

  it('rejects future statement date, invalid input, and client-sent computed fields', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Future date (fixedNow is Nov 9, 2026 NPT -> Nov 15 is future)
    const futureRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: '2026-11-15',
        bankBalancePaisa: 100000,
      });
    expect(futureRes.status).toBe(400);
    expect(futureRes.body.error.code).toBe('invalid_statement_date');

    // Future date query on recorded-balance
    const futureBalRes = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/reconciliations/recorded-balance?date=2026-11-15`,
      )
      .set('Authorization', `Bearer ${treasurerToken}`);
    expect(futureBalRes.status).toBe(400);
    expect(futureBalRes.body.error.code).toBe('invalid_statement_date');

    // Negative bank balance
    const negRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: '2026-10-31',
        bankBalancePaisa: -500,
      });
    expect(negRes.status).toBe(400);
    expect(negRes.body.error.code).toBe('invalid_reconciliation_input');

    // Client-sent computed fields (recordedBalancePaisa) rejected
    const computedRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: '2026-10-31',
        bankBalancePaisa: 500000,
        recordedBalancePaisa: 500000,
      });
    expect(computedRes.status).toBe(400);
    expect(computedRes.body.error.code).toBe('invalid_reconciliation_input');
  });

  it('tests recorded-balance at NPT boundaries and guarantees reconciliations never alter ledger entries', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Seed 1 ledger entry on 2026-10-31 12:00:00 NPT (+05:45 -> 06:15:00 UTC)
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'October contribution',
        magnitudePaisa: 520000n, // 5,200 NPR
        occurredAt: new Date('2026-10-31T06:15:00.000Z'),
        postedAt: new Date('2026-10-31T06:15:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-10-01T00:00:00.000Z'),
        paymentMethod: 'bankTransfer',
      },
    });

    // Seed another ledger entry on 2026-11-01 00:05:00 NPT (post-cutoff)
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        kind: 'interest',
        title: 'November interest',
        magnitudePaisa: 10000n,
        occurredAt: new Date('2026-10-31T18:20:00.000Z'), // 00:05:00 NPT on Nov 1
        postedAt: new Date('2026-10-31T18:20:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
      },
    });

    // Check balance on 2026-10-30 (before entries) -> 0
    const bal30 = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/reconciliations/recorded-balance?date=2026-10-30`,
      )
      .set('Authorization', `Bearer ${treasurerToken}`);
    expect(bal30.status).toBe(200);
    expect(bal30.body.recordedBalancePaisa).toBe(0);

    // Check balance on 2026-10-31 (includes October entry up to 23:59:59 NPT, excludes Nov 1) -> 520000
    const bal31 = await request(app)
      .get(
        `/v1/groups/${fixture.group.id}/reconciliations/recorded-balance?date=2026-10-31`,
      )
      .set('Authorization', `Bearer ${treasurerToken}`);
    expect(bal31.status).toBe(200);
    expect(bal31.body.recordedBalancePaisa).toBe(520000);

    // Count ledger rows before reconciliation
    const countBefore = await directPrisma.ledgerEntry.count({
      where: { groupId: fixture.group.id },
    });

    // Record reconciliation
    await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: '2026-10-31',
        bankBalancePaisa: 520000,
      });

    // Ledger rows must remain completely untouched
    const countAfter = await directPrisma.ledgerEntry.count({
      where: { groupId: fixture.group.id },
    });
    expect(countAfter).toBe(countBefore);
  });

  // =========================================================================
  // PARITY SCENARIO (e) reports_e2e_test (Reconciliation stories)
  // =========================================================================

  it('Parity Scenario (e) reports_e2e_test: Record 31 Oct / NPR 5,200 -> matched; NPR 5,000 for another date -> mismatch -NPR 200; duplicate date rejected', async () => {
    // Mirrors Dart tests: test/features/reports/reports_e2e_test.dart:612-625 ('treasurer records a matched reconciliation')
    // and lines 642-658 ('treasurer records a mismatch with the difference').
    // In Flutter, seed group 'g1' has verified ledger balance of NPR 5,200 as of 31 Oct 2026.
    // Dart constants:
    // 1. Matched case (reports_e2e_test.dart:612):
    //    Statement date: 2026-10-31, bank: NPR 5,200 (520,000 paisa), recorded: NPR 5,200 (520,000 paisa), diff: 0 -> status: 'matched'
    // 2. Mismatch case (reports_e2e_test.dart:642):
    //    Bank: NPR 5,000 (500,000 paisa), recorded: NPR 5,200 (520,000 paisa), diff: -NPR 200 (-20,000 paisa, bank is lower) -> status: 'mismatch'
    // In this sequential test, because 2026-10-31 is already recorded, the mismatch test uses 2026-10-26 (post-deposit),
    // which has the exact same recorded balance of NPR 5,200.
    const STATEMENT_DATE_MATCHED = '2026-10-31';
    const BANK_BALANCE_MATCHED_PAISA = 520000;
    const RECORDED_BALANCE_MATCHED_PAISA = 520000;
    const DIFFERENCE_MATCHED_PAISA = 0;
    const STATUS_MATCHED = 'matched';

    const STATEMENT_DATE_MISMATCH = '2026-10-26';
    const BANK_BALANCE_MISMATCH_PAISA = 500000;
    const RECORDED_BALANCE_MISMATCH_PAISA = 520000;
    const DIFFERENCE_MISMATCH_PAISA = -20000;
    const STATUS_MISMATCH = 'mismatch';

    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Seed verified ledger entries matching the fixture balance of NPR 5,200 (520,000 paisa)
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'October Savings',
        magnitudePaisa: BigInt(RECORDED_BALANCE_MATCHED_PAISA),
        occurredAt: new Date('2026-10-25T10:00:00.000Z'),
        postedAt: new Date('2026-10-25T10:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-10-01T00:00:00.000Z'),
        paymentMethod: 'bankTransfer',
      },
    });

    // 1. Record 31 Oct / NPR 5,200 -> bank matches recorded -> matched (difference 0)
    const matchedRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: STATEMENT_DATE_MATCHED,
        bankBalancePaisa: BANK_BALANCE_MATCHED_PAISA,
        note: 'Bank statement 31 Oct',
      });
    expect(matchedRes.status).toBe(201);
    expect(matchedRes.body.status).toBe(STATUS_MATCHED);
    expect(matchedRes.body.recordedBalancePaisa).toBe(
      RECORDED_BALANCE_MATCHED_PAISA,
    );
    expect(matchedRes.body.bankBalancePaisa).toBe(BANK_BALANCE_MATCHED_PAISA);
    expect(matchedRes.body.differencePaisa).toBe(DIFFERENCE_MATCHED_PAISA);

    // 2. Attempt duplicate reconciliation for same date (2026-10-31) -> 409 reconciliation_already_recorded
    const dupRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: STATEMENT_DATE_MATCHED,
        bankBalancePaisa: BANK_BALANCE_MATCHED_PAISA,
      });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.error.code).toBe('reconciliation_already_recorded');

    // 3. Record mismatch: bank NPR 5,000, recorded NPR 5,200 -> difference -NPR 200 (bank lower)
    const mismatchRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/reconciliations`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        statementDate: STATEMENT_DATE_MISMATCH,
        bankBalancePaisa: BANK_BALANCE_MISMATCH_PAISA,
        note: 'Bank mismatch',
      });
    expect(mismatchRes.status).toBe(201);
    expect(mismatchRes.body.status).toBe(STATUS_MISMATCH);
    expect(mismatchRes.body.recordedBalancePaisa).toBe(
      RECORDED_BALANCE_MISMATCH_PAISA,
    );
    expect(mismatchRes.body.bankBalancePaisa).toBe(BANK_BALANCE_MISMATCH_PAISA);
    expect(mismatchRes.body.differencePaisa).toBe(DIFFERENCE_MISMATCH_PAISA);

    // Check audit log for reconciliation.recorded
    const reconAudits = await directPrisma.auditLog.findMany({
      where: {
        groupId: fixture.group.id,
        action: 'reconciliation.recorded',
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(reconAudits).toHaveLength(2);
    expect(reconAudits[0]!.afterValue).toBe(
      `${STATEMENT_DATE_MATCHED}:${DIFFERENCE_MATCHED_PAISA}`,
    );
    expect(reconAudits[1]!.afterValue).toBe(
      `${STATEMENT_DATE_MISMATCH}:${DIFFERENCE_MISMATCH_PAISA}`,
    );
  });
});
