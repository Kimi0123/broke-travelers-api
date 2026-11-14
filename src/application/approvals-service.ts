import type { PrismaClient } from '@prisma/client';
import {
  isApprovalExpired,
  resolveOpenStatus,
  votesNeeded,
} from '../domain/approval-rules.js';
import type { ActivityKind, PaymentMethod } from '../domain/enums.js';
import { verifiedBalancePaisa } from '../domain/ledger-math.js';
import { HttpError } from '../http/errors.js';
import { withTransaction } from '../infrastructure/db/client.js';
import { generateId } from '../infrastructure/db/ids.js';
import {
  mapLedgerEntryRow,
  sortBySeqAsc,
} from '../infrastructure/db/mappers.js';
import { bigintToPaisa } from '../infrastructure/db/money.js';
import {
  nptWallClockToUtcInstant,
  utcInstantToNptWallClock,
} from '../infrastructure/time/npt.js';
import { addDays } from '../domain/wall-clock.js';
import { checkIdempotency, saveIdempotency } from './idempotency.js';
import { acquireGroupLock, postLedgerEntry } from './posting-service.js';

export interface ApprovalVoteRecordDto {
  readonly memberId: string;
  readonly memberName: string;
  readonly choice: 'approve' | 'reject';
  readonly at: string;
}

export interface ApprovalRequestDto {
  readonly id: string;
  readonly groupId: string;
  readonly kind: 'withdrawal' | 'expense';
  readonly title: string;
  readonly payee: string;
  readonly description: string | null;
  readonly amountPaisa: number;
  readonly requesterMemberId: string;
  readonly requesterName: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly closedAt: string | null;
  readonly status:
    'open' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'executed';
  readonly eligibleCount: number;
  readonly votesNeeded: number;
  readonly approveCount: number;
  readonly rejectCount: number;
  readonly isMine: boolean;
  readonly canVote: boolean;
  readonly myVote: 'approve' | 'reject' | null;
  readonly votes: ApprovalVoteRecordDto[];
  readonly executedTransactionId: string | null;
}

export interface CreateApprovalParams {
  readonly groupId: string;
  readonly actorUserId: string;
  readonly memberId: string;
  readonly kind: string;
  readonly title: string;
  readonly payee: string;
  readonly description?: string | null | undefined;
  readonly amountPaisa: number;
  readonly idempotencyKey: string;
}

export interface VoteApprovalParams {
  readonly groupId: string;
  readonly approvalId: string;
  readonly actorUserId: string;
  readonly memberId: string;
  readonly vote: 'approve' | 'reject';
  readonly idempotencyKey: string;
}

export interface CancelApprovalParams {
  readonly groupId: string;
  readonly approvalId: string;
  readonly actorUserId: string;
  readonly memberId: string;
  readonly idempotencyKey: string;
}

export interface ExecuteApprovalParams {
  readonly groupId: string;
  readonly approvalId: string;
  readonly actorUserId: string;
  readonly memberId: string;
  readonly method?: PaymentMethod | undefined;
  readonly idempotencyKey: string;
}

export class ApprovalsService {
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

  private computeDynamicStatus(
    request: {
      readonly status: string;
      readonly createdAt: Date;
      readonly eligibleVoters: { readonly memberId: string }[];
      readonly votes: {
        readonly memberId: string;
        readonly approve: boolean;
      }[];
    },
    now: Date,
  ): 'open' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'executed' {
    if (request.status === 'cancelled') return 'cancelled';
    if (request.status === 'executed') return 'executed';
    if (request.status === 'rejected') return 'rejected';
    if (request.status === 'approved') return 'approved';

    // Stored status is open: evaluate expiration
    const createdNpt = utcInstantToNptWallClock(request.createdAt);
    const nowNpt = utcInstantToNptWallClock(now);
    if (isApprovalExpired(createdNpt, nowNpt)) {
      return 'expired';
    }

    const eligible = request.eligibleVoters.length;
    if (eligible === 0) return 'open';

    const approvals = request.votes.filter((v) => v.approve).length;
    const rejections = request.votes.filter((v) => !v.approve).length;
    return resolveOpenStatus({ eligible, approvals, rejections });
  }

  private mapToDto(
    req: {
      readonly id: string;
      readonly groupId: string;
      readonly kind: string;
      readonly title: string;
      readonly payee: string;
      readonly description: string | null;
      readonly amountPaisa: bigint;
      readonly requesterMemberId: string;
      readonly createdAt: Date;
      readonly expiresAt: Date;
      readonly closedAt: Date | null;
      readonly status: string;
      readonly executedEntryId: string | null;
      readonly requesterMember?: {
        readonly user: { readonly displayName: string };
      } | null;
      readonly eligibleVoters: { readonly memberId: string }[];
      readonly votes: {
        readonly memberId: string;
        readonly approve: boolean;
        readonly votedAt: Date;
        readonly member?: {
          readonly user: { readonly displayName: string };
        } | null;
      }[];
    },
    viewerMemberId: string,
    now: Date,
  ): ApprovalRequestDto {
    const dynamicStatus = this.computeDynamicStatus(req, now);
    const eligibleCount = req.eligibleVoters.length;
    const needed = eligibleCount > 0 ? votesNeeded(eligibleCount) : 0;
    const approveCount = req.votes.filter((v) => v.approve).length;
    const rejectCount = req.votes.filter((v) => !v.approve).length;

    const myVoteRow = req.votes.find((v) => v.memberId === viewerMemberId);
    const myVote: 'approve' | 'reject' | null = myVoteRow
      ? myVoteRow.approve
        ? 'approve'
        : 'reject'
      : null;

    const isMine = req.requesterMemberId === viewerMemberId;
    const isEligible = req.eligibleVoters.some(
      (ev) => ev.memberId === viewerMemberId,
    );
    const canVote =
      dynamicStatus === 'open' && isEligible && !isMine && myVote === null;

    const votesDto: ApprovalVoteRecordDto[] = req.votes.map((v) => ({
      memberId: v.memberId,
      memberName: v.member?.user.displayName ?? 'Member',
      choice: v.approve ? 'approve' : 'reject',
      at: v.votedAt.toISOString(),
    }));

    return {
      id: req.id,
      groupId: req.groupId,
      kind: req.kind as 'withdrawal' | 'expense',
      title: req.title,
      payee: req.payee,
      description: req.description,
      amountPaisa: Number(req.amountPaisa),
      requesterMemberId: req.requesterMemberId,
      requesterName: req.requesterMember?.user.displayName ?? 'Member',
      createdAt: req.createdAt.toISOString(),
      expiresAt: req.expiresAt.toISOString(),
      closedAt: req.closedAt ? req.closedAt.toISOString() : null,
      status: dynamicStatus,
      eligibleCount,
      votesNeeded: needed,
      approveCount,
      rejectCount,
      isMine,
      canVote,
      myVote,
      votes: votesDto,
      executedTransactionId: req.executedEntryId
        ? `ledger:${req.executedEntryId}`
        : null,
    };
  }

  async createApproval(
    params: CreateApprovalParams,
  ): Promise<{ approval: ApprovalRequestDto; isReplay: boolean }> {
    const {
      groupId,
      actorUserId,
      memberId,
      kind,
      title,
      payee,
      description,
      amountPaisa,
      idempotencyKey,
    } = params;

    // 1. Validations
    if (kind !== 'withdrawal' && kind !== 'expense') {
      throw new HttpError(
        400,
        'invalid_approval_input',
        'Kind must be withdrawal or expense',
      );
    }
    if (
      !Number.isInteger(amountPaisa) ||
      amountPaisa <= 0 ||
      amountPaisa > 1000000000
    ) {
      throw new HttpError(
        400,
        'invalid_approval_input',
        'Amount must be between 1 and 1,000,000,000 paisa',
      );
    }
    const trimmedTitle = title ? title.trim() : '';
    if (trimmedTitle.length < 2 || trimmedTitle.length > 60) {
      throw new HttpError(
        400,
        'invalid_approval_input',
        'Title must be 2 to 60 characters',
      );
    }
    const trimmedPayee = payee ? payee.trim() : '';
    if (trimmedPayee.length < 2 || trimmedPayee.length > 60) {
      throw new HttpError(
        400,
        'invalid_approval_input',
        'Payee must be 2 to 60 characters',
      );
    }
    const trimmedDesc = description?.trim() || null;
    if (trimmedDesc && trimmedDesc.length > 200) {
      throw new HttpError(
        400,
        'invalid_approval_input',
        'Description cannot exceed 200 characters',
      );
    }

    return withTransaction(this.prisma, async (tx) => {
      // 2. Lock group
      await acquireGroupLock(tx, groupId);

      // 3. Idempotency check
      const idempotency = await checkIdempotency<ApprovalRequestDto>(tx, {
        idempotencyKey,
        operation: 'create_approval',
        groupId,
        actorUserId,
        payload: {
          groupId,
          memberId,
          kind,
          title: trimmedTitle,
          payee: trimmedPayee,
          description: trimmedDesc,
          amountPaisa,
        },
      });

      if (idempotency.existing) {
        return { approval: idempotency.existing.data, isReplay: true };
      }

      // 4. Check active membership count >= 2
      const activeMembers = await tx.groupMembership.findMany({
        where: { groupId, leftAt: null },
        include: { user: { select: { displayName: true } } },
      });
      if (activeMembers.length < 2) {
        throw new HttpError(
          400,
          'not_enough_members',
          'Group needs at least two members for approvals',
        );
      }

      // 5. Check verified balance at creation time
      const ledgerRows = await tx.ledgerEntry.findMany({
        where: { groupId },
        orderBy: { seq: 'asc' },
      });
      const entries = ledgerRows.map(mapLedgerEntryRow);
      sortBySeqAsc(entries);
      const currentBalance = verifiedBalancePaisa(entries);
      if (amountPaisa > currentBalance) {
        throw new HttpError(
          409,
          'insufficient_balance',
          'Insufficient verified balance to create approval request',
        );
      }

      // 6. Snapshot eligible voters = active members excluding requester
      const eligibleVoters = activeMembers.filter((m) => m.id !== memberId);
      if (eligibleVoters.length === 0) {
        throw new HttpError(
          400,
          'not_enough_members',
          'Group needs at least two members for approvals',
        );
      }

      const now = this.getNow();
      const nowNpt = utcInstantToNptWallClock(now);
      const expiresAtNpt = addDays(nowNpt, 7);
      const expiresAt = nptWallClockToUtcInstant(expiresAtNpt);

      const requestId = this.getId();

      // 7. Insert approval request
      const created = await tx.approvalRequest.create({
        data: {
          id: requestId,
          groupId,
          kind,
          requesterMemberId: memberId,
          title: trimmedTitle,
          payee: trimmedPayee,
          description: trimmedDesc,
          amountPaisa: BigInt(amountPaisa),
          status: 'open',
          createdAt: now,
          expiresAt,
          eligibleVoters: {
            create: eligibleVoters.map((ev) => ({ memberId: ev.id })),
          },
        },
        include: {
          requesterMember: {
            include: { user: { select: { displayName: true } } },
          },
          eligibleVoters: true,
          votes: {
            include: { member: { include: { user: true } } },
          },
        },
      });

      // 8. Audit log: approval.created
      await tx.auditLog.create({
        data: {
          id: this.getId(),
          groupId,
          actorUserId,
          action: 'approval.created',
          field: `request:${requestId}`,
          beforeValue: 'none',
          afterValue: `${kind}:${amountPaisa}`,
        },
      });

      const dto = this.mapToDto(created, memberId, now);

      await saveIdempotency(tx, {
        idempotencyKey,
        operation: 'create_approval',
        groupId,
        actorUserId,
        requestHash: idempotency.requestHash,
        responseStatus: 201,
        responseBody: dto,
      });

      return { approval: dto, isReplay: false };
    });
  }

  async getApproval(params: {
    readonly groupId: string;
    readonly approvalId: string;
    readonly viewerMemberId: string;
  }): Promise<ApprovalRequestDto> {
    const { groupId, approvalId, viewerMemberId } = params;
    const now = this.getNow();

    const req = await this.prisma.approvalRequest.findFirst({
      where: { id: approvalId, groupId },
      include: {
        requesterMember: {
          include: { user: { select: { displayName: true } } },
        },
        eligibleVoters: true,
        votes: {
          include: {
            member: {
              include: { user: { select: { displayName: true } } },
            },
          },
          orderBy: { votedAt: 'asc' },
        },
      },
    });

    if (!req) {
      throw new HttpError(404, 'approval_not_found');
    }

    return this.mapToDto(req, viewerMemberId, now);
  }

  async listApprovals(params: {
    readonly groupId: string;
    readonly viewerMemberId: string;
    readonly limit: number;
    readonly cursor: string | null;
    readonly status?: string | undefined;
  }): Promise<{
    readonly items: ApprovalRequestDto[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  }> {
    const { groupId, viewerMemberId, limit, status } = params;
    const now = this.getNow();

    const requests = await this.prisma.approvalRequest.findMany({
      where: { groupId },
      include: {
        requesterMember: {
          include: { user: { select: { displayName: true } } },
        },
        eligibleVoters: true,
        votes: {
          include: {
            member: {
              include: { user: { select: { displayName: true } } },
            },
          },
          orderBy: { votedAt: 'asc' },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    let dtos = requests.map((r) => this.mapToDto(r, viewerMemberId, now));
    if (status) {
      dtos = dtos.filter((d) => d.status === status);
    }

    const page = dtos.slice(0, limit);
    const hasMore = dtos.length > limit;
    const nextCursor =
      hasMore && page.length > 0
        ? Buffer.from(
            JSON.stringify({
              createdAt: page[page.length - 1]!.createdAt,
              id: page[page.length - 1]!.id,
            }),
          ).toString('base64url')
        : null;

    return { items: page, nextCursor, hasMore };
  }

  async vote(
    params: VoteApprovalParams,
  ): Promise<{ approval: ApprovalRequestDto; isReplay: boolean }> {
    const { groupId, approvalId, actorUserId, memberId, vote, idempotencyKey } =
      params;
    const now = this.getNow();

    return withTransaction(this.prisma, async (tx) => {
      await acquireGroupLock(tx, groupId);

      const idempotency = await checkIdempotency<ApprovalRequestDto>(tx, {
        idempotencyKey,
        operation: 'vote_approval',
        groupId,
        actorUserId,
        payload: { groupId, approvalId, memberId, vote },
      });

      if (idempotency.existing) {
        return { approval: idempotency.existing.data, isReplay: true };
      }

      const req = await tx.approvalRequest.findFirst({
        where: { id: approvalId, groupId },
        include: {
          eligibleVoters: true,
          votes: {
            include: {
              member: {
                include: { user: { select: { displayName: true } } },
              },
            },
          },
          requesterMember: {
            include: { user: { select: { displayName: true } } },
          },
        },
      });

      if (!req) {
        throw new HttpError(404, 'approval_not_found');
      }

      const currentStatus = this.computeDynamicStatus(req, now);
      if (currentStatus !== 'open') {
        throw new HttpError(
          409,
          'approval_not_open',
          'Approval request is closed or expired',
        );
      }

      if (req.requesterMemberId === memberId) {
        throw new HttpError(
          403,
          'cannot_vote_on_own_request',
          'You cannot vote on your own request',
        );
      }

      const isEligible = req.eligibleVoters.some(
        (ev) => ev.memberId === memberId,
      );
      if (!isEligible) {
        throw new HttpError(
          403,
          'not_eligible_to_vote',
          'You are not eligible to vote on this request',
        );
      }

      const existingVote = req.votes.find((v) => v.memberId === memberId);
      if (existingVote) {
        throw new HttpError(
          409,
          'already_voted',
          'You have already voted on this request',
        );
      }

      const isApprove = vote === 'approve';
      await tx.approvalVote.create({
        data: {
          requestId: req.id,
          memberId,
          approve: isApprove,
          votedAt: now,
        },
      });

      // Audit log: approval.voted
      await tx.auditLog.create({
        data: {
          id: this.getId(),
          groupId,
          actorUserId,
          action: 'approval.voted',
          field: `request:${req.id}`,
          beforeValue: 'none',
          afterValue: `${memberId}:${vote}`,
        },
      });

      // Re-evaluate status
      const eligible = req.eligibleVoters.length;
      const allApprovals =
        req.votes.filter((v) => v.approve).length + (isApprove ? 1 : 0);
      const allRejections =
        req.votes.filter((v) => !v.approve).length + (!isApprove ? 1 : 0);

      const newOpenStatus = resolveOpenStatus({
        eligible,
        approvals: allApprovals,
        rejections: allRejections,
      });

      if (newOpenStatus === 'approved' || newOpenStatus === 'rejected') {
        await tx.approvalRequest.update({
          where: { id: req.id },
          data: {
            status: newOpenStatus,
            closedAt: now,
          },
        });

        // Audit log: approval.decided
        await tx.auditLog.create({
          data: {
            id: this.getId(),
            groupId,
            actorUserId,
            action: 'approval.decided',
            field: `request:${req.id}`,
            beforeValue: 'open',
            afterValue: newOpenStatus,
          },
        });
      }

      // Reload updated request with votes
      const updated = await tx.approvalRequest.findFirstOrThrow({
        where: { id: req.id },
        include: {
          eligibleVoters: true,
          votes: {
            include: {
              member: {
                include: { user: { select: { displayName: true } } },
              },
            },
            orderBy: { votedAt: 'asc' },
          },
          requesterMember: {
            include: { user: { select: { displayName: true } } },
          },
        },
      });

      const dto = this.mapToDto(updated, memberId, now);

      await saveIdempotency(tx, {
        idempotencyKey,
        operation: 'vote_approval',
        groupId,
        actorUserId,
        requestHash: idempotency.requestHash,
        responseStatus: 200,
        responseBody: dto,
      });

      return { approval: dto, isReplay: false };
    });
  }

  async cancelApproval(
    params: CancelApprovalParams,
  ): Promise<{ approval: ApprovalRequestDto; isReplay: boolean }> {
    const { groupId, approvalId, actorUserId, memberId, idempotencyKey } =
      params;
    const now = this.getNow();

    return withTransaction(this.prisma, async (tx) => {
      await acquireGroupLock(tx, groupId);

      const idempotency = await checkIdempotency<ApprovalRequestDto>(tx, {
        idempotencyKey,
        operation: 'cancel_approval',
        groupId,
        actorUserId,
        payload: { groupId, approvalId, memberId },
      });

      if (idempotency.existing) {
        return { approval: idempotency.existing.data, isReplay: true };
      }

      const req = await tx.approvalRequest.findFirst({
        where: { id: approvalId, groupId },
        include: {
          eligibleVoters: true,
          votes: {
            include: {
              member: {
                include: { user: { select: { displayName: true } } },
              },
            },
          },
          requesterMember: {
            include: { user: { select: { displayName: true } } },
          },
        },
      });

      if (!req) {
        throw new HttpError(404, 'approval_not_found');
      }

      if (req.requesterMemberId !== memberId) {
        throw new HttpError(403, 'forbidden');
      }

      const currentStatus = this.computeDynamicStatus(req, now);
      if (currentStatus !== 'open') {
        throw new HttpError(
          409,
          'approval_not_open',
          'Approval request is closed or expired',
        );
      }

      await tx.approvalRequest.update({
        where: { id: req.id },
        data: {
          status: 'cancelled',
          closedAt: now,
        },
      });

      await tx.auditLog.create({
        data: {
          id: this.getId(),
          groupId,
          actorUserId,
          action: 'approval.cancelled',
          field: `request:${req.id}`,
          beforeValue: 'open',
          afterValue: 'cancelled',
        },
      });

      const updated = await tx.approvalRequest.findFirstOrThrow({
        where: { id: req.id },
        include: {
          eligibleVoters: true,
          votes: {
            include: {
              member: {
                include: { user: { select: { displayName: true } } },
              },
            },
          },
          requesterMember: {
            include: { user: { select: { displayName: true } } },
          },
        },
      });

      const dto = this.mapToDto(updated, memberId, now);

      await saveIdempotency(tx, {
        idempotencyKey,
        operation: 'cancel_approval',
        groupId,
        actorUserId,
        requestHash: idempotency.requestHash,
        responseStatus: 200,
        responseBody: dto,
      });

      return { approval: dto, isReplay: false };
    });
  }

  async executeApproval(
    params: ExecuteApprovalParams,
  ): Promise<{ approval: ApprovalRequestDto; isReplay: boolean }> {
    const {
      groupId,
      approvalId,
      actorUserId,
      memberId,
      method,
      idempotencyKey,
    } = params;
    const now = this.getNow();

    return withTransaction(this.prisma, async (tx) => {
      await acquireGroupLock(tx, groupId);

      const idempotency = await checkIdempotency<ApprovalRequestDto>(tx, {
        idempotencyKey,
        operation: 'execute_approval',
        groupId,
        actorUserId,
        payload: { groupId, approvalId, memberId, method },
      });

      if (idempotency.existing) {
        return { approval: idempotency.existing.data, isReplay: true };
      }

      // Verify caller is treasurer
      const callerMembership = await tx.groupMembership.findUnique({
        where: { id: memberId },
      });
      if (
        !callerMembership ||
        callerMembership.groupId !== groupId ||
        !callerMembership.isTreasurer ||
        callerMembership.leftAt !== null
      ) {
        throw new HttpError(403, 'forbidden');
      }

      const req = await tx.approvalRequest.findFirst({
        where: { id: approvalId, groupId },
        include: {
          eligibleVoters: true,
          votes: {
            include: {
              member: {
                include: { user: { select: { displayName: true } } },
              },
            },
          },
          requesterMember: {
            include: { user: { select: { displayName: true } } },
          },
        },
      });

      if (!req) {
        throw new HttpError(404, 'approval_not_found');
      }

      if (req.status === 'executed' || req.executedEntryId !== null) {
        throw new HttpError(
          409,
          'approval_already_executed',
          'This approval request has already been recorded',
        );
      }

      const currentStatus = this.computeDynamicStatus(req, now);
      if (currentStatus !== 'approved') {
        throw new HttpError(
          409,
          'approval_not_approved',
          'Request has not reached approval threshold',
        );
      }

      // Separation of duties: requester cannot execute own request when another active treasurer exists
      const activeTreasurers = await tx.groupMembership.findMany({
        where: { groupId, isTreasurer: true, leftAt: null },
      });
      if (req.requesterMemberId === memberId && activeTreasurers.length > 1) {
        throw new HttpError(
          403,
          'cannot_execute_own_request',
          'You cannot execute your own request when another treasurer exists',
        );
      }

      // Note formatting matching Flutter
      const note = req.description
        ? `Payee: ${req.payee}; ${req.description}`
        : `Payee: ${req.payee}`;
      const truncatedNote = note.slice(0, 200);

      // Post verified ledger entry
      let entry: { id: string };
      try {
        entry = await postLedgerEntry(tx, {
          groupId,
          actorMemberId: memberId,
          actorUserId,
          kind: req.kind as ActivityKind,
          title: req.title,
          magnitudePaisa: bigintToPaisa(req.amountPaisa),
          occurredAt: now,
          paymentMethod: method ?? 'bankTransfer',
          note: truncatedNote,
        });
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err.name === 'InsufficientBalanceError' ||
            err.message.includes('Insufficient verified balance'))
        ) {
          throw new HttpError(
            409,
            'insufficient_balance',
            'Insufficient verified balance to record transaction',
          );
        }
        throw err;
      }

      // Update approval request
      await tx.approvalRequest.update({
        where: { id: req.id },
        data: {
          status: 'executed',
          closedAt: now,
          executedEntryId: entry.id,
          executedByMemberId: memberId,
        },
      });

      // Audit log: approval.executed
      await tx.auditLog.create({
        data: {
          id: this.getId(),
          groupId,
          actorUserId,
          action: 'approval.executed',
          field: `request:${req.id}`,
          beforeValue: 'approved',
          afterValue: `executed:${entry.id}`,
        },
      });

      const updated = await tx.approvalRequest.findFirstOrThrow({
        where: { id: req.id },
        include: {
          eligibleVoters: true,
          votes: {
            include: {
              member: {
                include: { user: { select: { displayName: true } } },
              },
            },
            orderBy: { votedAt: 'asc' },
          },
          requesterMember: {
            include: { user: { select: { displayName: true } } },
          },
        },
      });

      const dto = this.mapToDto(updated, memberId, now);

      await saveIdempotency(tx, {
        idempotencyKey,
        operation: 'execute_approval',
        groupId,
        actorUserId,
        requestHash: idempotency.requestHash,
        responseStatus: 200,
        responseBody: dto,
      });

      return { approval: dto, isReplay: false };
    });
  }
}
