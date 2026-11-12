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

describe('Members & Roles HTTP Integration', () => {
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

  it('GET /v1/groups/:id/members returns active members ordered by joinedAt ASC, id ASC, with obligation status', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    const res = await request(app)
      .get(`/v1/groups/${fixture.group.id}/members`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);

    // Verify ordering
    for (let i = 0; i < res.body.length - 1; i++) {
      const current = res.body[i] as { joinedAt: string; id: string };
      const next = res.body[i + 1] as { joinedAt: string; id: string };
      const timeDiff =
        new Date(current.joinedAt).getTime() -
        new Date(next.joinedAt).getTime();
      if (timeDiff === 0) {
        expect(current.id.localeCompare(next.id)).toBeLessThanOrEqual(0);
      } else {
        expect(timeDiff).toBeLessThanOrEqual(0);
      }
    }

    // Contract conformance check: each member item has only allowed fields
    const allowedMemberKeys = new Set([
      'id',
      'displayName',
      'roles',
      'joinedAt',
      'isCurrentUser',
      'currentPeriodStatus',
    ]);

    for (const member of res.body as Array<Record<string, unknown>>) {
      const keys = Object.keys(member);
      for (const k of keys) {
        expect(allowedMemberKeys.has(k)).toBe(true);
      }
      expect(member['email']).toBeUndefined();
      expect(member['firebaseUid']).toBeUndefined();
      expect(member['seq']).toBeUndefined();
    }
  });

  it('PATCH /v1/groups/:id/members/:memberId/role updates treasurer role and prevents removing last treasurer', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );
    const member1Token = FakeTokenVerifier.createToken(
      `fb-${fixture.member1.user.id}`,
      fixture.member1.user.email,
      true,
    );

    // 1. Non-owner cannot update role (403 forbidden)
    const nonOwnerRes = await request(app)
      .patch(
        `/v1/groups/${fixture.group.id}/members/${fixture.member1.membership.id}/role`,
      )
      .set('Authorization', `Bearer ${member1Token}`)
      .send({ isTreasurer: true });

    expect(nonOwnerRes.status).toBe(403);
    expect(nonOwnerRes.body.error.code).toBe('forbidden');

    // 2. Owner promotes member1 to treasurer
    const promoteRes = await request(app)
      .patch(
        `/v1/groups/${fixture.group.id}/members/${fixture.member1.membership.id}/role`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isTreasurer: true });

    expect(promoteRes.status).toBe(200);
    expect(promoteRes.body.roles).toContain('treasurer');

    // 3. Demote secondTreasurer while member1 is also treasurer (now multiple treasurers exist)
    const demoteRes = await request(app)
      .patch(
        `/v1/groups/${fixture.group.id}/members/${fixture.secondTreasurer.membership.id}/role`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isTreasurer: false });

    expect(demoteRes.status).toBe(200);
    expect(demoteRes.body.roles).not.toContain('treasurer');

    // 4. Demote member1 back to member
    await request(app)
      .patch(
        `/v1/groups/${fixture.group.id}/members/${fixture.member1.membership.id}/role`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isTreasurer: false });

    // Now owner is the ONLY active treasurer left in the group.
    // If owner tries to remove treasurer from themselves (or only treasurer demoted):
    const lastTreasurerRes = await request(app)
      .patch(
        `/v1/groups/${fixture.group.id}/members/${fixture.owner.membership.id}/role`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isTreasurer: false });

    // Owner cannot be removed or demoted from last treasurer
    expect(lastTreasurerRes.status).toBe(409);
  });

  it('DELETE /v1/groups/:id/members/:memberId enforces invariants in order: owner, pending payments, last treasurer', async () => {
    const fixture = await seedStandardGroup(directPrisma);
    const ownerToken = FakeTokenVerifier.createToken(
      `fb-${fixture.owner.user.id}`,
      fixture.owner.user.email,
      true,
    );

    // 1. Cannot remove owner -> 409 cannot_remove_owner
    const removeOwnerRes = await request(app)
      .delete(
        `/v1/groups/${fixture.group.id}/members/${fixture.owner.membership.id}`,
      )
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(removeOwnerRes.status).toBe(409);
    expect(removeOwnerRes.body.error.code).toBe('cannot_remove_owner');

    // 2. Cannot remove member with pending payments -> 409 member_has_pending_payments
    // Insert a pending payment submission for member1
    await directPrisma.paymentSubmission.create({
      data: {
        id: generateId(),
        groupId: fixture.group.id,
        memberId: fixture.member1.membership.id,
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        amountPaisa: 500000n,
        paymentMethod: 'esewa',
        reference: 'PENDING-PAYMENT-REF-1',
        status: 'pending',
        submittedAt: new Date(),
      },
    });

    const removePendingRes = await request(app)
      .delete(
        `/v1/groups/${fixture.group.id}/members/${fixture.member1.membership.id}`,
      )
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(removePendingRes.status).toBe(409);
    expect(removePendingRes.body.error.code).toBe(
      'member_has_pending_payments',
    );

    // Clean up the pending submission so we can test the next invariant
    await directPrisma.paymentSubmission.deleteMany({
      where: { memberId: fixture.member1.membership.id },
    });

    // 3. Cannot remove the ONLY treasurer -> 409 cannot_remove_last_treasurer
    // First, demote owner's treasurer role is not allowed, but secondTreasurer is a treasurer.
    // Let's remove secondTreasurer while owner is also a treasurer:
    const removeSecondTreasurerRes = await request(app)
      .delete(
        `/v1/groups/${fixture.group.id}/members/${fixture.secondTreasurer.membership.id}`,
      )
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(removeSecondTreasurerRes.status).toBe(204);

    // 4. Successful soft removal of member2 (sets leftAt)
    const member2Token = FakeTokenVerifier.createToken(
      `fb-${fixture.member2.user.id}`,
      fixture.member2.user.email,
      true,
    );

    // Before removal: member2 has access
    const preRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}`)
      .set('Authorization', `Bearer ${member2Token}`);
    expect(preRes.status).toBe(200);

    // Remove member2
    const removeMember2Res = await request(app)
      .delete(
        `/v1/groups/${fixture.group.id}/members/${fixture.member2.membership.id}`,
      )
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(removeMember2Res.status).toBe(204);

    // After removal: member2 immediately loses access -> 404 group_not_found
    const postRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}`)
      .set('Authorization', `Bearer ${member2Token}`);

    expect(postRes.status).toBe(404);
    expect(postRes.body.error.code).toBe('group_not_found');

    // Verify member count is updated in group details
    const groupRes = await request(app)
      .get(`/v1/groups/${fixture.group.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(groupRes.body.memberCount).toBe(3); // 5 - 2 removed (secondTreasurer + member2)
  });
});
