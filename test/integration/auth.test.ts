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

describe('Auth & Session HTTP Integration', () => {
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

  it('rejects unauthenticated requests with 401 unauthenticated envelope', async () => {
    // 1. Missing header
    const res1 = await request(app).get('/v1/profile');
    expect(res1.status).toBe(401);
    expect(res1.body.error).toMatchObject({
      code: 'unauthenticated',
      message: 'Authentication required',
      requestId: expect.any(String),
    });

    // 2. Malformed header
    const res2 = await request(app)
      .get('/v1/profile')
      .set('Authorization', 'NotBearer xyz');
    expect(res2.status).toBe(401);
    expect(res2.body.error.code).toBe('unauthenticated');

    // 3. Invalid token
    const res3 = await request(app)
      .get('/v1/profile')
      .set('Authorization', 'Bearer invalid');
    expect(res3.status).toBe(401);
    expect(res3.body.error.code).toBe('unauthenticated');
  });

  it('rejects unprovisioned users on GET /v1/profile with 401 user_not_provisioned', async () => {
    const token = FakeTokenVerifier.createToken(
      'unprovisioned-uid',
      'u@test.com',
      true,
    );

    const res = await request(app)
      .get('/v1/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({
      code: 'user_not_provisioned',
      message:
        'User profile has not been provisioned. Please call POST /v1/session first.',
      requestId: expect.any(String),
    });
  });

  it('rejects unverified email when REQUIRE_VERIFIED_EMAIL is true with 403 email_not_verified', async () => {
    const token = FakeTokenVerifier.createToken(
      'unverified-uid',
      'unverified@test.com',
      false,
    );

    const res = await request(app)
      .post('/v1/session')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'Unverified User' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'email_not_verified',
      message:
        'Please verify your email address before joining or creating a group',
      requestId: expect.any(String),
    });
  });

  it('provisions user via POST /v1/session, idempotently updates displayName and returns groups', async () => {
    const token = FakeTokenVerifier.createToken(
      'session-uid-01',
      'session01@test.com',
      true,
      'Original Name',
    );

    // 1. Initial provision
    const res1 = await request(app)
      .post('/v1/session')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'Custom Display Name' });

    expect(res1.status).toBe(200);
    expect(res1.body).toMatchObject({
      user: {
        id: expect.any(String),
        name: 'Custom Display Name',
        email: 'session01@test.com',
      },
      groups: [],
    });

    const userId = res1.body.user.id;

    // 2. Re-call with updated displayName
    const res2 = await request(app)
      .post('/v1/session')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'Updated Display Name' });

    expect(res2.status).toBe(200);
    expect(res2.body.user).toEqual({
      id: userId,
      name: 'Updated Display Name',
      email: 'session01@test.com',
    });
  });

  it('GET /v1/profile returns user profile and active groups, excluding left groups', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
      'Aarav Owner',
    );

    // Call profile
    const res1 = await request(app)
      .get('/v1/profile')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res1.status).toBe(200);
    expect(res1.body).toMatchObject({
      user: {
        id: fixture.owner.user.id,
        name: 'Aarav Owner',
        email: fixture.owner.user.email,
      },
      groups: [
        {
          id: fixture.group.id,
          name: fixture.group.name,
          role: 'owner',
          isTreasurer: true,
          monthlyContributionPaisa: Number(fixture.group.expectedPaisa),
          dueDay: fixture.group.dueDay,
          memberCount: 5,
          joinedAt: expect.stringMatching(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
          ),
        },
      ],
    });

    // Exact-key assertion for the new fields on the group object
    expect(res1.body.groups[0]).toEqual({
      id: fixture.group.id,
      name: fixture.group.name,
      role: 'owner',
      isTreasurer: true,
      monthlyContributionPaisa: Number(fixture.group.expectedPaisa),
      dueDay: fixture.group.dueDay,
      memberCount: 5,
      joinedAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
    });

    // Soft-remove member1 and verify their profile shows no active groups
    await directPrisma.groupMembership.update({
      where: { id: fixture.member1.membership.id },
      data: { leftAt: new Date() },
    });

    const member1Token = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );

    const res2 = await request(app)
      .get('/v1/profile')
      .set('Authorization', `Bearer ${member1Token}`);

    expect(res2.status).toBe(200);
    expect(res2.body.groups).toEqual([]);
  });

  it('GET /v1/profile memberCount excludes soft-removed members', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
      'Aarav Owner',
    );

    const beforeRes = await request(app)
      .get('/v1/profile')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(beforeRes.status).toBe(200);
    expect(beforeRes.body.groups[0].memberCount).toBe(5);

    // Soft-remove member1
    await directPrisma.groupMembership.update({
      where: { id: fixture.member1.membership.id },
      data: { leftAt: new Date() },
    });

    const afterRes = await request(app)
      .get('/v1/profile')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(afterRes.status).toBe(200);
    expect(afterRes.body.groups[0].memberCount).toBe(4);
  });

  it("GET /v1/profile returns groups [] for a removed member's own profile", async () => {
    const fixture = await seedStandardGroup(directPrisma);

    await directPrisma.groupMembership.update({
      where: { id: fixture.member1.membership.id },
      data: { leftAt: new Date() },
    });

    const member1Token = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
      'Member One',
    );

    const res = await request(app)
      .get('/v1/profile')
      .set('Authorization', `Bearer ${member1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
  });

  it('GET /v1/profile returns monthlyContributionPaisa, dueDay, and memberCount as JSON integers, not strings', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
      'Aarav Owner',
    );

    const res = await request(app)
      .get('/v1/profile')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const group = res.body.groups[0];

    expect(typeof group.monthlyContributionPaisa).toBe('number');
    expect(Number.isInteger(group.monthlyContributionPaisa)).toBe(true);
    expect(typeof group.dueDay).toBe('number');
    expect(Number.isInteger(group.dueDay)).toBe(true);
    expect(typeof group.memberCount).toBe('number');
    expect(Number.isInteger(group.memberCount)).toBe(true);

    expect(typeof (group.monthlyContributionPaisa as unknown)).not.toBe(
      'string',
    );
    expect(typeof (group.dueDay as unknown)).not.toBe('string');
    expect(typeof (group.memberCount as unknown)).not.toBe('string');
  });

  it('GET /v1/profile has full parity with GET /v1/groups/:groupId for financial and roster numbers', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
      'Aarav Owner',
    );

    const [profileRes, groupRes] = await Promise.all([
      request(app)
        .get('/v1/profile')
        .set('Authorization', `Bearer ${ownerToken}`),
      request(app)
        .get(`/v1/groups/${fixture.group.id}`)
        .set('Authorization', `Bearer ${ownerToken}`),
    ]);

    expect(profileRes.status).toBe(200);
    expect(groupRes.status).toBe(200);

    const profileGroup = profileRes.body.groups[0];
    const groupDetails = groupRes.body;

    expect(profileGroup.id).toBe(groupDetails.id);
    expect(profileGroup.name).toBe(groupDetails.name);
    expect(profileGroup.monthlyContributionPaisa).toBe(
      groupDetails.monthlyContributionPaisa,
    );
    expect(profileGroup.dueDay).toBe(groupDetails.dueDay);
    expect(profileGroup.memberCount).toBe(groupDetails.memberCount);
  });
});
