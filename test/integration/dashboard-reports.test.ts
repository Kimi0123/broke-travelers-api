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
} from './setup.js';
import {
  seedReportFixture,
  type ReportFixture,
} from './fixtures/report-fixture.js';

describe('Dashboard & Reports HTTP Integration Suite', () => {
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
  // 1. Dashboard Summary
  // ---------------------------------------------------------------------------
  describe('GET /v1/groups/:groupId/dashboard', () => {
    it('returns complete dashboard metrics matching the Dart mock_dashboard_repository numbers', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);

      // Nirvan is Owner + Treasurer
      const nirvanToken = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/dashboard`)
        .set('Authorization', `Bearer ${nirvanToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');

      const body = res.body;

      // Group identity & dates (mirrors Dart mock_dashboard_repository_test line 31-33)
      expect(body.groupName).toBe('Himalayan Crew');
      expect(body.periodStart).toBe('2026-11-01');
      expect(body.dueDate).toBe('2026-11-05');

      // Financial metrics (mirrors Dart mock_dashboard_repository_test line 36-53)
      // Verified balance: NPR 7,300 = 730,000 paisa
      expect(body.verifiedBalancePaisa).toBe(730000);
      // Pending amount strictly excluded from verified balance: Hari NPR 700 = 70,000 paisa
      expect(body.pendingAmountPaisa).toBe(70000);
      // Monthly target: 4 * 70,000 = 280,000 paisa (NPR 2,800)
      expect(body.monthlyTargetPaisa).toBe(280000);
      // Verified this period: 3 * 70,000 = 210,000 paisa (NPR 2,100)
      expect(body.verifiedThisPeriodPaisa).toBe(210000);
      // Remaining to target: 70,000 paisa (NPR 700)
      expect(body.remainingToTargetPaisa).toBe(70000);

      // Member counts (mirrors Dart mock_dashboard_repository_test line 56-57)
      expect(body.verifiedMemberCount).toBe(3);
      expect(body.totalMemberCount).toBe(4);

      // Members list
      expect(body.members).toHaveLength(4);
      const nirvanMember = body.members.find((m: { displayName: string }) =>
        m.displayName.includes('Nirvan'),
      );
      expect(nirvanMember).toBeDefined();
      expect(nirvanMember.displayName).toBe('Nirvan (you)');
      expect(nirvanMember.isCurrentUser).toBe(true);
      expect(nirvanMember.status).toBe('verified');
      expect(nirvanMember.expectedAmountPaisa).toBe(70000);

      const hariMember = body.members.find(
        (m: { displayName: string }) => m.displayName === 'Hari',
      );
      expect(hariMember.isCurrentUser).toBe(false);
      expect(hariMember.status).toBe('pendingVerification');

      // Recent Activity: 5 items descending (mirrors Dart mock_dashboard_repository_test line 77-122)
      expect(body.recentActivity).toHaveLength(5);
      expect(body.recentActivity[0].title).toBe("Hari's contribution");
      expect(body.recentActivity[0].status).toBe('pendingVerification');
      expect(body.recentActivity[0].amountPaisa).toBe(70000);
      expect(body.recentActivity[0].signedAmountPaisa).toBe(70000);

      expect(body.recentActivity[1].title).toBe("Ram's contribution");
      expect(body.recentActivity[1].status).toBe('verified');
      expect(body.recentActivity[1].amountPaisa).toBe(70000);

      expect(body.recentActivity[2].title).toBe("Sita's contribution");
      expect(body.recentActivity[2].status).toBe('verified');

      expect(body.recentActivity[3].title).toBe("Nirvan's contribution");
      expect(body.recentActivity[3].status).toBe('verified');

      expect(body.recentActivity[4].title).toBe('Group dinner');
      expect(body.recentActivity[4].status).toBe('verified');
      expect(body.recentActivity[4].amountPaisa).toBe(50000);
      expect(body.recentActivity[4].signedAmountPaisa).toBe(-50000);

      // Upcoming deadlines (mirrors Dart mock_dashboard_repository_test line 132-152)
      expect(body.upcomingDeadlines).toHaveLength(2);
      expect(body.upcomingDeadlines[0].title).toBe('November contributions');
      expect(body.upcomingDeadlines[0].dueDate).toBe('2026-11-05');
      expect(body.upcomingDeadlines[0].outstandingMemberCount).toBe(1);

      expect(body.upcomingDeadlines[1].title).toBe('December contributions');
      expect(body.upcomingDeadlines[1].dueDate).toBe('2026-12-05');
      expect(body.upcomingDeadlines[1].outstandingMemberCount).toBe(4);

      // Balance History points: Sep, Oct, Nov (mirrors Dart mock_dashboard_repository_test line 154-175)
      expect(body.balanceHistory).toHaveLength(3);
      expect(body.balanceHistory[0].month).toBe('2026-09');
      expect(body.balanceHistory[0].verifiedBalanceAtMonthEndPaisa).toBe(
        280000,
      );
      expect(body.balanceHistory[0].isCurrentMonth).toBe(false);

      expect(body.balanceHistory[1].month).toBe('2026-10');
      expect(body.balanceHistory[1].verifiedBalanceAtMonthEndPaisa).toBe(
        520000,
      );
      expect(body.balanceHistory[1].isCurrentMonth).toBe(false);

      expect(body.balanceHistory[2].month).toBe('2026-11');
      expect(body.balanceHistory[2].verifiedBalanceAtMonthEndPaisa).toBe(
        730000,
      );
      expect(body.balanceHistory[2].isCurrentMonth).toBe(true);

      // Approvals card counts: 1 open approval
      expect(body.openApprovalsCount).toBe(1);
      // Nirvan has already voted -> needsYourVote is false
      expect(body.needsYourVote).toBe(false);

      // Reconciliation card info
      expect(body.lastReconciledAt).toBe('2026-10-31');
      expect(body.lastReconciliationDifferencePaisa).toBe(0);
      expect(body.lastReconciliationStatus).toBe('matched');
    });

    it('enforces privacy: plain member sees pendingAmountPaisa as 0 when they have none pending', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);

      // Sita is a regular member with a verified payment and NO pending payments
      const sitaToken = FakeTokenVerifier.createToken(
        fixture.sita.user.firebaseUid,
        fixture.sita.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/dashboard`)
        .set('Authorization', `Bearer ${sitaToken}`);

      expect(res.status).toBe(200);
      // Plain member sees their own pending only (0), NOT Hari's pending 700
      expect(res.body.pendingAmountPaisa).toBe(0);
      // But verified balance is identical (730000)
      expect(res.body.verifiedBalancePaisa).toBe(730000);
    });

    it('evaluates needsYourVote correctly for eligible voters vs requester', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);

      // Ram is an eligible voter who has not yet voted -> needsYourVote is true
      const ramToken = FakeTokenVerifier.createToken(
        fixture.ram.user.firebaseUid,
        fixture.ram.user.email,
        true,
      );
      const resRam = await request(app)
        .get(`/v1/groups/${fixture.group.id}/dashboard`)
        .set('Authorization', `Bearer ${ramToken}`);
      expect(resRam.body.needsYourVote).toBe(true);

      // Sita is the requester -> not eligible to vote on own request -> needsYourVote is false
      const sitaToken = FakeTokenVerifier.createToken(
        fixture.sita.user.firebaseUid,
        fixture.sita.user.email,
        true,
      );
      const resSita = await request(app)
        .get(`/v1/groups/${fixture.group.id}/dashboard`)
        .set('Authorization', `Bearer ${sitaToken}`);
      expect(resSita.body.needsYourVote).toBe(false);
    });

    it('handles empty group with 0 balances and empty history', async () => {
      const ownerId = generateId();
      await directPrisma.user.create({
        data: {
          id: ownerId,
          firebaseUid: `fb-${ownerId}`,
          email: `empty-owner-${ownerId}@example.com`,
          displayName: 'Empty Owner',
        },
      });
      const emptyGroupId = generateId();
      await directPrisma.group.create({
        data: {
          id: emptyGroupId,
          name: 'Empty Group',
          expectedPaisa: 50000n,
          dueDay: 10,
          createdByUserId: ownerId,
        },
      });
      await directPrisma.groupMembership.create({
        data: {
          id: generateId(),
          groupId: emptyGroupId,
          userId: ownerId,
          isOwner: true,
          isTreasurer: true,
        },
      });

      const token = FakeTokenVerifier.createToken(
        `fb-${ownerId}`,
        `empty-owner-${ownerId}@example.com`,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${emptyGroupId}/dashboard`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.verifiedBalancePaisa).toBe(0);
      expect(res.body.pendingAmountPaisa).toBe(0);
      expect(res.body.recentActivity).toHaveLength(0);
      expect(res.body.balanceHistory).toHaveLength(0);
      expect(res.body.openApprovalsCount).toBe(0);
      expect(res.body.lastReconciledAt).toBeNull();
    });

    it('returns lastReconciliationStatus mismatch after recording a mismatch reconciliation', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);

      // Record a new reconciliation with bank balance 500000 (diff -20000)
      await directPrisma.bankReconciliation.create({
        data: {
          id: generateId(),
          groupId: fixture.group.id,
          statementDate: new Date('2026-11-05'),
          bankBalancePaisa: 710000n,
          recordedBalancePaisa: 730000n,
          differencePaisa: -20000n,
          recordedByMemberId: fixture.nirvan.membership.id,
          recordedAt: new Date('2026-11-06T02:00:00.000Z'),
        },
      });

      const nirvanToken = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/dashboard`)
        .set('Authorization', `Bearer ${nirvanToken}`);

      expect(res.status).toBe(200);
      expect(res.body.lastReconciledAt).toBe('2026-11-05');
      expect(res.body.lastReconciliationDifferencePaisa).toBe(-20000);
      expect(res.body.lastReconciliationStatus).toBe('mismatch');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Report Months Range Endpoint
  // ---------------------------------------------------------------------------
  describe('GET /v1/groups/:groupId/reports/months', () => {
    it('returns exact selectable months and years from group creation to current anchor month', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const token = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/reports/months`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.earliestMonth).toBe('2026-09');
      expect(res.body.anchorMonth).toBe('2026-11');
      expect(res.body.selectableMonths).toEqual([
        '2026-09',
        '2026-10',
        '2026-11',
      ]);
      expect(res.body.selectableYears).toEqual([2026]);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Monthly Report Endpoint
  // ---------------------------------------------------------------------------
  describe('GET /v1/groups/:groupId/reports/monthly', () => {
    it('reproduces Dart reports_e2e_test November 2026 numbers', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const token = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/reports/monthly?month=2026-11`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const b = res.body;
      expect(b.month).toBe('2026-11');
      // Opening balance: NPR 5,200 = 520000
      expect(b.openingPaisa).toBe(520000);
      // Contributions for period: Nirvan + Sita + Ram = 210000 (NPR 2,100)
      expect(b.contributionsPaisa).toBe(210000);
      expect(b.interestPaisa).toBe(0);
      expect(b.expensesPaisa).toBe(0);
      expect(b.withdrawalsPaisa).toBe(0);
      // Closing balance: NPR 7,300 = 730000
      expect(b.closingPaisa).toBe(730000);
      // Pending contribution: Hari NPR 700 = 70000 (excluded from verified balance)
      expect(b.pendingPaisa).toBe(70000);
      // Obligation counts: 3 of 4 verified
      expect(b.obligatedCount).toBe(4);
      expect(b.verifiedCount).toBe(3);
      expect(b.expectedTotalPaisa).toBe(280000);
      expect(b.outstandingPaisa).toBe(70000);
    });

    it('reproduces Dart reports_e2e_test October 2026 numbers (+NPR 100 interest, -NPR 500 expenses)', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const token = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/reports/monthly?month=2026-10`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const b = res.body;
      expect(b.month).toBe('2026-10');
      expect(b.openingPaisa).toBe(280000);
      expect(b.contributionsPaisa).toBe(280000);
      expect(b.interestPaisa).toBe(10000); // +NPR 100
      expect(b.expensesPaisa).toBe(50000); // -NPR 500 (group dinner, reversal netted)
      expect(b.withdrawalsPaisa).toBe(0);
      expect(b.closingPaisa).toBe(520000); // NPR 5,200
      expect(b.pendingPaisa).toBe(0);
      expect(b.obligatedCount).toBe(4);
      expect(b.verifiedCount).toBe(4);
      expect(b.expectedTotalPaisa).toBe(280000);
      expect(b.outstandingPaisa).toBe(0);
    });

    it('reproduces Dart reports_e2e_test September 2026 numbers', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const token = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/reports/monthly?month=2026-09`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.openingPaisa).toBe(0);
      expect(res.body.contributionsPaisa).toBe(280000);
      expect(res.body.closingPaisa).toBe(280000);
      expect(res.body.obligatedCount).toBe(4);
      expect(res.body.verifiedCount).toBe(4);
    });

    it('rejects months outside group history with report_range_invalid', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const token = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      // Prior to group creation (2026-08)
      const resBefore = await request(app)
        .get(`/v1/groups/${fixture.group.id}/reports/monthly?month=2026-08`)
        .set('Authorization', `Bearer ${token}`);
      expect(resBefore.status).toBe(400);
      expect(resBefore.body.error.code).toBe('report_range_invalid');

      // Future month beyond current anchor (2026-12)
      const resAfter = await request(app)
        .get(`/v1/groups/${fixture.group.id}/reports/monthly?month=2026-12`)
        .set('Authorization', `Bearer ${token}`);
      expect(resAfter.status).toBe(400);
      expect(resAfter.body.error.code).toBe('report_range_invalid');
    });

    it('rejects malformed month format with invalid_request', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const token = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const res = await request(app)
        .get(
          `/v1/groups/${fixture.group.id}/reports/monthly?month=invalid-month`,
        )
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Member-wise Report Endpoint & Role Privacy
  // ---------------------------------------------------------------------------
  describe('GET /v1/groups/:groupId/reports/members', () => {
    it('exposes Hari pending to treasurer/owner, and totals row equals sum of member rows', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const nirvanToken = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/reports/members?month=2026-11`)
        .set('Authorization', `Bearer ${nirvanToken}`);

      expect(res.status).toBe(200);
      const b = res.body;
      expect(b.month).toBe('2026-11');
      expect(b.rows).toHaveLength(4);

      // Verify Hari row
      const hariRow = b.rows.find(
        (r: { memberId: string }) => r.memberId === fixture.hari.membership.id,
      );
      expect(hariRow.name).toBe('Hari');
      expect(hariRow.status).toBe('pendingVerification');
      expect(hariRow.pendingPaisa).toBe(70000);
      expect(hariRow.verifiedPaisa).toBe(0);
      expect(hariRow.outstandingPaisa).toBe(70000);

      // Sum of member rows equals totals row
      const sumExpected = b.rows.reduce(
        (acc: number, r: { expectedPaisa: number }) => acc + r.expectedPaisa,
        0,
      );
      const sumVerified = b.rows.reduce(
        (acc: number, r: { verifiedPaisa: number }) => acc + r.verifiedPaisa,
        0,
      );
      const sumPending = b.rows.reduce(
        (acc: number, r: { pendingPaisa: number }) => acc + r.pendingPaisa,
        0,
      );
      const sumOutstanding = b.rows.reduce(
        (acc: number, r: { outstandingPaisa: number }) =>
          acc + r.outstandingPaisa,
        0,
      );

      expect(b.expectedTotalPaisa).toBe(sumExpected);
      expect(b.verifiedTotalPaisa).toBe(sumVerified);
      expect(b.pendingTotalPaisa).toBe(sumPending);
      expect(b.outstandingTotalPaisa).toBe(sumOutstanding);

      expect(b.expectedTotalPaisa).toBe(280000);
      expect(b.verifiedTotalPaisa).toBe(210000);
      expect(b.pendingTotalPaisa).toBe(70000);
      expect(b.outstandingTotalPaisa).toBe(70000);
    });

    it('masks other members pending amounts to 0 for plain members (Sita)', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const sitaToken = FakeTokenVerifier.createToken(
        fixture.sita.user.firebaseUid,
        fixture.sita.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/reports/members?month=2026-11`)
        .set('Authorization', `Bearer ${sitaToken}`);

      expect(res.status).toBe(200);
      const b = res.body;

      // Plain member Sita should NOT see Hari's pending amount (masked to 0)
      const hariRow = b.rows.find(
        (r: { memberId: string }) => r.memberId === fixture.hari.membership.id,
      );
      expect(hariRow.pendingPaisa).toBe(0);
      expect(b.pendingTotalPaisa).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Annual Report Endpoint
  // ---------------------------------------------------------------------------
  describe('GET /v1/groups/:groupId/reports/annual', () => {
    it('reproduces Dart 2026 annual summary numbers and monthly sums equal totals', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const token = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/reports/annual?year=2026`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const b = res.body;
      expect(b.year).toBe(2026);

      // Dart annual report test asserts:
      // Contributions NPR 7,700 = 770000
      // Interest NPR 100 = 10000
      // Expenses -NPR 500 = 50000
      // Closing balance NPR 7,300 = 730000
      expect(b.contributionsPaisa).toBe(770000);
      expect(b.interestPaisa).toBe(10000);
      expect(b.expensesPaisa).toBe(50000);
      expect(b.withdrawalsPaisa).toBe(0);
      expect(b.closingPaisa).toBe(730000);

      // Months rows: Sep, Oct, Nov
      expect(b.months).toHaveLength(3);
      expect(b.months[0].month).toBe('2026-09');
      expect(b.months[0].closingPaisa).toBe(280000);

      expect(b.months[1].month).toBe('2026-10');
      expect(b.months[1].closingPaisa).toBe(520000);

      expect(b.months[2].month).toBe('2026-11');
      expect(b.months[2].closingPaisa).toBe(730000);

      // Sum of months equals totals
      const sumContrib = b.months.reduce(
        (acc: number, m: { contributionsPaisa: number }) =>
          acc + m.contributionsPaisa,
        0,
      );
      const sumInterest = b.months.reduce(
        (acc: number, m: { interestPaisa: number }) => acc + m.interestPaisa,
        0,
      );
      const sumExpenses = b.months.reduce(
        (acc: number, m: { expensesPaisa: number }) => acc + m.expensesPaisa,
        0,
      );

      expect(b.contributionsPaisa).toBe(sumContrib);
      expect(b.interestPaisa).toBe(sumInterest);
      expect(b.expensesPaisa).toBe(sumExpenses);
    });

    it('rejects years outside selectableYears with report_range_invalid', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const token = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/reports/annual?year=2025`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('report_range_invalid');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Outflow Reports (Expenses & Withdrawals)
  // ---------------------------------------------------------------------------
  describe('GET /v1/groups/:groupId/reports/expenses and /withdrawals', () => {
    it('returns expenses report netting reversals and linking to activity ids', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const token = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/reports/expenses?year=2026`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const b = res.body;
      expect(b.year).toBe(2026);
      expect(b.kind).toBe('expense');
      // Net total: 50,000 paisa (Group dinner)
      expect(b.totalPaisa).toBe(50000);

      // Check rows: Group dinner, plus the reversal pair
      expect(b.rows.length).toBeGreaterThanOrEqual(3);

      const dinnerRow = b.rows.find(
        (r: { title: string }) => r.title === 'Group dinner',
      );
      expect(dinnerRow).toBeDefined();
      expect(dinnerRow.id).toMatch(/^ledger:[0-9a-f-]+$/);
      expect(dinnerRow.amountPaisa).toBe(50000);
      expect(dinnerRow.date).toBe('2026-10-30');
      expect(dinnerRow.isReversed).toBe(false);
      expect(dinnerRow.isReversal).toBe(false);

      const reversedOrig = b.rows.find(
        (r: { title: string }) => r.title === 'Erroneous snack',
      );
      expect(reversedOrig.isReversed).toBe(true);

      const reversalAdj = b.rows.find(
        (r: { title: string }) => r.title === 'Snack correction',
      );
      expect(reversalAdj.isReversal).toBe(true);
    });

    it('returns empty withdrawals report before any withdrawal approval is executed', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const token = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const res = await request(app)
        .get(`/v1/groups/${fixture.group.id}/reports/withdrawals?year=2026`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.totalPaisa).toBe(0);
      expect(res.body.rows).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Uniform 404 & Consistency Guarantees
  // ---------------------------------------------------------------------------
  describe('Uniform 404 & Consistency', () => {
    it('returns uniform 404 group_not_found for unknown group across all endpoints', async () => {
      // Use a seeded user (Nirvan) who IS in the DB but not a member of unknownGroupId.
      // A non-existent user gets 401 from requireUser before reaching loadMembership.
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const token = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );
      const unknownGroupId = generateId();

      const endpoints = [
        `/v1/groups/${unknownGroupId}/dashboard`,
        `/v1/groups/${unknownGroupId}/reports/months`,
        `/v1/groups/${unknownGroupId}/reports/monthly?month=2026-11`,
        `/v1/groups/${unknownGroupId}/reports/members?month=2026-11`,
        `/v1/groups/${unknownGroupId}/reports/annual?year=2026`,
        `/v1/groups/${unknownGroupId}/reports/expenses?year=2026`,
        `/v1/groups/${unknownGroupId}/reports/withdrawals?year=2026`,
      ];

      for (const ep of endpoints) {
        const res = await request(app)
          .get(ep)
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('group_not_found');
      }
    });

    it('demonstrates consistency: dashboard verified balance equals monthly report closing balance', async () => {
      const fixture: ReportFixture = await seedReportFixture(directPrisma);
      const token = FakeTokenVerifier.createToken(
        fixture.nirvan.user.firebaseUid,
        fixture.nirvan.user.email,
        true,
      );

      const [dashRes, monthRes] = await Promise.all([
        request(app)
          .get(`/v1/groups/${fixture.group.id}/dashboard`)
          .set('Authorization', `Bearer ${token}`),
        request(app)
          .get(`/v1/groups/${fixture.group.id}/reports/monthly?month=2026-11`)
          .set('Authorization', `Bearer ${token}`),
      ]);

      expect(dashRes.body.verifiedBalancePaisa).toBe(
        monthRes.body.closingPaisa,
      );
      expect(dashRes.body.verifiedBalancePaisa).toBe(730000);
    });
  });
});
