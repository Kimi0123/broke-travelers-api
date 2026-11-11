import type { PrismaClient } from '@prisma/client';
import { generateId } from '../infrastructure/db/ids.js';
import { withTransaction } from '../infrastructure/db/client.js';
import { HttpError } from '../http/errors.js';
import { checkIdempotency, saveIdempotency } from './idempotency.js';

export interface GroupResponse {
  readonly id: string;
  readonly name: string;
  readonly monthlyContributionPaisa: number;
  readonly dueDay: number;
  readonly memberCount: number;
  readonly createdAt: string;
}

export interface CreateGroupInput {
  readonly name: string;
  readonly monthlyContributionPaisa: number;
  readonly dueDay: number;
}

export interface UpdateGroupSettingsInput {
  readonly name?: string | undefined;
  readonly dueDay?: number | undefined;
  readonly monthlyContributionPaisa?: unknown;
}

export interface GroupsServiceDeps {
  readonly prisma: PrismaClient;
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
}

export class GroupsService {
  private readonly prisma: PrismaClient;
  private readonly clock?: (() => Date) | undefined;
  private readonly idGenerator?: (() => string) | undefined;

  constructor(deps: GroupsServiceDeps) {
    this.prisma = deps.prisma;
    this.clock = deps.clock;
    this.idGenerator = deps.idGenerator;
  }

  async createGroup(
    userId: string,
    idempotencyKey: string,
    input: CreateGroupInput,
  ): Promise<{ group: GroupResponse; isReplay: boolean; status: number }> {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new HttpError(400, 'idempotency_key_required');
    }

    const trimmedName = input.name ? input.name.trim() : '';
    if (trimmedName.length < 1 || trimmedName.length > 100) {
      throw new HttpError(400, 'invalid_group_settings');
    }

    if (
      typeof input.monthlyContributionPaisa !== 'number' ||
      !Number.isInteger(input.monthlyContributionPaisa) ||
      input.monthlyContributionPaisa <= 0 ||
      input.monthlyContributionPaisa > 10_000_000_00
    ) {
      throw new HttpError(400, 'invalid_group_settings');
    }

    if (
      typeof input.dueDay !== 'number' ||
      !Number.isInteger(input.dueDay) ||
      input.dueDay < 1 ||
      input.dueDay > 28
    ) {
      throw new HttpError(400, 'invalid_group_settings');
    }

    return withTransaction(this.prisma, async (tx) => {
      const idempotencyResult = await checkIdempotency<GroupResponse>(tx, {
        idempotencyKey,
        operation: 'create_group',
        groupId: null,
        actorUserId: userId,
        payload: input,
      });

      if (idempotencyResult.existing) {
        return {
          group: idempotencyResult.existing.data,
          isReplay: true,
          status: idempotencyResult.existing.status,
        };
      }

      const groupId = this.idGenerator ? this.idGenerator() : generateId();
      const membershipId = this.idGenerator ? this.idGenerator() : generateId();
      const auditLogId = this.idGenerator ? this.idGenerator() : generateId();
      const now = this.clock ? this.clock() : new Date();

      const createdGroup = await tx.group.create({
        data: {
          id: groupId,
          name: trimmedName,
          expectedPaisa: BigInt(input.monthlyContributionPaisa),
          dueDay: input.dueDay,
          createdByUserId: userId,
          createdAt: now,
          updatedAt: now,
        },
      });

      await tx.groupMembership.create({
        data: {
          id: membershipId,
          groupId: createdGroup.id,
          userId,
          isOwner: true,
          isTreasurer: true,
          joinedAt: now,
          createdAt: now,
        },
      });

      await tx.auditLog.create({
        data: {
          id: auditLogId,
          groupId: createdGroup.id,
          actorUserId: userId,
          action: 'group_created',
          field: 'group',
          beforeValue: null,
          afterValue: JSON.stringify({
            name: createdGroup.name,
            monthlyContributionPaisa: Number(createdGroup.expectedPaisa),
            dueDay: createdGroup.dueDay,
          }),
          createdAt: now,
        },
      });

      const responseBody: GroupResponse = {
        id: createdGroup.id,
        name: createdGroup.name,
        monthlyContributionPaisa: Number(createdGroup.expectedPaisa),
        dueDay: createdGroup.dueDay,
        memberCount: 1,
        createdAt: createdGroup.createdAt.toISOString(),
      };

      await saveIdempotency(tx, {
        idempotencyKey,
        operation: 'create_group',
        groupId: null,
        actorUserId: userId,
        requestHash: idempotencyResult.requestHash,
        responseStatus: 201,
        responseBody,
      });

      return {
        group: responseBody,
        isReplay: false,
        status: 201,
      };
    });
  }

  async getGroup(groupId: string, userId: string): Promise<GroupResponse> {
    const membership = await this.prisma.groupMembership.findFirst({
      where: {
        groupId,
        userId,
        leftAt: null,
      },
      include: {
        group: {
          include: {
            _count: {
              select: {
                memberships: {
                  where: { leftAt: null },
                },
              },
            },
          },
        },
      },
    });

    if (!membership) {
      throw new HttpError(404, 'group_not_found');
    }

    return {
      id: membership.group.id,
      name: membership.group.name,
      monthlyContributionPaisa: Number(membership.group.expectedPaisa),
      dueDay: membership.group.dueDay,
      memberCount: membership.group._count.memberships,
      createdAt: membership.group.createdAt.toISOString(),
    };
  }

  async updateGroupSettings(
    groupId: string,
    userId: string,
    input: UpdateGroupSettingsInput,
  ): Promise<GroupResponse> {
    if (input.monthlyContributionPaisa !== undefined) {
      throw new HttpError(400, 'invalid_group_settings');
    }

    if (input.name === undefined && input.dueDay === undefined) {
      throw new HttpError(400, 'invalid_group_settings');
    }

    let trimmedName: string | undefined;
    if (input.name !== undefined) {
      trimmedName = input.name.trim();
      if (trimmedName.length < 1 || trimmedName.length > 100) {
        throw new HttpError(400, 'invalid_group_settings');
      }
    }

    if (input.dueDay !== undefined) {
      if (
        typeof input.dueDay !== 'number' ||
        !Number.isInteger(input.dueDay) ||
        input.dueDay < 1 ||
        input.dueDay > 28
      ) {
        throw new HttpError(400, 'invalid_group_settings');
      }
    }

    const membership = await this.prisma.groupMembership.findFirst({
      where: {
        groupId,
        userId,
        leftAt: null,
      },
      include: {
        group: true,
      },
    });

    if (!membership) {
      throw new HttpError(404, 'group_not_found');
    }

    if (!membership.isOwner) {
      throw new HttpError(403, 'forbidden');
    }

    const currentGroup = membership.group;

    return withTransaction(this.prisma, async (tx) => {
      const now = this.clock ? this.clock() : new Date();
      const updated = await tx.group.update({
        where: { id: groupId },
        data: {
          ...(trimmedName !== undefined ? { name: trimmedName } : {}),
          ...(input.dueDay !== undefined ? { dueDay: input.dueDay } : {}),
          updatedAt: now,
        },
        include: {
          _count: {
            select: {
              memberships: {
                where: { leftAt: null },
              },
            },
          },
        },
      });

      const auditLogId = this.idGenerator ? this.idGenerator() : generateId();
      await tx.auditLog.create({
        data: {
          id: auditLogId,
          groupId,
          actorUserId: userId,
          action: 'group_settings_updated',
          field: 'settings',
          beforeValue: JSON.stringify({
            name: currentGroup.name,
            dueDay: currentGroup.dueDay,
          }),
          afterValue: JSON.stringify({
            name: updated.name,
            dueDay: updated.dueDay,
          }),
          createdAt: now,
        },
      });

      return {
        id: updated.id,
        name: updated.name,
        monthlyContributionPaisa: Number(updated.expectedPaisa),
        dueDay: updated.dueDay,
        memberCount: updated._count.memberships,
        createdAt: updated.createdAt.toISOString(),
      };
    });
  }
}
