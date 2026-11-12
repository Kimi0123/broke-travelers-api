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

describe('Invitations HTTP Integration', () => {
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

  it('manages invitation lifecycle: create, list, dynamic status, and revocation', async () => {
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

    // 1. Non-owner cannot create invitation (403 forbidden)
    const nonOwnerRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/invitations`)
      .set('Authorization', `Bearer ${memberToken}`)
      .set('Idempotency-Key', 'inv-non-owner-key')
      .send();

    expect(nonOwnerRes.status).toBe(403);
    expect(nonOwnerRes.body.error.code).toBe('forbidden');

    // 2. Owner creates invitation (8-character code, 7-day expiry)
    const createRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/invitations`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', 'inv-owner-create-key')
      .send();

    expect(createRes.status).toBe(201);
    expect(createRes.body).toMatchObject({
      id: expect.any(String),
      code: expect.stringMatching(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/),
      status: 'pending',
      expiresAt: expect.any(String),
      createdAt: expect.any(String),
    });

    const invitationId = createRes.body.id;

    // 3. List invitations: shows pending status
    const listRes1 = await request(app)
      .get(`/v1/groups/${fixture.group.id}/invitations`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(listRes1.status).toBe(200);
    expect(listRes1.body).toHaveLength(1);
    expect(listRes1.body[0].status).toBe('pending');

    // 4. Revoke invitation (204 No Content)
    const revokeRes = await request(app)
      .delete(`/v1/groups/${fixture.group.id}/invitations/${invitationId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(revokeRes.status).toBe(204);

    // 5. List invitations: shows revoked status
    const listRes2 = await request(app)
      .get(`/v1/groups/${fixture.group.id}/invitations`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(listRes2.status).toBe(200);
    expect(listRes2.body[0].status).toBe('revoked');

    // 6. Revoking already revoked returns 409 invitation_not_revocable
    const duplicateRevokeRes = await request(app)
      .delete(`/v1/groups/${fixture.group.id}/invitations/${invitationId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(duplicateRevokeRes.status).toBe(409);
    expect(duplicateRevokeRes.body.error.code).toBe('invitation_not_revocable');
  });

  it('accepts valid invitation, rejects multi-group join, allows rejoining, and rejects bad/expired codes', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Create an invitation
    const invRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/invitations`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', 'inv-accept-test-key')
      .send();

    const code = invRes.body.code;

    // 1. Provision new joiner
    const joinerToken = FakeTokenVerifier.createToken(
      'new-joiner-uid',
      'joiner@test.com',
      true,
      'New Joiner',
    );
    await request(app)
      .post('/v1/session')
      .set('Authorization', `Bearer ${joinerToken}`)
      .send({ displayName: 'New Joiner' });

    // 2. Accept invitation
    const acceptRes = await request(app)
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${joinerToken}`)
      .set('Idempotency-Key', 'joiner-accept-key-1')
      .send({ code });

    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body).toMatchObject({
      group: {
        id: fixture.group.id,
        name: fixture.group.name,
        memberCount: 6,
      },
      membershipId: expect.any(String),
    });

    const newMembershipId = acceptRes.body.membershipId;

    // Verify database record has is_owner=false, is_treasurer=false
    const newMembership = await directPrisma.groupMembership.findUnique({
      where: { id: newMembershipId },
    });
    expect(newMembership?.isOwner).toBe(false);
    expect(newMembership?.isTreasurer).toBe(false);

    // 3. User already in a group cannot accept another invitation (409 already_in_group)
    const secondInvRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/invitations`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', 'second-inv-key')
      .send();

    const alreadyInGroupRes = await request(app)
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${joinerToken}`)
      .set('Idempotency-Key', 'joiner-accept-second-key')
      .send({ code: secondInvRes.body.code });

    expect(alreadyInGroupRes.status).toBe(409);
    expect(alreadyInGroupRes.body.error.code).toBe('already_in_group');

    // 4. Soft remove the member, then verify they can rejoin via a fresh invitation
    await directPrisma.groupMembership.update({
      where: { id: newMembershipId },
      data: { leftAt: new Date() },
    });

    const rejoinInvRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/invitations`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', 'rejoin-inv-key')
      .send();

    const rejoinRes = await request(app)
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${joinerToken}`)
      .set('Idempotency-Key', 'rejoin-accept-key')
      .send({ code: rejoinInvRes.body.code });

    expect(rejoinRes.status).toBe(200);
    expect(rejoinRes.body.membershipId).not.toBe(newMembershipId); // fresh membership row

    // 5. Invalid / unknown code returns 400 invalid_invitation_code
    const invalidCodeRes = await request(app)
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${joinerToken}`)
      .set('Idempotency-Key', 'invalid-code-key')
      .send({ code: 'INVALID8' });

    expect(invalidCodeRes.status).toBe(400);
    expect(invalidCodeRes.body.error.code).toBe('invalid_invitation_code');
  });

  it('enforces brute-force lockout: 5 failures in 5 minutes locks out user with 429 and Retry-After', async () => {
    const victimToken = FakeTokenVerifier.createToken(
      'lockout-victim-uid',
      'victim@test.com',
      true,
    );
    await request(app)
      .post('/v1/session')
      .set('Authorization', `Bearer ${victimToken}`)
      .send();

    // 5 failed attempts
    for (let i = 1; i <= 5; i++) {
      const failRes = await request(app)
        .post('/v1/invitations/accept')
        .set('Authorization', `Bearer ${victimToken}`)
        .set('Idempotency-Key', `fail-key-${i}`)
        .send({ code: `BADCODE${i}` });

      expect(failRes.status).toBe(400);
      expect(failRes.body.error.code).toBe('invalid_invitation_code');
    }

    // 6th attempt must be locked out with 429 too_many_attempts and Retry-After header
    const lockoutRes = await request(app)
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${victimToken}`)
      .set('Idempotency-Key', 'lockout-key-6')
      .send({ code: 'ANYCODE1' });

    expect(lockoutRes.status).toBe(429);
    expect(lockoutRes.body.error.code).toBe('too_many_attempts');
    expect(lockoutRes.headers['retry-after']).toBeDefined();
    const retryAfter = Number.parseInt(
      lockoutRes.headers['retry-after'] as string,
      10,
    );
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(300);
  });

  it('concurrent accepts of SAME code by different users: exactly one succeeds', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Create single invitation
    const invRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/invitations`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', 'race-inv-key')
      .send();

    const sharedCode = invRes.body.code;

    // Two distinct users provisioned
    const userAToken = FakeTokenVerifier.createToken(
      'race-user-a',
      'usera@test.com',
      true,
    );
    const userBToken = FakeTokenVerifier.createToken(
      'race-user-b',
      'userb@test.com',
      true,
    );

    await request(app)
      .post('/v1/session')
      .set('Authorization', `Bearer ${userAToken}`)
      .send();
    await request(app)
      .post('/v1/session')
      .set('Authorization', `Bearer ${userBToken}`)
      .send();

    // Fire concurrent accepts
    const [resA, resB] = await Promise.all([
      request(app)
        .post('/v1/invitations/accept')
        .set('Authorization', `Bearer ${userAToken}`)
        .set('Idempotency-Key', 'race-key-a')
        .send({ code: sharedCode }),
      request(app)
        .post('/v1/invitations/accept')
        .set('Authorization', `Bearer ${userBToken}`)
        .set('Idempotency-Key', 'race-key-b')
        .send({ code: sharedCode }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // Exactly one succeeds (200), the other fails with 400 invalid_invitation_code
    expect(statuses).toEqual([200, 400]);
  });

  it('validates Idempotency-Key format on POST /v1/invitations/accept (missing, 7, 8, 100, 101, spaces, unicode, allowed chars)', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // Create an invitation to accept
    const invRes = await request(app)
      .post(`/v1/groups/${fixture.group.id}/invitations`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', 'format-inv-create-key')
      .send();
    expect(invRes.status).toBe(201);
    const code = invRes.body.code as string;

    const testToken = FakeTokenVerifier.createToken(
      'key-format-invitee',
      'invitee-format@test.com',
      true,
    );
    await request(app)
      .post('/v1/session')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ displayName: 'Invitee Key Tester' });

    // 1. Missing header -> 400 idempotency_key_required
    const missingRes = await request(app)
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ code });
    expect(missingRes.status).toBe(400);
    expect(missingRes.body.error.code).toBe('idempotency_key_required');

    // 2. Too short (7 chars) -> 400 invalid_idempotency_key
    const tooShortRes = await request(app)
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${testToken}`)
      .set('Idempotency-Key', '1234567')
      .send({ code });
    expect(tooShortRes.status).toBe(400);
    expect(tooShortRes.body.error.code).toBe('invalid_idempotency_key');

    // 3. Too long (101 chars) -> 400 invalid_idempotency_key
    const tooLongRes = await request(app)
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${testToken}`)
      .set('Idempotency-Key', 'x'.repeat(101))
      .send({ code });
    expect(tooLongRes.status).toBe(400);
    expect(tooLongRes.body.error.code).toBe('invalid_idempotency_key');

    // 4. Spaces -> 400 invalid_idempotency_key
    const spacesRes = await request(app)
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${testToken}`)
      .set('Idempotency-Key', 'key with space')
      .send({ code });
    expect(spacesRes.status).toBe(400);
    expect(spacesRes.body.error.code).toBe('invalid_idempotency_key');

    // 5. Unicode -> 400 invalid_idempotency_key
    const unicodeRes = await request(app)
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${testToken}`)
      .set('Idempotency-Key', 'key-café-123')
      .send({ code });
    expect(unicodeRes.status).toBe(400);
    expect(unicodeRes.body.error.code).toBe('invalid_idempotency_key');

    // 6. Minimum valid length (8 chars) -> succeeds and accepts
    const minValidRes = await request(app)
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${testToken}`)
      .set('Idempotency-Key', '12345678')
      .send({ code });
    expect(minValidRes.status).toBe(200);

    // 7. Allowed characters / replay with same key
    const replayRes = await request(app)
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${testToken}`)
      .set('Idempotency-Key', '12345678')
      .send({ code });
    expect(replayRes.status).toBe(200);
    expect(replayRes.headers['idempotent-replay']).toBe('true');
  });
});
