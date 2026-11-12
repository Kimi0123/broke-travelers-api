/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { createApp } from '../../src/http/app.js';
import type { AppConfig } from '../../src/config/env.js';
import { FakeTokenVerifier } from '../support/fake-token-verifier.js';
import {
  closeAllTestClients,
  getTestDirectPrisma,
  getTestPrisma,
  resetTestDatabase,
  seedStandardGroup,
} from './setup.js';

describe('Groups HTTP Integration', () => {
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

  const app = createApp({
    prisma,
    config: testConfig,
    tokenVerifier,
    logger: pino({ level: 'silent' }),
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeAllTestClients();
  });

  it('POST /v1/groups creates group, assigns owner & treasurer, creates audit log, supports replay & conflict', async () => {
    // 1. Provision user
    const token = FakeTokenVerifier.createToken(
      'creator-uid',
      'creator@test.com',
      true,
      'Creator',
    );
    const sessionRes = await request(app)
      .post('/v1/session')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'Creator User' });
    expect(sessionRes.status).toBe(200);

    const idempotencyKey = 'grp-idemp-001';
    const payload = {
      name: 'Himalayan Explorers',
      monthlyContributionPaisa: 500000,
      dueDay: 15,
    };

    // 2. Initial group creation
    const createRes = await request(app)
      .post('/v1/groups')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);

    expect(createRes.status).toBe(201);
    expect(createRes.body).toMatchObject({
      id: expect.any(String),
      name: 'Himalayan Explorers',
      monthlyContributionPaisa: 500000,
      dueDay: 15,
      memberCount: 1,
      createdAt: expect.any(String),
    });
    expect(createRes.headers['idempotent-replay']).toBeUndefined();

    const groupId = createRes.body.id;

    // Verify creator is owner & treasurer in database
    const membership = await directPrisma.groupMembership.findFirst({
      where: { groupId, isOwner: true, isTreasurer: true },
    });
    expect(membership).toBeTruthy();

    // Verify audit log
    const auditLog = await directPrisma.auditLog.findFirst({
      where: { groupId, action: 'group_created' },
    });
    expect(auditLog).toBeTruthy();

    // 3. Exact idempotency replay returns identical cached body with Idempotent-Replay: true
    const replayRes = await request(app)
      .post('/v1/groups')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);

    expect(replayRes.status).toBe(201);
    expect(replayRes.headers['idempotent-replay']).toBe('true');
    expect(replayRes.body).toEqual(createRes.body);

    // 4. Conflicting payload with same idempotency key returns 409 idempotency_conflict
    const conflictRes = await request(app)
      .post('/v1/groups')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ ...payload, name: 'Different Name' });

    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error.code).toBe('idempotency_conflict');
  });

  it('rejects invalid group settings (dueDay out of bounds, invalid amounts, empty names)', async () => {
    const token = FakeTokenVerifier.createToken(
      'valid-user-uid',
      'v@test.com',
      true,
    );
    await request(app)
      .post('/v1/session')
      .set('Authorization', `Bearer ${token}`)
      .send();

    // Invalid dueDay (0, 29, 31)
    for (const badDueDay of [0, 29, 31, -1]) {
      const res = await request(app)
        .post('/v1/groups')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', `bad-due-${badDueDay}`)
        .send({
          name: 'Valid Name',
          monthlyContributionPaisa: 10000,
          dueDay: badDueDay,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_group_settings');
    }

    // Invalid monthlyContributionPaisa (0, negative, floating point, > 10,000,000 NPR)
    for (const badAmount of [0, -500, 100.5, 10_000_000_01]) {
      const res = await request(app)
        .post('/v1/groups')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', `bad-amt-${badAmount}`)
        .send({
          name: 'Valid Name',
          monthlyContributionPaisa: badAmount,
          dueDay: 5,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_group_settings');
    }

    // Empty or whitespace-only name
    const resEmptyName = await request(app)
      .post('/v1/groups')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'empty-name-key')
      .send({
        name: '   ',
        monthlyContributionPaisa: 50000,
        dueDay: 5,
      });

    expect(resEmptyName.status).toBe(400);
    expect(resEmptyName.body.error.code).toBe('invalid_group_settings');
  });

  it('GET /v1/groups/:id returns details to members; non-members & unknown groups get 404 group_not_found', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    const memberToken = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );

    // 1. Active member can view group
    const memberRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}`)
      .set('Authorization', `Bearer ${memberToken}`);

    expect(memberRes.status).toBe(200);
    expect(memberRes.body).toMatchObject({
      id: fixture.group.id,
      name: fixture.group.name,
      monthlyContributionPaisa: Number(fixture.group.expectedPaisa),
      dueDay: fixture.group.dueDay,
      memberCount: 5,
      createdAt: expect.any(String),
    });

    // 2. Non-member gets 404 group_not_found (prevents group enumeration)
    const outsiderToken = FakeTokenVerifier.createToken(
      'outsider-uid',
      'outsider@test.com',
      true,
    );
    await request(app)
      .post('/v1/session')
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send();

    const nonMemberRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}`)
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(nonMemberRes.status).toBe(404);
    expect(nonMemberRes.body.error.code).toBe('group_not_found');

    // 3. Unknown UUID gets 404 group_not_found
    const unknownRes = await request(app)
      .get('/v1/groups/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(unknownRes.status).toBe(404);
    expect(unknownRes.body.error.code).toBe('group_not_found');
  });

  it('PATCH /v1/groups/:id/settings: owner updates name/dueDay; non-owner gets 403; contribution update rejected', async () => {
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

    // 1. Non-owner gets 403 forbidden
    const nonOwnerRes = await request(app)
      .patch(`/v1/groups/${fixture.group.id}/settings`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ name: 'Hacked Name' });

    expect(nonOwnerRes.status).toBe(403);
    expect(nonOwnerRes.body.error.code).toBe('forbidden');

    // 2. Attempting to change monthlyContributionPaisa is rejected with 400 invalid_group_settings
    const immutabilityRes = await request(app)
      .patch(`/v1/groups/${fixture.group.id}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ monthlyContributionPaisa: 999999 });

    expect(immutabilityRes.status).toBe(400);
    expect(immutabilityRes.body.error.code).toBe('invalid_group_settings');

    // 3. Owner successfully updates name and dueDay
    const ownerRes = await request(app)
      .patch(`/v1/groups/${fixture.group.id}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Updated Group Name', dueDay: 20 });

    expect(ownerRes.status).toBe(200);
    expect(ownerRes.body).toMatchObject({
      id: fixture.group.id,
      name: 'Updated Group Name',
      dueDay: 20,
      monthlyContributionPaisa: Number(fixture.group.expectedPaisa),
      memberCount: 5,
    });
  });
});
