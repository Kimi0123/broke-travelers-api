import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  ActivityKind,
  PaymentMethod,
  PaymentStatus,
} from '../domain/enums.js';
import { signedPaisa } from '../domain/ledger-math.js';
import { bigintToPaisa } from '../infrastructure/db/money.js';
import { HttpError } from '../http/errors.js';
import { encodeCursor, type KeysetCursor } from '../http/helpers/pagination.js';

export interface ActivityItemDto {
  readonly id: string;
  readonly source: 'ledger' | 'submission';
  readonly rawId: string;
  readonly kind: ActivityKind;
  readonly title: string;
  readonly amountPaisa: number;
  readonly status: PaymentStatus;
  readonly occurredAt: string;
  readonly memberId: string | null;
  readonly memberName: string | null;
  readonly paymentMethod: PaymentMethod | null;
  readonly note: string | null;
  readonly reversesTransactionId: string | null;
  readonly reversedByTransactionId: string | null;
  readonly signedAmountPaisa: number;
  readonly postedAt?: string | undefined;
  readonly actorMemberId?: string | undefined;
}

interface RawActivityRow {
  readonly id: string;
  readonly source: 'ledger' | 'submission';
  readonly raw_id: string;
  readonly group_id: string;
  readonly kind: string;
  readonly title: string;
  readonly amount_paisa: bigint;
  readonly status: string;
  readonly occurred_at: Date;
  readonly member_id: string | null;
  readonly payment_method: string | null;
  readonly note: string | null;
  readonly reverses_entry_id: string | null;
  readonly member_name: string | null;
}

function mapStatus(status: string): PaymentStatus {
  if (status === 'pending') return 'pendingVerification';
  if (status === 'rejected') return 'rejected';
  return 'verified';
}

function mapRowToDto(
  row: RawActivityRow,
  reversedByMap: ReadonlyMap<string, string>,
): ActivityItemDto {
  const amountPaisaNum = Number(row.amount_paisa);
  const status = mapStatus(row.status);
  const kind = row.kind as ActivityKind;

  let signedAmt: number;
  if (row.source === 'ledger') {
    signedAmt = signedPaisa({
      kind,
      magnitudePaisa: bigintToPaisa(row.amount_paisa),
      reversesEntryId: row.reverses_entry_id,
    });
  } else {
    signedAmt = amountPaisaNum;
  }

  const reversedBy = reversedByMap.get(row.raw_id) ?? null;

  return {
    id: row.id,
    source: row.source,
    rawId: row.raw_id,
    kind,
    title: row.title,
    amountPaisa: amountPaisaNum,
    status,
    occurredAt: row.occurred_at.toISOString(),
    memberId: row.member_id,
    memberName: row.member_name,
    paymentMethod: (row.payment_method as PaymentMethod) ?? null,
    note: row.note,
    reversesTransactionId: row.reverses_entry_id
      ? `ledger:${row.reverses_entry_id}`
      : null,
    reversedByTransactionId: reversedBy ? `ledger:${reversedBy}` : null,
    signedAmountPaisa: signedAmt,
  };
}

export async function listActivityItems(
  prisma: PrismaClient,
  params: {
    readonly groupId: string;
    readonly limit: number;
    readonly cursor: KeysetCursor | null;
    readonly kind?: ActivityKind | undefined;
    readonly status?: string | undefined;
  },
): Promise<{
  readonly items: ActivityItemDto[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}> {
  const { groupId, limit, cursor, kind, status } = params;

  // Filter clauses
  const cursorClause = cursor
    ? Prisma.sql`AND (a.occurred_at, a.id) < (${new Date(cursor.occurredAt)}, ${cursor.id})`
    : Prisma.empty;

  const kindClause = kind ? Prisma.sql`AND a.kind = ${kind}` : Prisma.empty;

  const statusFilter = status === 'pendingVerification' ? 'pending' : status;
  const statusClause = statusFilter
    ? Prisma.sql`AND a.status = ${statusFilter}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<RawActivityRow[]>`
    SELECT
      a.id,
      a.source,
      a.raw_id,
      a.group_id,
      a.kind,
      a.title,
      a.amount_paisa,
      a.status,
      a.occurred_at,
      a.member_id,
      a.payment_method,
      a.note,
      a.reverses_entry_id,
      u.display_name AS member_name
    FROM v_activity_items a
    LEFT JOIN group_memberships gm ON gm.id = a.member_id
    LEFT JOIN users u ON u.id = gm.user_id
    WHERE a.group_id = ${groupId}::uuid
      ${cursorClause}
      ${kindClause}
      ${statusClause}
    ORDER BY a.occurred_at DESC, a.id DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  // Find reversals for these rows
  const rawIds = pageRows
    .filter((r) => r.source === 'ledger')
    .map((r) => r.raw_id);

  const reversedByMap = new Map<string, string>();
  if (rawIds.length > 0) {
    const reversals = await prisma.ledgerEntry.findMany({
      where: {
        groupId,
        reversesEntryId: { in: rawIds },
      },
      select: {
        id: true,
        reversesEntryId: true,
      },
    });
    for (const rev of reversals) {
      if (rev.reversesEntryId) {
        reversedByMap.set(rev.reversesEntryId, rev.id);
      }
    }
  }

  const items = pageRows.map((r) => mapRowToDto(r, reversedByMap));

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1]!;
    nextCursor = encodeCursor({
      occurredAt: lastItem.occurredAt,
      id: lastItem.id,
    });
  }

  return { items, nextCursor, hasMore };
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getActivityItem(
  prisma: PrismaClient,
  params: {
    readonly groupId: string;
    readonly transactionId: string;
    readonly viewer?:
      | {
          readonly memberId: string;
          readonly isTreasurer: boolean;
          readonly isOwner: boolean;
        }
      | undefined;
  },
): Promise<ActivityItemDto> {
  const { groupId, transactionId } = params;

  let source: 'ledger' | 'submission';
  let rawId: string;

  if (transactionId.startsWith('ledger:')) {
    source = 'ledger';
    rawId = transactionId.slice(7);
  } else if (transactionId.startsWith('submission:')) {
    source = 'submission';
    rawId = transactionId.slice(11);
  } else {
    throw new HttpError(404, 'transaction_not_found');
  }

  if (!UUID_REGEX.test(rawId)) {
    throw new HttpError(404, 'transaction_not_found');
  }

  if (source === 'ledger') {
    const entry = await prisma.ledgerEntry.findFirst({
      where: { id: rawId, groupId },
      include: {
        member: {
          include: {
            user: { select: { displayName: true } },
          },
        },
      },
    });

    if (!entry) {
      throw new HttpError(404, 'transaction_not_found');
    }

    const reversal = await prisma.ledgerEntry.findFirst({
      where: { groupId, reversesEntryId: entry.id },
      select: { id: true },
    });

    const kind = entry.kind as ActivityKind;
    const amountPaisa = Number(entry.magnitudePaisa);
    const signedAmt = signedPaisa({
      kind,
      magnitudePaisa: bigintToPaisa(entry.magnitudePaisa),
      reversesEntryId: entry.reversesEntryId,
    });

    return {
      id: `ledger:${entry.id}`,
      source: 'ledger',
      rawId: entry.id,
      kind,
      title: entry.title,
      amountPaisa,
      status: 'verified',
      occurredAt: entry.occurredAt.toISOString(),
      postedAt: entry.postedAt.toISOString(),
      memberId: entry.memberId,
      memberName: entry.member?.user.displayName ?? null,
      paymentMethod: (entry.paymentMethod as PaymentMethod) ?? null,
      note: entry.note,
      reversesTransactionId: entry.reversesEntryId
        ? `ledger:${entry.reversesEntryId}`
        : null,
      reversedByTransactionId: reversal ? `ledger:${reversal.id}` : null,
      signedAmountPaisa: signedAmt,
      actorMemberId: entry.actorMemberId,
    };
  } else {
    // If the submission has been verified, resolve to the posted ledger entry
    const subRaw = await prisma.paymentSubmission.findFirst({
      where: { id: rawId, groupId },
      include: {
        member: {
          include: {
            user: { select: { displayName: true } },
          },
        },
      },
    });

    if (!subRaw) {
      throw new HttpError(404, 'transaction_not_found');
    }

    // If verified, redirect to the ledger entry
    if (subRaw.postedLedgerEntryId !== null) {
      return getActivityItem(prisma, {
        groupId,
        transactionId: `ledger:${subRaw.postedLedgerEntryId}`,
        viewer: params.viewer,
      });
    }

    // Visibility: a rejected submission is visible to its submitter and to treasurers/owner only.
    // For any other member, submission:<uuid> of a rejected submission -> 404 (same body as unknown).
    if (subRaw.status === 'rejected') {
      const isSubmitter = params.viewer?.memberId === subRaw.memberId;
      const isPrivileged = !!(
        params.viewer?.isTreasurer || params.viewer?.isOwner
      );
      if (!isSubmitter && !isPrivileged) {
        throw new HttpError(404, 'transaction_not_found');
      }
    }

    const sub = subRaw;

    const amountPaisa = Number(sub.amountPaisa);
    const memberName = sub.member.user.displayName;
    const title = `${memberName}'s contribution`;

    return {
      id: `submission:${sub.id}`,
      source: 'submission',
      rawId: sub.id,
      kind: 'contribution',
      title,
      amountPaisa,
      status: mapStatus(sub.status),
      occurredAt: sub.submittedAt.toISOString(),
      memberId: sub.memberId,
      memberName,
      paymentMethod: sub.paymentMethod as PaymentMethod,
      note: sub.note,
      reversesTransactionId: null,
      reversedByTransactionId: null,
      signedAmountPaisa: amountPaisa,
    };
  }
}
