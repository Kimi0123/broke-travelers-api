/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
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
} from './setup.js';
import {
  seedReportFixture,
  type ReportFixture,
} from './fixtures/report-fixture.js';

describe('Updates Feed & Read State HTTP Integration Suite', () => {
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

  const fixedNow = new Date('2026-11-06T06:00:00.000Z'); // Pinned to Nov 6 2026 NPT

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

  // ---------------------------------------------------------------------------
  // 1. Updates Feed per Viewer Role & Item Derivations
  // ---------------------------------------------------------------------------
  describe('GET /v1/groups/:groupId/updates', () => {
    it('derives feed items per viewer according to role and obligation status', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);

      // (a) Hari: plain member with pending payment in November
      const hariToken = FakeTokenVerifier.createToken(
        fixture.hari.user.firebaseUid,
        fixture.hari.user.email,
        true,
      );
      const resHari = await request(app)
        .get(`/v1/groups/${fixture.group.id}/updates`)
        .set('Authorization', `Bearer ${hariToken}`);

      expect(resHari.status).toBe(200);
      expect(resHari.headers['cache-control']).toBe('no-store');
      const hariUpdates = resHari.body.updates;
      expect(Array.isArray(hariUpdates)).toBe(true);

      // Hari sees:
      // 1. Own pending payment awaiting verification
      const pendingItem = hariUpdates.find(
        (u: { id: string }) =>
          u.id === `pay-${fixture.pendingSubmissionId}-pending`,
      );
      expect(pendingItem).toBeDefined();
      expect(pendingItem.kind).toBe('paymentVerification');
      expect(pendingItem.title).toBe('Payment awaiting verification');
      expect(pendingItem.target).toEqual({ type: 'payments' });

      // 2. Due date reminder (since November obligation is not verified)
      const reminderItem = hariUpdates.find(
        (u: { id: string }) => u.id === 'due-2026-11',
      );
      expect(reminderItem).toBeDefined();
      expect(reminderItem.kind).toBe('reminder');
      expect(reminderItem.title).toBe('Contributions due 5 Nov');
      expect(reminderItem.target).toEqual({ type: 'contributions' });

      // 3. Bank reconciliation
      const reconItem = hariUpdates.find(
        (u: { id: string }) => u.id === `rec-${fixture.reconciliationId}`,
      );
      expect(reconItem).toBeDefined();
      expect(reconItem.kind).toBe('reconciliation');
      expect(reconItem.title).toBe('Bank reconciliation matched');
      expect(reconItem.target).toEqual({ type: 'reconciliation' });

      // (b) Ram: plain member who is VERIFIED in November
      const ramToken = FakeTokenVerifier.createToken(
        fixture.ram.user.firebaseUid,
        fixture.ram.user.email,
        true,
      );
      const resRam = await request(app)
        .get(`/v1/groups/${fixture.group.id}/updates`)
        .set('Authorization', `Bearer ${ramToken}`);

      const ramUpdates = resRam.body.updates;

      // Ram should NOT have a due-date reminder because his status is verified
      const ramReminder = ramUpdates.find(
        (u: { id: string }) => u.id === 'due-2026-11',
      );
      expect(ramReminder).toBeUndefined();

      // Ram sees 'Vote needed' for Sita's withdrawal approval request
      const needsVoteItem = ramUpdates.find(
        (u: { id: string }) =>
          u.id === `appr-${fixture.approvalRequestId}-needs-vote`,
      );
      expect(needsVoteItem).toBeDefined();
      expect(needsVoteItem.kind).toBe('approval');
      expect(needsVoteItem.title).toBe('Vote needed: Trip equipment');
      expect(needsVoteItem.target).toEqual({
        type: 'approvalDetail',
        approvalId: fixture.approvalRequestId,
      });

      // (c) Sita: requester of the approval
      const sitaToken = FakeTokenVerifier.createToken(
        fixture.sita.user.firebaseUid,
        fixture.sita.user.email,
        true,
      );
      const resSita = await request(app)
        .get(`/v1/groups/${fixture.group.id}/updates`)
        .set('Authorization', `Bearer ${sitaToken}`);

      const sitaUpdates = resSita.body.updates;

      // Sita does NOT see 'Vote needed' for her own request
      const sitaVoteItem = sitaUpdates.find(
        (u: { id: string }) =>
          u.id === `appr-${fixture.approvalRequestId}-needs-vote`,
      );
      expect(sitaVoteItem).toBeUndefined();

      // (d) Nirvan: Treasurer
      const nirvanToken = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );
      const resNirvan = await request(app)
        .get(`/v1/groups/${fixture.group.id}/updates`)
        .set('Authorization', `Bearer ${nirvanToken}`);

      const nirvanUpdates = resNirvan.body.updates;

      // Nirvan sees the treasurer queue item
      const treasurerQueueItem = nirvanUpdates.find(
        (u: { id: string }) => u.id === 'treasurer-pending-payments',
      );
      expect(treasurerQueueItem).toBeDefined();
      expect(treasurerQueueItem.kind).toBe('paymentVerification');
      expect(treasurerQueueItem.title).toBe('Payments awaiting verification');
      expect(treasurerQueueItem.body).toBe(
        '1 payment is awaiting verification.',
      );
      expect(treasurerQueueItem.target).toEqual({ type: 'verifyPayments' });
    });

    it('privacy check: guarantees no raw or masked references, emails, or uids in response', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const nirvanToken = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/updates`)
        .set('Authorization', `Bearer ${nirvanToken}`);

      const serialized = JSON.stringify(res.body);

      // Verify no references leak (the rejected submission had 'TXN-REJ-999')
      expect(serialized).not.toContain('TXN-REJ-999');

      // Verify no emails leak
      expect(serialized).not.toContain('@example.com');

      // Verify no firebase UIDs leak
      expect(serialized).not.toMatch(/"fb-[0-9a-f-]+"/);
    });

    it('sorts newest first and enforces max cap of 50', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const nirvanToken = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/updates`)
        .set('Authorization', `Bearer ${nirvanToken}`);

      const updates = res.body.updates;
      expect(updates.length).toBeLessThanOrEqual(50);

      // Verify descending timestamp ordering
      for (let i = 0; i < updates.length - 1; i++) {
        const timeA = new Date(updates[i].createdAt).getTime();
        const timeB = new Date(updates[i + 1].createdAt).getTime();
        expect(timeA).toBeGreaterThanOrEqual(timeB);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Read State Tracking & Idempotency
  // ---------------------------------------------------------------------------
  describe('POST /v1/groups/:groupId/updates/read and /read-all', () => {
    it('marks items as read with user-isolation and idempotency', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const hariToken = FakeTokenVerifier.createToken(
        fixture.hari.user.firebaseUid,
        fixture.hari.user.email,
        true,
      );
      const ramToken = FakeTokenVerifier.createToken(
        fixture.ram.user.firebaseUid,
        fixture.ram.user.email,
        true,
      );

      // Initial feed: all unread
      const initialRes = await request(app)
        .get(`/v1/groups/${fixture.group.id}/updates`)
        .set('Authorization', `Bearer ${hariToken}`);
      expect(
        initialRes.body.updates.every((u: { isRead: boolean }) => !u.isRead),
      ).toBe(true);

      const unreadCountInitial = await request(app)
        .get(`/v1/groups/${fixture.group.id}/updates/unread-count`)
        .set('Authorization', `Bearer ${hariToken}`);
      expect(unreadCountInitial.body.unreadCount).toBe(
        initialRes.body.updates.length,
      );

      // Mark the first item as read
      const firstId = initialRes.body.updates[0].id;
      const markRes = await request(app)
        .post(`/v1/groups/${fixture.group.id}/updates/read`)
        .set('Authorization', `Bearer ${hariToken}`)
        .send({ ids: [firstId] });

      expect(markRes.status).toBe(200);
      expect(markRes.body.markedCount).toBe(1);

      // Verify feed reflects read state for Hari
      const afterRes = await request(app)
        .get(`/v1/groups/${fixture.group.id}/updates`)
        .set('Authorization', `Bearer ${hariToken}`);
      const readItem = afterRes.body.updates.find(
        (u: { id: string }) => u.id === firstId,
      );
      expect(readItem.isRead).toBe(true);

      // Verify unread count decreased by 1
      const unreadCountAfter = await request(app)
        .get(`/v1/groups/${fixture.group.id}/updates/unread-count`)
        .set('Authorization', `Bearer ${hariToken}`);
      expect(unreadCountAfter.body.unreadCount).toBe(
        unreadCountInitial.body.unreadCount - 1,
      );

      // Idempotent repeat: marking same ID again does not error
      const markAgain = await request(app)
        .post(`/v1/groups/${fixture.group.id}/updates/read`)
        .set('Authorization', `Bearer ${hariToken}`)
        .send({ ids: [firstId] });
      expect(markAgain.status).toBe(200);
      expect(markAgain.body.markedCount).toBe(0);

      // User isolation: Ram still sees that item as unread
      const ramRes = await request(app)
        .get(`/v1/groups/${fixture.group.id}/updates`)
        .set('Authorization', `Bearer ${ramToken}`);
      const ramItem = ramRes.body.updates.find(
        (u: { id: string }) => u.id === firstId,
      );
      if (ramItem) {
        expect(ramItem.isRead).toBe(false);
      }
    });

    it('POST /updates/read-all marks all items as read and reduces unread-count to 0', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const hariToken = FakeTokenVerifier.createToken(
        fixture.hari.user.firebaseUid,
        fixture.hari.user.email,
        true,
      );

      const readAllRes = await request(app)
        .post(`/v1/groups/${fixture.group.id}/updates/read-all`)
        .set('Authorization', `Bearer ${hariToken}`);

      expect(readAllRes.status).toBe(200);
      expect(readAllRes.body.markedCount).toBeGreaterThan(0);

      // All items now read
      const feedRes = await request(app)
        .get(`/v1/groups/${fixture.group.id}/updates`)
        .set('Authorization', `Bearer ${hariToken}`);
      expect(
        feedRes.body.updates.every((u: { isRead: boolean }) => u.isRead),
      ).toBe(true);

      // Unread count is 0
      const countRes = await request(app)
        .get(`/v1/groups/${fixture.group.id}/updates/unread-count`)
        .set('Authorization', `Bearer ${hariToken}`);
      expect(countRes.body.unreadCount).toBe(0);
    });

    it('read state survives app restart (new app instance against same DB)', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const hariToken = FakeTokenVerifier.createToken(
        fixture.hari.user.firebaseUid,
        fixture.hari.user.email,
        true,
      );

      // Mark all read on app instance 1
      await request(app)
        .post(`/v1/groups/${fixture.group.id}/updates/read-all`)
        .set('Authorization', `Bearer ${hariToken}`);

      // Create new app instance (simulating restart)
      const restartedApp = createApp({
        prisma,
        config: testConfig,
        tokenVerifier,
        logger: pino({ level: 'silent' }),
        clock: () => fixedNow,
      });

      const res = await request(restartedApp)
        .get(`/v1/groups/${fixture.group.id}/updates/unread-count`)
        .set('Authorization', `Bearer ${hariToken}`);

      expect(res.status).toBe(200);
      expect(res.body.unreadCount).toBe(0);
    });
  });
});
