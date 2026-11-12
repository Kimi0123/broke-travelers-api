import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../errors.js';

export interface RequestMembership {
  readonly membershipId: string;
  readonly isOwner: boolean;
  readonly isTreasurer: boolean;
}

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      membership?: RequestMembership;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

/**
 * Middleware that verifies the caller is an active member of :groupId.
 * Attaches req.membership = { membershipId, isOwner, isTreasurer }.
 * Callers who are not active members receive 404 group_not_found (never 403)
 * to prevent group enumeration.
 */
export function loadMembership(prisma: PrismaClient) {
  return async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const rawGroupId = req.params['groupId'];
    const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
    if (!groupId) {
      throw new HttpError(404, 'group_not_found');
    }

    const userId = req.user?.id;
    if (!userId) {
      throw new HttpError(401, 'unauthenticated');
    }

    const membership = await prisma.groupMembership.findFirst({
      where: {
        groupId,
        userId,
        leftAt: null,
      },
    });

    if (!membership) {
      throw new HttpError(404, 'group_not_found');
    }

    req.membership = {
      membershipId: membership.id,
      isOwner: membership.isOwner,
      isTreasurer: membership.isTreasurer,
    };

    next();
  };
}

/**
 * Enforces that the caller has owner privileges in the current group context.
 * Assumes loadMembership has already executed.
 */
export function requireOwner(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.membership?.isOwner) {
    throw new HttpError(403, 'forbidden');
  }
  next();
}

/**
 * Enforces that the caller has treasurer privileges in the current group context.
 * Assumes loadMembership has already executed.
 */
export function requireTreasurer(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.membership?.isTreasurer) {
    throw new HttpError(403, 'forbidden');
  }
  next();
}
