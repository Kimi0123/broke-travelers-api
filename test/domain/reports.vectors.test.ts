import { describe, expect, it } from 'vitest';
import type { ActivityKind } from '../../src/domain/enums.js';
import { paisa } from '../../src/domain/money.js';
import {
  buildAnnualReport,
  buildMemberReport,
  buildMonthlyReport,
  buildOutflowReport,
} from '../../src/domain/report-builders.js';
import type {
  AnnualReport,
  LedgerLine,
  MemberReport,
  MonthlyReport,
  OutflowReport,
  ReportMember,
} from '../../src/domain/report-types.js';
import {
  createWallClock,
  type WallClock,
} from '../../src/domain/wall-clock.js';
import { adaptWallClock, loadVectorFile } from '../support/vector-loader.js';

interface RawWallClock {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  ms: number;
}

function serializeWallClock(wc: WallClock): RawWallClock {
  return {
    d: wc.d,
    h: wc.h,
    m: wc.m,
    mi: wc.mi,
    ms: wc.ms,
    s: wc.s,
    y: wc.y,
  };
}

function serializeMonthlyReport(r: MonthlyReport): Record<string, unknown> {
  return {
    closingPaisa: r.closingPaisa,
    contributionsPaisa: r.contributionsPaisa,
    expectedTotalPaisa: r.expectedTotalPaisa,
    expensesPaisa: r.expensesPaisa,
    interestPaisa: r.interestPaisa,
    month: serializeWallClock(r.month),
    obligatedCount: r.obligatedCount,
    openingPaisa: r.openingPaisa,
    outstandingPaisa: r.outstandingPaisa,
    pendingPaisa: r.pendingPaisa,
    verifiedCount: r.verifiedCount,
    withdrawalsPaisa: r.withdrawalsPaisa,
  };
}

function serializeMemberReport(r: MemberReport): Record<string, unknown> {
  return {
    expectedTotalPaisa: r.expectedTotalPaisa,
    month: serializeWallClock(r.month),
    outstandingTotalPaisa: r.outstandingTotalPaisa,
    pendingTotalPaisa: r.pendingTotalPaisa,
    rows: r.rows.map((row) => ({
      expectedPaisa: row.expectedPaisa,
      memberId: row.memberId,
      name: row.name,
      outstandingPaisa: row.outstandingPaisa,
      pendingPaisa: row.pendingPaisa,
      status: row.status,
      verifiedPaisa: row.verifiedPaisa,
    })),
    verifiedTotalPaisa: r.verifiedTotalPaisa,
  };
}

function serializeAnnualReport(r: AnnualReport): Record<string, unknown> {
  return {
    closingPaisa: r.closingPaisa,
    contributionsPaisa: r.contributionsPaisa,
    expensesPaisa: r.expensesPaisa,
    interestPaisa: r.interestPaisa,
    months: r.months.map((m) => ({
      closingPaisa: m.closingPaisa,
      contributionsPaisa: m.contributionsPaisa,
      expensesPaisa: m.expensesPaisa,
      interestPaisa: m.interestPaisa,
      month: serializeWallClock(m.month),
      netPaisa: m.netPaisa,
      withdrawalsPaisa: m.withdrawalsPaisa,
    })),
    netPaisa: r.netPaisa,
    withdrawalsPaisa: r.withdrawalsPaisa,
    year: r.year,
  };
}

function serializeOutflowReport(r: OutflowReport): Record<string, unknown> {
  return {
    kind: r.kind,
    monthTotals: r.monthTotals.map((mt) => ({
      month: serializeWallClock(mt.month),
      totalPaisa: mt.totalPaisa,
    })),
    rows: r.rows.map((row) => ({
      amountPaisa: row.amountPaisa,
      date: serializeWallClock(row.date),
      id: row.id,
      isReversal: row.isReversal,
      isReversed: row.isReversed,
      title: row.title,
    })),
    totalPaisa: r.totalPaisa,
    year: r.year,
  };
}

describe('Reports Vectors', () => {
  const vector = loadVectorFile<{
    expectedPerMemberPaisa?: number;
    month?: RawWallClock;
    lastMonth?: RawWallClock;
    year?: number;
    kind?: string;
  }>('reports');

  it('has 7 test cases', () => {
    expect(vector.cases).toHaveLength(7);
  });

  // 1. Build the fixed 4-member roster fixture
  const members: readonly ReportMember[] = [
    {
      id: 'm1',
      name: 'Nirvan',
      joinedAt: createWallClock(2026, 9, 1),
      leftAt: undefined,
    },
    {
      id: 'm2',
      name: 'Sita',
      joinedAt: createWallClock(2026, 9, 1),
      leftAt: undefined,
    },
    {
      id: 'm3',
      name: 'Ram',
      joinedAt: createWallClock(2026, 9, 1),
      leftAt: undefined,
    },
    {
      id: 'm4',
      name: 'Hari',
      joinedAt: createWallClock(2026, 9, 1),
      leftAt: undefined,
    },
  ];

  // 2. Build the 17 LedgerLine entries fixture across Sep-Nov 2026
  const lines: readonly LedgerLine[] = [
    // September 2026
    {
      id: 'e01',
      kind: 'contribution',
      status: 'verified',
      amount: paisa(70000),
      signed: paisa(70000),
      occurredAt: createWallClock(2026, 9, 1),
      periodMonth: createWallClock(2026, 9, 1),
      memberId: 'm1',
      title: "Nirvan's contribution",
    },
    {
      id: 'e02',
      kind: 'contribution',
      status: 'verified',
      amount: paisa(70000),
      signed: paisa(70000),
      occurredAt: createWallClock(2026, 9, 2),
      periodMonth: createWallClock(2026, 9, 1),
      memberId: 'm2',
      title: "Sita's contribution",
    },
    {
      id: 'e03',
      kind: 'contribution',
      status: 'verified',
      amount: paisa(70000),
      signed: paisa(70000),
      occurredAt: createWallClock(2026, 9, 3),
      periodMonth: createWallClock(2026, 9, 1),
      memberId: 'm3',
      title: "Ram's contribution",
    },
    {
      id: 'e04',
      kind: 'contribution',
      status: 'verified',
      amount: paisa(70000),
      signed: paisa(70000),
      occurredAt: createWallClock(2026, 9, 4),
      periodMonth: createWallClock(2026, 9, 1),
      memberId: 'm4',
      title: "Hari's contribution",
    },
    // October 2026
    {
      id: 'e05',
      kind: 'contribution',
      status: 'verified',
      amount: paisa(70000),
      signed: paisa(70000),
      occurredAt: createWallClock(2026, 10, 1),
      periodMonth: createWallClock(2026, 10, 1),
      memberId: 'm1',
      title: "Nirvan's contribution",
    },
    {
      id: 'e06',
      kind: 'contribution',
      status: 'verified',
      amount: paisa(70000),
      signed: paisa(70000),
      occurredAt: createWallClock(2026, 10, 2),
      periodMonth: createWallClock(2026, 10, 1),
      memberId: 'm2',
      title: "Sita's contribution",
    },
    {
      id: 'e07',
      kind: 'contribution',
      status: 'verified',
      amount: paisa(70000),
      signed: paisa(70000),
      occurredAt: createWallClock(2026, 10, 3),
      periodMonth: createWallClock(2026, 10, 1),
      memberId: 'm3',
      title: "Ram's contribution",
    },
    {
      id: 'e08',
      kind: 'contribution',
      status: 'verified',
      amount: paisa(70000),
      signed: paisa(70000),
      occurredAt: createWallClock(2026, 10, 4),
      periodMonth: createWallClock(2026, 10, 1),
      memberId: 'm4',
      title: "Hari's contribution",
    },
    {
      id: 'e09',
      kind: 'interest',
      status: 'verified',
      amount: paisa(10000),
      signed: paisa(10000),
      occurredAt: createWallClock(2026, 10, 28),
      periodMonth: createWallClock(2026, 10, 1),
      title: 'Bank interest',
    },
    {
      id: 'e10',
      kind: 'expense',
      status: 'verified',
      amount: paisa(50000),
      signed: paisa(-50000),
      occurredAt: createWallClock(2026, 10, 30),
      periodMonth: createWallClock(2026, 10, 1),
      title: 'Group dinner',
    },
    // November 2026
    {
      id: 'e11',
      kind: 'contribution',
      status: 'verified',
      amount: paisa(70000),
      signed: paisa(70000),
      occurredAt: createWallClock(2026, 11, 1),
      periodMonth: createWallClock(2026, 11, 1),
      memberId: 'm1',
      title: "Nirvan's contribution",
    },
    {
      id: 'e12',
      kind: 'contribution',
      status: 'verified',
      amount: paisa(70000),
      signed: paisa(70000),
      occurredAt: createWallClock(2026, 11, 2),
      periodMonth: createWallClock(2026, 11, 1),
      memberId: 'm2',
      title: "Sita's contribution",
    },
    {
      id: 'e13',
      kind: 'contribution',
      status: 'verified',
      amount: paisa(70000),
      signed: paisa(70000),
      occurredAt: createWallClock(2026, 11, 3),
      periodMonth: createWallClock(2026, 11, 1),
      memberId: 'm3',
      title: "Ram's contribution",
    },
    {
      id: 'e14',
      kind: 'contribution',
      status: 'pendingVerification',
      amount: paisa(70000),
      signed: paisa(0),
      occurredAt: createWallClock(2026, 11, 4),
      periodMonth: createWallClock(2026, 11, 1),
      memberId: 'm4',
      title: "Hari's contribution",
    },
    {
      id: 'e15',
      kind: 'contribution',
      status: 'rejected',
      amount: paisa(70000),
      signed: paisa(0),
      occurredAt: createWallClock(2026, 11, 5),
      periodMonth: createWallClock(2026, 11, 1),
      memberId: 'm4',
      title: "Hari's rejected draft",
    },
    {
      id: 'e16',
      kind: 'expense',
      status: 'verified',
      amount: paisa(20000),
      signed: paisa(-20000),
      occurredAt: createWallClock(2026, 11, 6),
      periodMonth: createWallClock(2026, 11, 1),
      title: 'Erroneous fee',
    },
    {
      id: 'e17',
      kind: 'expense',
      status: 'verified',
      amount: paisa(20000),
      signed: paisa(20000),
      occurredAt: createWallClock(2026, 11, 7),
      periodMonth: createWallClock(2026, 11, 1),
      title: 'Fee refund reversal',
      reversesId: 'e16',
    },
  ];

  for (const c of vector.cases) {
    it(c.name, () => {
      const expectedReport = (c.expected as { report: Record<string, unknown> })
        .report;

      if (c.name.startsWith('monthly_report_')) {
        const month = adaptWallClock(c.input.month!);
        const report = buildMonthlyReport({
          lines,
          members,
          expectedPerMember: paisa(c.input.expectedPerMemberPaisa!),
          month,
        });
        expect(serializeMonthlyReport(report)).toEqual(expectedReport);
      } else if (c.name.startsWith('member_report_')) {
        const month = adaptWallClock(c.input.month!);
        const report = buildMemberReport({
          lines,
          members,
          expectedPerMember: paisa(c.input.expectedPerMemberPaisa!),
          month,
        });
        expect(serializeMemberReport(report)).toEqual(expectedReport);
      } else if (c.name.startsWith('annual_report_')) {
        const lastMonth = adaptWallClock(c.input.lastMonth!);
        const report = buildAnnualReport({
          lines,
          year: c.input.year!,
          lastMonth,
        });
        expect(serializeAnnualReport(report)).toEqual(expectedReport);
      } else if (c.name.startsWith('outflow_report_')) {
        const report = buildOutflowReport({
          lines,
          year: c.input.year!,
          kind: c.input.kind as ActivityKind,
        });
        expect(serializeOutflowReport(report)).toEqual(expectedReport);
      } else {
        throw new Error(`Unknown report case: ${c.name}`);
      }
    });
  }
});
