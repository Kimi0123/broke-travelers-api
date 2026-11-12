import type { PrismaClient } from '@prisma/client';
import type { PaymentStatus } from '../domain/enums.js';
import { monthStart } from '../domain/month-math.js';
import { deriveObligationStatus } from '../domain/obligation-status.js';
import { HttpError } from '../http/errors.js';
import { withTransaction } from '../infrastructure/db/client.js';
import { generateId } from '../infrastructure/db/ids.js';
import {
  mapSubmissionToLedgerEntry,
  sortBySeqAsc,
} from '../infrastructure/db/mappers.js';
import { utcInstantToNptWallClock } from '../infrastructure/time/npt.js';

export interface GroupMemberResponse {
  readonly id: string;
  readonly displayName: string;
  readonly roles: string[];
  readonly joinedAt: string;
  readonly isCurrentUser: boolean;
  readonly currentPeriodStatus: PaymentStatus;
}

export interface UpdateMemberRoleInput {
  readonly isTreasurer: boolean;
}

export interface MembersServiceDeps {
  readonly prisma: PrismaClient;
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
}

function computeRoles(isOwner: boolean, isTreasurer: boolean): string[] {
  const roles: string[] = [];
  if (isOwner) roles.push('owner');
  if (isTreasurer) roles.push('treasurer');
  if (roles.length === 0) roles.push('member');
  return roles;
}

export class MembersService {
  private readonly prisma: PrismaClient;
  private readonly clock?: (() => Date) | undefined;
  private readonly idGenerator?: (() => string) | undefined;

  constructor(deps: MembersServiceDeps) {
    this.prisma = deps.prisma;
    this.clock = deps.clock;
    this.idGenerator = deps.idGenerator;
  }

  async listMembers(
    groupId: string,
    viewerUserId: string,
  ): Promise<GroupMemberResponse[]> {
    const viewerMembership = await this.prisma.groupMembership.findFirst({
      where: {
        groupId,
        userId: viewerUserId,
        leftAt: null,
      },
    });

    if (!viewerMembership) {
      throw new HttpError(404, 'group_not_found');
    }

    const activeMemberships = await this.prisma.groupMembership.findMany({
      where: {
        groupId,
        leftAt: null,
      },
      include: {
        user: true,
      },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    });

    const now = this.clock ? this.clock() : new Date();
    const nptNow = utcInstantToNptWallClock(now);
    const currentPeriodStart = monthStart(nptNow);

    const rawSubmissions = await this.prisma.paymentSubmission.findMany({
      where: { groupId },
      orderBy: { seq: 'asc' },
    });
    const entries = sortBySeqAsc(
      rawSubmissions.map(mapSubmissionToLedgerEntry),
    );

    return activeMemberships.map((m) => {
      const roles = computeRoles(m.isOwner, m.isTreasurer);
      const status = deriveObligationStatus({
        entries,
        memberId: m.id,
        periodStart: currentPeriodStart,
        anchorPeriodStart: currentPeriodStart,
      });

      return {
        id: m.id,
        displayName: m.user.displayName,
        roles,
        joinedAt: m.joinedAt.toISOString(),
        isCurrentUser: m.userId === viewerUserId,
        currentPeriodStatus: status,
      };
    });
  }

  async updateMemberRole(
    groupId: string,
    memberId: string,
    actorUserId: string,
    input: UpdateMemberRoleInput,
  ): Promise<GroupMemberResponse> {
    const actorMembership = await this.prisma.groupMembership.findFirst({
      where: {
        groupId,
        userId: actorUserId,
        leftAt: null,
      },
    });

    if (!actorMembership) {
      throw new HttpError(404, 'group_not_found');
    }

    if (!actorMembership.isOwner) {
      throw new HttpError(403, 'forbidden');
    }

    const target = await this.prisma.groupMembership.findFirst({
      where: {
        id: memberId,
        groupId,
        leftAt: null,
      },
      include: {
        user: true,
      },
    });

    if (!target) {
      throw new HttpError(404, 'member_not_found');
    }

    if (target.isOwner) {
      throw new HttpError(409, 'cannot_remove_owner');
    }

    if (!input.isTreasurer && target.isTreasurer) {
      const otherTreasurersCount = await this.prisma.groupMembership.count({
        where: {
          groupId,
          leftAt: null,
          isTreasurer: true,
          id: { not: memberId },
        },
      });

      if (otherTreasurersCount === 0) {
        throw new HttpError(409, 'cannot_remove_last_treasurer');
      }
    }

    return withTransaction(this.prisma, async (tx) => {
      const updated = await tx.groupMembership.update({
        where: { id: memberId },
        data: { isTreasurer: input.isTreasurer },
        include: { user: true },
      });

      const now = this.clock ? this.clock() : new Date();
      const auditLogId = this.idGenerator ? this.idGenerator() : generateId();
      await tx.auditLog.create({
        data: {
          id: auditLogId,
          groupId,
          actorUserId,
          action: 'member_role_updated',
          field: `member:${memberId}:is_treasurer`,
          beforeValue: String(target.isTreasurer),
          afterValue: String(input.isTreasurer),
          createdAt: now,
        },
      });

      const nptNow = utcInstantToNptWallClock(now);
      const currentPeriodStart = monthStart(nptNow);

      const rawSubmissions = await tx.paymentSubmission.findMany({
        where: { groupId },
        orderBy: { seq: 'asc' },
      });
      const entries = sortBySeqAsc(
        rawSubmissions.map(mapSubmissionToLedgerEntry),
      );
      const status = deriveObligationStatus({
        entries,
        memberId: updated.id,
        periodStart: currentPeriodStart,
        anchorPeriodStart: currentPeriodStart,
      });

      return {
        id: updated.id,
        displayName: updated.user.displayName,
        roles: computeRoles(updated.isOwner, updated.isTreasurer),
        joinedAt: updated.joinedAt.toISOString(),
        isCurrentUser: updated.userId === actorUserId,
        currentPeriodStatus: status,
      };
    });
  }

  async removeMember(
    groupId: string,
    memberId: string,
    actorUserId: string,
  ): Promise<void> {
    const actorMembership = await this.prisma.groupMembership.findFirst({
      where: {
        groupId,
        userId: actorUserId,
        leftAt: null,
      },
    });

    if (!actorMembership) {
      throw new HttpError(404, 'group_not_found');
    }

    if (!actorMembership.isOwner) {
      throw new HttpError(403, 'forbidden');
    }

    const target = await this.prisma.groupMembership.findFirst({
      where: {
        id: memberId,
        groupId,
        leftAt: null,
      },
    });

    if (!target) {
      throw new HttpError(404, 'member_not_found');
    }

    // Invariant 1: Cannot remove owner
    if (target.isOwner) {
      throw new HttpError(409, 'cannot_remove_owner');
    }

    // Invariant 2: Pending payments
    const pendingCount = await this.prisma.paymentSubmission.count({
      where: {
        groupId,
        memberId,
        status: 'pending',
      },
    });

    if (pendingCount > 0) {
      throw new HttpError(409, 'member_has_pending_payments');
    }

    // Invariant 3: Last treasurer
    if (target.isTreasurer) {
      const otherTreasurersCount = await this.prisma.groupMembership.count({
        where: {
          groupId,
          leftAt: null,
          isTreasurer: true,
          id: { not: memberId },
        },
      });

      if (otherTreasurersCount === 0) {
        throw new HttpError(409, 'cannot_remove_last_treasurer');
      }
    }

    await withTransaction(this.prisma, async (tx) => {
      const now = this.clock ? this.clock() : new Date();
      await tx.groupMembership.update({
        where: { id: memberId },
        data: { leftAt: now },
      });

      const auditLogId = this.idGenerator ? this.idGenerator() : generateId();
      await tx.auditLog.create({
        data: {
          id: auditLogId,
          groupId,
          actorUserId,
          action: 'member_removed',
          field: 'membership',
          beforeValue: 'active',
          afterValue: 'left',
          createdAt: now,
        },
      });
    });
  }
}
