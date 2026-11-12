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

describe('Transactions & Reversals HTTP Integration', () => {
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

  it('records expense and interest entries correctly, creating audit logs and updating balance', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Seed initial contribution into ledger so balance is 10,000 NPR (1,000,000 paisa)
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'Initial pool',
        magnitudePaisa: 1000000n,
        occurredAt: new Date('2026-11-01T10:00:00.000Z'),
        postedAt: new Date('2026-11-01T10:00:00.000Z'),
        memberId: fixture.owner.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
      },
    });

    // Record expense of 2,000 NPR (200,000 paisa)
    const expenseRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/transactions`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'expense',
        amountPaisa: 200000,
        occurredAt: '2026-11-10T12:00:00.000Z',
        title: 'Lunch and snacks',
        note: 'Team meal',
        method: 'cash',
      });

    expect(expenseRes.status).toBe(201);
    expect(expenseRes.body.kind).toBe('expense');
    expect(expenseRes.body.amountPaisa).toBe(200000);
    expect(expenseRes.body.signedAmountPaisa).toBe(-200000);
    expect(expenseRes.body.source).toBe('ledger');

    // Record interest credit of 500 NPR (50,000 paisa)
    const interestRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/transactions`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'interest',
        amountPaisa: 50000,
        occurredAt: '2026-11-12T12:00:00.000Z',
        title: 'Bank interest credit',
        note: 'Quarterly interest',
        method: 'bankTransfer',
      });

    expect(interestRes.status).toBe(201);
    expect(interestRes.body.kind).toBe('interest');
    expect(interestRes.body.amountPaisa).toBe(50000);
    expect(interestRes.body.signedAmountPaisa).toBe(50000);

    // Verify audit logs were written
    const auditLogs = await directPrisma.auditLog.findMany({
      where: {
        groupId: fixture.group.id,
        action: 'ledger_entry.posted',
      },
    });
    expect(auditLogs).toHaveLength(2);
  });

  it('rejects recording withdrawal directly with 400 invalid_transaction_input', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    const res = await request(app)
      .post(`/v1/groups/${fixture.group.id}/transactions`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'withdrawal',
        amountPaisa: 50000,
        occurredAt: '2026-11-10T12:00:00.000Z',
        title: 'Emergency withdrawal',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_transaction_input');
  });

  it('enforces balance guard: expense exceeding verified balance returns 409 insufficient_balance', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Pool balance is currently 0. Attempt expense of 500 NPR (50,000 paisa)
    const res = await request(app)
      .post(`/v1/groups/${fixture.group.id}/transactions`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'expense',
        amountPaisa: 50000,
        occurredAt: '2026-11-10T12:00:00.000Z',
        title: 'Bus fare',
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('insufficient_balance');
  });

  it('enforces 366-day date window: past > 366 days or future returns 400 invalid_transaction_input', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Future date
    const futureRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/transactions`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'interest',
        amountPaisa: 1000,
        occurredAt: '2027-01-01T00:00:00.000Z',
        title: 'Future interest',
      });

    expect(futureRes.status).toBe(400);
    expect(futureRes.body.error.code).toBe('invalid_transaction_input');

    // > 366 days in the past (clock is Nov 15 2026)
    const pastRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/transactions`)
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        kind: 'interest',
        amountPaisa: 1000,
        occurredAt: '2025-10-01T00:00:00.000Z',
        title: 'Ancient interest',
      });

    expect(pastRes.status).toBe(400);
    expect(pastRes.body.error.code).toBe('invalid_transaction_input');
  });

  it('reverses an expense successfully, restoring balance and creating reversal transaction', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Seed pool of 1,000,000 paisa
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'Seed pool',
        magnitudePaisa: 1000000n,
        occurredAt: new Date('2026-11-01T10:00:00.000Z'),
        postedAt: new Date('2026-11-01T10:00:00.000Z'),
        memberId: fixture.owner.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
      },
    });

    // Record expense of 100,000 paisa
    const expenseEntryId = generateId();
    await directPrisma.ledgerEntry.create({
      data: {
        id: expenseEntryId,
        groupId: fixture.group.id,
        kind: 'expense',
        title: 'Permit fees',
        magnitudePaisa: 100000n,
        occurredAt: new Date('2026-11-05T10:00:00.000Z'),
        postedAt: new Date('2026-11-05T10:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
      },
    });

    // Reverse expense
    const res = await request(app)
      .post(
        `/v1/groups/${fixture.group.id}/transactions/ledger:${expenseEntryId}/reverse`,
      )
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        reason: 'Permit refunded by park authority',
      });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('expense');
    expect(res.body.title).toBe('Reversal: Permit fees');
    expect(res.body.reversesTransactionId).toBe(`ledger:${expenseEntryId}`);
    expect(res.body.signedAmountPaisa).toBe(100000); // Reversal of expense is positive (+100000)

    // Attempt second reversal -> 409 transaction_already_reversed
    const dupRes = await request(app)
      .post(
        `/v1/groups/${fixture.group.id}/transactions/ledger:${expenseEntryId}/reverse`,
      )
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({
        reason: 'Attempting duplicate reversal',
      });

    expect(dupRes.status).toBe(409);
    expect(dupRes.body.error.code).toBe('transaction_already_reversed');
  });

  it('rejects reversal of non-expense/non-interest transactions with 400 transaction_not_reversible', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Contribution entry
    const contribId = generateId();
    await directPrisma.ledgerEntry.create({
      data: {
        id: contribId,
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'Member contribution',
        magnitudePaisa: 500000n,
        occurredAt: new Date('2026-11-01T10:00:00.000Z'),
        postedAt: new Date('2026-11-01T10:00:00.000Z'),
        memberId: fixture.owner.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
      },
    });

    const res = await request(app)
      .post(
        `/v1/groups/${fixture.group.id}/transactions/ledger:${contribId}/reverse`,
      )
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ reason: 'Cannot reverse contribution' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('transaction_not_reversible');
  });

  it('enforces balance guard when reversing interest credit', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const treasurerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Pool has 100,000 paisa from interest credit
    const interestId = generateId();
    await directPrisma.ledgerEntry.create({
      data: {
        id: interestId,
        groupId: fixture.group.id,
        kind: 'interest',
        title: 'Bank interest',
        magnitudePaisa: 100000n,
        occurredAt: new Date('2026-11-01T10:00:00.000Z'),
        postedAt: new Date('2026-11-01T10:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
      },
    });

    // An expense of 80,000 paisa was recorded against it, leaving 20,000 paisa in balance
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        kind: 'expense',
        title: 'Office supplies',
        magnitudePaisa: 80000n,
        occurredAt: new Date('2026-11-05T10:00:00.000Z'),
        postedAt: new Date('2026-11-05T10:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
      },
    });

    // Reversing the 100,000 paisa interest would bring balance to -80,000 paisa -> 409 insufficient_balance
    const res = await request(app)
      .post(
        `/v1/groups/${fixture.group.id}/transactions/ledger:${interestId}/reverse`,
      )
      .set('Authorization', `Bearer ${treasurerToken}`)
      .set('Idempotency-Key', generateId())
      .send({ reason: 'Bank recalled interest' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('insufficient_balance');
  });
});
