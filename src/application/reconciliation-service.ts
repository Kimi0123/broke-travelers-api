import type { PrismaClient } from '@prisma/client';
import { verifiedBalancePaisa } from '../domain/ledger-math.js';
import { createWallClock, type WallClock } from '../domain/wall-clock.js';
import { HttpError } from '../http/errors.js';
import { withTransaction } from '../infrastructure/db/client.js';
import { generateId } from '../infrastructure/db/ids.js';
import {
  mapLedgerEntryRow,
  sortBySeqAsc,
} from '../infrastructure/db/mappers.js';
import { utcInstantToNptWallClock } from '../infrastructure/time/npt.js';
import { checkIdempotency, saveIdempotency } from './idempotency.js';
import { acquireGroupLock } from './posting-service.js';

export interface ReconciliationDto {
  readonly id: string;
  readonly groupId: string;
  readonly statementDate: string; // YYYY-MM-DD
  readonly bankBalancePaisa: number;
  readonly recordedBalancePaisa: number;
  readonly differencePaisa: number;
  readonly status: 'matched' | 'mismatch';
  readonly note: string | null;
  readonly recordedByMemberId: string;
  readonly recordedByName: string;
  readonly recordedAt: string;
}

export interface RecordReconciliationParams {
  readonly groupId: string;
  readonly actorUserId: string;
  readonly memberId: string;
  readonly statementDate: string;
  readonly bankBalancePaisa: number;
  readonly note?: string | null | undefined;
  readonly idempotencyKey: string;
}

export function parseAndValidateStatementDate(
  dateStr: string,
  nowNpt: WallClock,
): { dateOnly: Date; wallClock: WallClock } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    throw new HttpError(
      400,
      'invalid_statement_date',
      'Statement date must be in YYYY-MM-DD format',
    );
  }

  const y = parseInt(match[1]!, 10);
  const m = parseInt(match[2]!, 10);
  const d = parseInt(match[3]!, 10);

  if (m < 1 || m > 12 || d < 1 || d > 31) {
    throw new HttpError(
      400,
      'invalid_statement_date',
      'Statement date is invalid',
    );
  }

  // Check future date in NPT
  if (
    y > nowNpt.y ||
    (y === nowNpt.y && (m > nowNpt.m || (m === nowNpt.m && d > nowNpt.d)))
  ) {
    throw new HttpError(
      400,
      'invalid_statement_date',
      'Statement date is invalid or in the future',
    );
  }

  const dateOnly = new Date(Date.UTC(y, m - 1, d));
  const wallClock = createWallClock(y, m, d);
  return { dateOnly, wallClock };
}

export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: () => Date = () => new Date(),
    private readonly idGenerator: () => string = generateId,
  ) {}

  private getNow(): Date {
    return this.clock();
  }

  private getId(): string {
    return this.idGenerator();
  }

  async getRecordedBalance(params: {
    readonly groupId: string;
    readonly dateStr: string;
  }): Promise<{ date: string; recordedBalancePaisa: number }> {
    const { groupId, dateStr } = params;
    const now = this.getNow();
    const nowNpt = utcInstantToNptWallClock(now);
    const { wallClock } = parseAndValidateStatementDate(dateStr, nowNpt);

    const ledgerRows = await this.prisma.ledgerEntry.findMany({
      where: { groupId },
      orderBy: { seq: 'asc' },
    });
    const entries = ledgerRows.map(mapLedgerEntryRow);
    sortBySeqAsc(entries);
    const balance = verifiedBalancePaisa(entries, { asOf: wallClock });

    return {
      date: dateStr,
      recordedBalancePaisa: Number(balance),
    };
  }

  async listReconciliations(params: {
    readonly groupId: string;
  }): Promise<ReconciliationDto[]> {
    const { groupId } = params;

    const rows = await this.prisma.bankReconciliation.findMany({
      where: { groupId },
      include: {
        recordedByMember: {
          include: { user: { select: { displayName: true } } },
        },
      },
      orderBy: [{ statementDate: 'desc' }, { recordedAt: 'desc' }],
    });

    return rows.map((r) => {
      const diff = Number(r.differencePaisa);
      return {
        id: r.id,
        groupId: r.groupId,
        statementDate: r.statementDate.toISOString().slice(0, 10),
        bankBalancePaisa: Number(r.bankBalancePaisa),
        recordedBalancePaisa: Number(r.recordedBalancePaisa),
        differencePaisa: diff,
        status: diff === 0 ? 'matched' : 'mismatch',
        note: r.note,
        recordedByMemberId: r.recordedByMemberId,
        recordedByName: r.recordedByMember?.user.displayName ?? 'Member',
        recordedAt: r.recordedAt.toISOString(),
      };
    });
  }

  async recordReconciliation(
    params: RecordReconciliationParams,
  ): Promise<{ reconciliation: ReconciliationDto; isReplay: boolean }> {
    const {
      groupId,
      actorUserId,
      memberId,
      statementDate,
      bankBalancePaisa,
      note,
      idempotencyKey,
    } = params;

    const now = this.getNow();
    const nowNpt = utcInstantToNptWallClock(now);
    const { dateOnly, wallClock } = parseAndValidateStatementDate(
      statementDate,
      nowNpt,
    );

    if (
      !Number.isInteger(bankBalancePaisa) ||
      bankBalancePaisa < 0 ||
      bankBalancePaisa > 1000000000
    ) {
      throw new HttpError(
        400,
        'invalid_reconciliation_input',
        'Bank balance must be an integer between 0 and 1,000,000,000 paisa',
      );
    }

    const trimmedNote = note?.trim() || null;
    if (trimmedNote && trimmedNote.length > 200) {
      throw new HttpError(
        400,
        'invalid_reconciliation_input',
        'Note cannot exceed 200 characters',
      );
    }

    return withTransaction(this.prisma, async (tx) => {
      await acquireGroupLock(tx, groupId);

      // Verify caller is treasurer
      const member = await tx.groupMembership.findUnique({
        where: { id: memberId },
      });
      if (!member || member.groupId !== groupId || !member.isTreasurer) {
        throw new HttpError(403, 'forbidden');
      }

      const idempotency = await checkIdempotency<ReconciliationDto>(tx, {
        idempotencyKey,
        operation: 'record_reconciliation',
        groupId,
        actorUserId,
        payload: {
          groupId,
          memberId,
          statementDate,
          bankBalancePaisa,
          note: trimmedNote,
        },
      });

      if (idempotency.existing) {
        return { reconciliation: idempotency.existing.data, isReplay: true };
      }

      // Check unique statement date for group
      const existing = await tx.bankReconciliation.findUnique({
        where: {
          groupId_statementDate: {
            groupId,
            statementDate: dateOnly,
          },
        },
      });

      if (existing) {
        throw new HttpError(
          409,
          'reconciliation_already_recorded',
          'A reconciliation has already been recorded for this statement date',
        );
      }

      // Compute recorded balance as of end of statement date in NPT
      const ledgerRows = await tx.ledgerEntry.findMany({
        where: { groupId },
        orderBy: { seq: 'asc' },
      });
      const entries = ledgerRows.map(mapLedgerEntryRow);
      sortBySeqAsc(entries);
      const recordedBalance = verifiedBalancePaisa(entries, {
        asOf: wallClock,
      });
      const recordedBalancePaisa = Number(recordedBalance);
      const differencePaisa = bankBalancePaisa - recordedBalancePaisa;

      const reconId = this.getId();

      const created = await tx.bankReconciliation.create({
        data: {
          id: reconId,
          groupId,
          statementDate: dateOnly,
          bankBalancePaisa: BigInt(bankBalancePaisa),
          recordedBalancePaisa: BigInt(recordedBalancePaisa),
          differencePaisa: BigInt(differencePaisa),
          note: trimmedNote,
          recordedByMemberId: memberId,
          recordedAt: now,
        },
        include: {
          recordedByMember: {
            include: { user: { select: { displayName: true } } },
          },
        },
      });

      // Audit log: reconciliation.recorded
      await tx.auditLog.create({
        data: {
          id: this.getId(),
          groupId,
          actorUserId,
          action: 'reconciliation.recorded',
          field: `reconciliation:${reconId}`,
          beforeValue: 'none',
          afterValue: `${statementDate}:${differencePaisa}`,
        },
      });

      const dto: ReconciliationDto = {
        id: created.id,
        groupId: created.groupId,
        statementDate,
        bankBalancePaisa,
        recordedBalancePaisa,
        differencePaisa,
        status: differencePaisa === 0 ? 'matched' : 'mismatch',
        note: created.note,
        recordedByMemberId: created.recordedByMemberId,
        recordedByName: created.recordedByMember?.user.displayName ?? 'Member',
        recordedAt: created.recordedAt.toISOString(),
      };

      await saveIdempotency(tx, {
        idempotencyKey,
        operation: 'record_reconciliation',
        groupId,
        actorUserId,
        requestHash: idempotency.requestHash,
        responseStatus: 201,
        responseBody: dto,
      });

      return { reconciliation: dto, isReplay: false };
    });
  }
}
