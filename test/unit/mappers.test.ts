import { describe, expect, it } from 'vitest';
import type {
  LedgerEntry as PrismaLedgerEntry,
  PaymentSubmission as PrismaPaymentSubmission,
} from '@prisma/client';
import {
  mapLedgerEntryRow,
  mapPaymentSubmissionRow,
  mapSubmissionToLedgerEntry,
  sortBySeqAsc,
  sortBySeqDesc,
} from '../../src/infrastructure/db/mappers.js';

describe('database mappers', () => {
  it('maps Prisma LedgerEntry row to domain LedgerEntry preserving seq and fields', () => {
    const rawRow: PrismaLedgerEntry = {
      id: '01931e50-4567-7000-8000-000000000001',
      seq: 42n,
      groupId: '01931e50-1234-7000-8000-000000000001',
      kind: 'contribution',
      title: 'Savings Contribution - Nov 2026',
      magnitudePaisa: 500000n,
      occurredAt: new Date('2026-11-10T06:15:00.000Z'),
      postedAt: new Date('2026-11-10T06:20:00.000Z'),
      memberId: '01931e50-2222-7000-8000-000000000001',
      periodMonth: new Date('2026-11-01T00:00:00.000Z'),
      paymentMethod: 'esewa',
      note: 'November contribution',
      reversesEntryId: null,
      actorMemberId: '01931e50-3333-7000-8000-000000000001',
    };

    const domainEntry = mapLedgerEntryRow(rawRow);

    expect(domainEntry.id).toBe(rawRow.id);
    expect(domainEntry.seq).toBe(42n);
    expect(domainEntry.groupId).toBe(rawRow.groupId);
    expect(domainEntry.kind).toBe('contribution');
    expect(domainEntry.title).toBe(rawRow.title);
    expect(domainEntry.magnitudePaisa).toBe(500000);
    expect(domainEntry.status).toBe('verified');
    expect(domainEntry.memberId).toBe(rawRow.memberId);
    expect(domainEntry.paymentMethod).toBe('esewa');
    expect(domainEntry.note).toBe('November contribution');
    expect(domainEntry.reversesEntryId).toBeNull();
    expect(domainEntry.actorMemberId).toBe(rawRow.actorMemberId);

    // Occurred at 06:15 UTC -> 12:00 NPT
    expect(domainEntry.occurredAt).toEqual({
      y: 2026,
      m: 11,
      d: 10,
      h: 12,
      mi: 0,
      s: 0,
      ms: 0,
    });

    // Period month 2026-11-01 UTC date-only
    expect(domainEntry.periodMonth).toEqual({
      y: 2026,
      m: 11,
      d: 1,
      h: 0,
      mi: 0,
      s: 0,
      ms: 0,
    });
  });

  it('maps Prisma PaymentSubmission row to domain representation', () => {
    const rawSubmission: PrismaPaymentSubmission = {
      id: '01931e50-7777-7000-8000-000000000001',
      seq: 100n,
      groupId: '01931e50-1234-7000-8000-000000000001',
      memberId: '01931e50-2222-7000-8000-000000000001',
      periodMonth: new Date('2026-11-01T00:00:00.000Z'),
      amountPaisa: 500000n,
      paymentMethod: 'khalti',
      reference: 'KH-12345678',
      note: 'Payment note',
      status: 'pending',
      submittedAt: new Date('2026-11-05T04:15:00.000Z'),
      reviewedByMemberId: null,
      reviewedAt: null,
      rejectionReason: null,
      rejectionNote: null,
      postedLedgerEntryId: null,
    };

    const domainSub = mapPaymentSubmissionRow(rawSubmission);

    expect(domainSub.id).toBe(rawSubmission.id);
    expect(domainSub.seq).toBe(100n);
    expect(domainSub.amountPaisa).toBe(500000);
    expect(domainSub.status).toBe('pending');
    expect(domainSub.reference).toBe('KH-12345678');
    expect(domainSub.submittedAt).toEqual({
      y: 2026,
      m: 11,
      d: 5,
      h: 10,
      mi: 0,
      s: 0,
      ms: 0,
    });
  });

  it('maps submission lifecycle states to appropriate domain ledger status', () => {
    const base: PrismaPaymentSubmission = {
      id: '01931e50-9999-7000-8000-000000000001',
      seq: 5n,
      groupId: 'g1',
      memberId: 'm1',
      periodMonth: new Date('2026-11-01T00:00:00.000Z'),
      amountPaisa: 500000n,
      paymentMethod: 'cash',
      reference: null,
      note: null,
      status: 'pending',
      submittedAt: new Date('2026-11-01T00:00:00.000Z'),
      reviewedByMemberId: null,
      reviewedAt: null,
      rejectionReason: null,
      rejectionNote: null,
      postedLedgerEntryId: null,
    };

    const pendingMapped = mapSubmissionToLedgerEntry(base);
    expect(pendingMapped.status).toBe('pendingVerification');

    const rejectedMapped = mapSubmissionToLedgerEntry({
      ...base,
      status: 'rejected',
    });
    expect(rejectedMapped.status).toBe('rejected');

    const verifiedMapped = mapSubmissionToLedgerEntry({
      ...base,
      status: 'verified',
    });
    expect(verifiedMapped.status).toBe('verified');
  });

  it('sorts entries deterministically by seq ascending and descending', () => {
    const entries = [
      { id: '3', seq: 300n },
      { id: '1', seq: 100n },
      { id: '2', seq: 200n },
    ];

    const asc = sortBySeqAsc(entries);
    expect(asc.map((e) => e.seq)).toEqual([100n, 200n, 300n]);

    const desc = sortBySeqDesc(entries);
    expect(desc.map((e) => e.seq)).toEqual([300n, 200n, 100n]);
  });
});
