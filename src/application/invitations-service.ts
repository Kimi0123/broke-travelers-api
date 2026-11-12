import { randomInt } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { generateId } from '../infrastructure/db/ids.js';
import { withTransaction } from '../infrastructure/db/client.js';
import { HttpError } from '../http/errors.js';
import { IdempotencyConflictError } from './errors.js';
import type { GroupResponse } from './groups-service.js';
import {
  checkIdempotency,
  computeRequestHash,
  saveIdempotency,
} from './idempotency.js';

export const INVITATION_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateInvitationCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) {
    const idx = randomInt(0, INVITATION_ALPHABET.length);
    code += INVITATION_ALPHABET[idx];
  }
  return code;
}

export interface InvitationResponse {
  readonly id: string;
  readonly code: string;
  readonly status: 'pending' | 'accepted' | 'revoked' | 'expired';
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface AcceptInvitationResult {
  readonly group: GroupResponse;
  readonly membershipId: string;
}

export interface InvitationsServiceDeps {
  readonly prisma: PrismaClient;
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
}

export class InvitationsService {
  private readonly prisma: PrismaClient;
  private readonly clock?: (() => Date) | undefined;
  private readonly idGenerator?: (() => string) | undefined;

  constructor(deps: InvitationsServiceDeps) {
    this.prisma = deps.prisma;
    this.clock = deps.clock;
    this.idGenerator = deps.idGenerator;
  }

  async createInvitation(
    groupId: string,
    userId: string,
    idempotencyKey: string,
  ): Promise<{
    invitation: InvitationResponse;
    isReplay: boolean;
    status: number;
  }> {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new HttpError(400, 'idempotency_key_required');
    }

    const membership = await this.prisma.groupMembership.findFirst({
      where: {
        groupId,
        userId,
        leftAt: null,
      },
    });

    if (!membership) {
      throw new HttpError(404, 'group_not_found');
    }

    if (!membership.isOwner) {
      throw new HttpError(403, 'forbidden');
    }

    return withTransaction(this.prisma, async (tx) => {
      const idempotencyResult = await checkIdempotency<InvitationResponse>(tx, {
        idempotencyKey,
        operation: 'create_invitation',
        groupId,
        actorUserId: userId,
        payload: { groupId },
      });

      if (idempotencyResult.existing) {
        return {
          invitation: idempotencyResult.existing.data,
          isReplay: true,
          status: idempotencyResult.existing.status,
        };
      }

      const now = this.clock ? this.clock() : new Date();
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const code = generateInvitationCode();
      const invitationId = this.idGenerator ? this.idGenerator() : generateId();
      const auditLogId = this.idGenerator ? this.idGenerator() : generateId();

      const created = await tx.invitation.create({
        data: {
          id: invitationId,
          groupId,
          code,
          status: 'pending',
          createdByMemberId: membership.id,
          createdAt: now,
          expiresAt,
        },
      });

      await tx.auditLog.create({
        data: {
          id: auditLogId,
          groupId,
          actorUserId: userId,
          action: 'invitation_created',
          field: 'invitation',
          beforeValue: null,
          afterValue: JSON.stringify({
            id: created.id,
            code: created.code,
            expiresAt: created.expiresAt.toISOString(),
          }),
          createdAt: now,
        },
      });

      const responseBody: InvitationResponse = {
        id: created.id,
        code: created.code,
        status: 'pending',
        expiresAt: created.expiresAt.toISOString(),
        createdAt: created.createdAt.toISOString(),
      };

      await saveIdempotency(tx, {
        idempotencyKey,
        operation: 'create_invitation',
        groupId,
        actorUserId: userId,
        requestHash: idempotencyResult.requestHash,
        responseStatus: 201,
        responseBody,
      });

      return {
        invitation: responseBody,
        isReplay: false,
        status: 201,
      };
    });
  }

  async getInvitations(
    groupId: string,
    userId: string,
  ): Promise<InvitationResponse[]> {
    const membership = await this.prisma.groupMembership.findFirst({
      where: {
        groupId,
        userId,
        leftAt: null,
      },
    });

    if (!membership) {
      throw new HttpError(404, 'group_not_found');
    }

    if (!membership.isOwner) {
      throw new HttpError(403, 'forbidden');
    }

    const invitations = await this.prisma.invitation.findMany({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
    });

    const now = this.clock ? this.clock() : new Date();

    return invitations.map((inv) => {
      let dynamicStatus: 'pending' | 'accepted' | 'revoked' | 'expired';
      if (inv.status === 'accepted') {
        dynamicStatus = 'accepted';
      } else if (inv.status === 'revoked') {
        dynamicStatus = 'revoked';
      } else if (inv.expiresAt < now) {
        dynamicStatus = 'expired';
      } else {
        dynamicStatus = 'pending';
      }

      return {
        id: inv.id,
        code: inv.code,
        status: dynamicStatus,
        expiresAt: inv.expiresAt.toISOString(),
        createdAt: inv.createdAt.toISOString(),
      };
    });
  }

  async revokeInvitation(
    groupId: string,
    invitationId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.prisma.groupMembership.findFirst({
      where: {
        groupId,
        userId,
        leftAt: null,
      },
    });

    if (!membership) {
      throw new HttpError(404, 'group_not_found');
    }

    if (!membership.isOwner) {
      throw new HttpError(403, 'forbidden');
    }

    const invitation = await this.prisma.invitation.findFirst({
      where: {
        id: invitationId,
        groupId,
      },
    });

    if (!invitation) {
      throw new HttpError(404, 'not_found');
    }

    const now = this.clock ? this.clock() : new Date();

    if (
      invitation.status === 'accepted' ||
      invitation.status === 'revoked' ||
      invitation.expiresAt < now
    ) {
      throw new HttpError(409, 'invitation_not_revocable');
    }

    await withTransaction(this.prisma, async (tx) => {
      await tx.invitation.update({
        where: { id: invitationId },
        data: { status: 'revoked' },
      });

      const auditLogId = this.idGenerator ? this.idGenerator() : generateId();
      await tx.auditLog.create({
        data: {
          id: auditLogId,
          groupId,
          actorUserId: userId,
          action: 'invitation_revoked',
          field: 'status',
          beforeValue: invitation.status,
          afterValue: 'revoked',
          createdAt: now,
        },
      });
    });
  }

  async acceptInvitation(
    userId: string,
    idempotencyKey: string,
    rawCode: string,
  ): Promise<{
    data: AcceptInvitationResult;
    isReplay: boolean;
    status: number;
  }> {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new HttpError(400, 'idempotency_key_required');
    }

    const normalizedCode = (rawCode ?? '').trim().toUpperCase();

    // 0. Early idempotency check (exact replay returns cached response without rate-limit or state conflicts)
    const earlyCheck = await this.prisma.idempotencyKey.findFirst({
      where: {
        idempotencyKey,
        operation: 'accept_invitation',
        groupId: null,
        actorUserId: userId,
      },
    });

    if (earlyCheck) {
      const requestHash = computeRequestHash({ code: normalizedCode });
      if (earlyCheck.requestHash !== requestHash) {
        throw new IdempotencyConflictError(
          `Idempotency key '${idempotencyKey}' was already used with a different request payload`,
        );
      }
      return {
        data: earlyCheck.responseBody as unknown as AcceptInvitationResult,
        isReplay: true,
        status: earlyCheck.responseStatus,
      };
    }

    const now = this.clock ? this.clock() : new Date();

    // 1. Brute-force lockout check (5 failures in 5 minutes)
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const recentFailures = await this.prisma.invitationAttempt.findMany({
      where: {
        userId,
        succeeded: false,
        attemptedAt: { gte: fiveMinutesAgo },
      },
      orderBy: { attemptedAt: 'asc' },
    });

    if (recentFailures.length >= 5) {
      const oldestFailure = recentFailures[0]!;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(
          (oldestFailure.attemptedAt.getTime() +
            5 * 60 * 1000 -
            now.getTime()) /
            1000,
        ),
      );

      // Record another failure
      await this.prisma.invitationAttempt.create({
        data: {
          id: this.idGenerator ? this.idGenerator() : generateId(),
          userId,
          attemptedAt: now,
          succeeded: false,
        },
      });

      throw new HttpError(429, 'too_many_attempts', undefined, {
        'Retry-After': String(retryAfterSeconds),
      });
    }

    // 2. Validate format and look up code
    if (normalizedCode.length !== 8) {
      await this.prisma.invitationAttempt.create({
        data: {
          id: this.idGenerator ? this.idGenerator() : generateId(),
          userId,
          attemptedAt: now,
          succeeded: false,
        },
      });
      throw new HttpError(400, 'invalid_invitation_code');
    }

    const invitation = await this.prisma.invitation.findUnique({
      where: { code: normalizedCode },
      include: { group: true },
    });

    if (
      !invitation ||
      invitation.status !== 'pending' ||
      invitation.expiresAt < now
    ) {
      await this.prisma.invitationAttempt.create({
        data: {
          id: this.idGenerator ? this.idGenerator() : generateId(),
          userId,
          attemptedAt: now,
          succeeded: false,
        },
      });
      throw new HttpError(400, 'invalid_invitation_code');
    }

    // 3. Check if caller already belongs to ANY active group
    const existingMembership = await this.prisma.groupMembership.findFirst({
      where: {
        userId,
        leftAt: null,
      },
    });

    if (existingMembership) {
      throw new HttpError(409, 'already_in_group');
    }

    // 4. Atomically accept in transaction
    return withTransaction(this.prisma, async (tx) => {
      const idempotencyResult = await checkIdempotency<AcceptInvitationResult>(
        tx,
        {
          idempotencyKey,
          operation: 'accept_invitation',
          groupId: null,
          actorUserId: userId,
          payload: { code: normalizedCode },
        },
      );

      if (idempotencyResult.existing) {
        return {
          data: idempotencyResult.existing.data,
          isReplay: true,
          status: idempotencyResult.existing.status,
        };
      }

      // Re-verify invitation row with explicit row-level lock (FOR UPDATE)
      const lockedRows = await tx.$queryRaw<
        Array<{ id: string; status: string; expires_at: Date }>
      >`
        SELECT id, status, expires_at FROM invitations WHERE id = ${invitation.id}::uuid FOR UPDATE
      `;
      const lockedInv = lockedRows[0];

      if (
        !lockedInv ||
        lockedInv.status !== 'pending' ||
        new Date(lockedInv.expires_at) < now
      ) {
        throw new HttpError(400, 'invalid_invitation_code');
      }

      // Re-verify user active membership
      const txExisting = await tx.groupMembership.findFirst({
        where: {
          userId,
          leftAt: null,
        },
      });
      if (txExisting) {
        throw new HttpError(409, 'already_in_group');
      }

      const membershipId = this.idGenerator ? this.idGenerator() : generateId();
      await tx.groupMembership.create({
        data: {
          id: membershipId,
          groupId: invitation.groupId,
          userId,
          isOwner: false,
          isTreasurer: false,
          joinedAt: now,
          createdAt: now,
        },
      });

      await tx.invitation.update({
        where: { id: invitation.id },
        data: {
          status: 'accepted',
          acceptedByUserId: userId,
        },
      });

      // Record successful attempt
      await tx.invitationAttempt.create({
        data: {
          id: this.idGenerator ? this.idGenerator() : generateId(),
          userId,
          attemptedAt: now,
          succeeded: true,
        },
      });

      // Opportunistically delete attempts older than 24 hours
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      await tx.invitationAttempt.deleteMany({
        where: {
          userId,
          attemptedAt: { lt: oneDayAgo },
        },
      });

      const memberCount = await tx.groupMembership.count({
        where: {
          groupId: invitation.groupId,
          leftAt: null,
        },
      });

      const auditLogId = this.idGenerator ? this.idGenerator() : generateId();
      await tx.auditLog.create({
        data: {
          id: auditLogId,
          groupId: invitation.groupId,
          actorUserId: userId,
          action: 'invitation_accepted',
          field: 'membership',
          beforeValue: null,
          afterValue: JSON.stringify({ membershipId, userId }),
          createdAt: now,
        },
      });

      const responseBody: AcceptInvitationResult = {
        group: {
          id: invitation.group.id,
          name: invitation.group.name,
          monthlyContributionPaisa: Number(invitation.group.expectedPaisa),
          dueDay: invitation.group.dueDay,
          memberCount,
          createdAt: invitation.group.createdAt.toISOString(),
        },
        membershipId,
      };

      await saveIdempotency(tx, {
        idempotencyKey,
        operation: 'accept_invitation',
        groupId: null,
        actorUserId: userId,
        requestHash: idempotencyResult.requestHash,
        responseStatus: 200,
        responseBody,
      });

      return {
        data: responseBody,
        isReplay: false,
        status: 200,
      };
    });
  }
}
