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

describe('Contributions HTTP Integration', () => {
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

  // Fixed clock for tests: November 15, 2026 NPT
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

  it('GET /v1/groups/:groupId/contributions/periods returns summaries from earliest entry to current anchor', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const token = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Group created in November 2026. Let's add a past ledger entry in September 2026
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'Initial contribution',
        magnitudePaisa: 500000n,
        occurredAt: new Date('2026-09-10T10:00:00.000Z'),
        postedAt: new Date('2026-09-10T10:00:00.000Z'),
        memberId: fixture.owner.membership.id,
        periodMonth: new Date('2026-09-01T00:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
      },
    });

    const res = await request(app)
      .get(`/v1/groups/${fixture.group.id}/contributions/periods`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Should have 3 periods: 2026-11, 2026-10, 2026-09 (newest first)
    expect(res.body).toHaveLength(3);
    expect(res.body[0].id).toBe('2026-11');
    expect(res.body[0].isCurrent).toBe(true);
    expect(res.body[1].id).toBe('2026-10');
    expect(res.body[1].isCurrent).toBe(false);
    expect(res.body[2].id).toBe('2026-09');
    expect(res.body[2].isCurrent).toBe(false);
  });

  it('GET /v1/groups/:groupId/contributions/periods/:periodId returns period detail and obligations', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const token = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    const res = await request(app)
      .get(`/v1/groups/${fixture.group.id}/contributions/periods/2026-11`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.id).toBe('2026-11');
    expect(res.body.summary.obligatedCount).toBe(5);
    expect(res.body.obligations).toHaveLength(5);
  });

  it('GET /v1/groups/:groupId/contributions/periods/:periodId returns 404 period_not_found for out-of-range period', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const token = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Period in future
    const res = await request(app)
      .get(`/v1/groups/${fixture.group.id}/contributions/periods/2027-01`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('period_not_found');
  });

  it('excludes members joined after period and members who left before period from obligations', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const token = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Add entry in 2026-08 so periods exist back to 2026-08
    await directPrisma.ledgerEntry.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'August contribution',
        magnitudePaisa: 500000n,
        occurredAt: new Date('2026-08-10T10:00:00.000Z'),
        postedAt: new Date('2026-08-10T10:00:00.000Z'),
        memberId: fixture.owner.membership.id,
        periodMonth: new Date('2026-08-01T00:00:00.000Z'),
        actorMemberId: fixture.owner.membership.id,
      },
    });

    // Update member1 to have joined in October 2026
    await directPrisma.groupMembership.update({
      where: { id: fixture.member1.membership.id },
      data: { joinedAt: new Date('2026-10-15T00:00:00.000Z') },
    });

    // Update member2 to have left in September 2026
    await directPrisma.groupMembership.update({
      where: { id: fixture.member2.membership.id },
      data: {
        joinedAt: new Date('2026-08-01T00:00:00.000Z'),
        leftAt: new Date('2026-09-15T00:00:00.000Z'),
      },
    });

    // Check August 2026: member1 should NOT be obligated (joined in October)
    // member2 SHOULD be obligated (joined Aug 1, left Sept 15)
    const augRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/contributions/periods/2026-08`)
      .set('Authorization', `Bearer ${token}`);

    expect(augRes.status).toBe(200);
    const augMemberIds = augRes.body.obligations.map(
      (o: { memberId: string }) => o.memberId,
    );
    expect(augMemberIds).not.toContain(fixture.member1.membership.id);
    expect(augMemberIds).toContain(fixture.member2.membership.id);

    // Check October 2026: member1 SHOULD be obligated (joined Oct 15)
    // member2 should NOT be obligated (left in Sept)
    const octRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}/contributions/periods/2026-10`)
      .set('Authorization', `Bearer ${token}`);

    expect(octRes.status).toBe(200);
    const octMemberIds = octRes.body.obligations.map(
      (o: { memberId: string }) => o.memberId,
    );
    expect(octMemberIds).toContain(fixture.member1.membership.id);
    expect(octMemberIds).not.toContain(fixture.member2.membership.id);
  });
});
