import * as net from 'node:net';
import dotenv from 'dotenv';
import pg from 'pg';
import type { PrismaClient } from '@prisma/client';
import { generateId } from '../../src/infrastructure/db/ids.js';
import {
  disconnectPrismaClient,
  getPrismaClient,
} from '../../src/infrastructure/db/client.js';

dotenv.config();

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://api_user:api_user_local_dev_secret@localhost:5533/broke_travelers_test?schema=public';

export const TEST_DIRECT_URL =
  process.env['TEST_DIRECT_URL'] ??
  'postgresql://migration_owner:migration_owner_local_dev_secret@localhost:5533/broke_travelers_test?schema=public';

function parseHostPort(urlStr: string): { host: string; port: number } {
  try {
    const parsed = new URL(urlStr);
    return {
      host: parsed.hostname || 'localhost',
      port: Number(parsed.port) || 5432,
    };
  } catch {
    return { host: 'localhost', port: 5533 };
  }
}

async function probeTcp(
  host: string,
  port: number,
  timeoutMs = 2000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let finished = false;

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      finished = true;
      socket.destroy();
      resolve();
    });

    socket.on('timeout', () => {
      if (!finished) {
        finished = true;
        socket.destroy();
        reject(
          new Error(
            `TCP connection to ${host}:${port} timed out after ${timeoutMs}ms`,
          ),
        );
      }
    });

    socket.on('error', (err) => {
      if (!finished) {
        finished = true;
        socket.destroy();
        reject(err);
      }
    });

    socket.connect(port, host);
  });
}

async function checkPrismaClient(): Promise<void> {
  try {
    const prismaModule = await import('@prisma/client');
    if (!prismaModule.PrismaClient) {
      throw new Error(
        'PrismaClient constructor is not exported by @prisma/client',
      );
    }
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[PREFLIGHT CHECK FAILED] Prisma client is missing or cannot be imported.\n` +
        `Please run: npm run prisma:generate\n` +
        `Details: ${details}`,
      { cause: err },
    );
  }
}

async function checkDatabaseReachable(): Promise<void> {
  const dbUrl = TEST_DATABASE_URL;
  const { host: dbHost, port: dbPort } = parseHostPort(dbUrl);

  try {
    await probeTcp(dbHost, dbPort, 2000);
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[PREFLIGHT CHECK FAILED] Test database is unreachable at ${dbHost}:${dbPort}.\n` +
        `The PostgreSQL Docker container does not appear to be running or port ${dbPort} is blocked.\n` +
        `Please start the database container with: npm run db:up\n` +
        `Details: ${details}`,
      { cause: err },
    );
  }

  // Quick query check to verify database exists and credentials are valid
  const client = new pg.Client({
    connectionString: dbUrl,
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[PREFLIGHT CHECK FAILED] Test database at ${dbHost}:${dbPort} failed query check.\n` +
        `Ensure migrations have run or start the database container with: npm run db:up\n` +
        `Details: ${details}`,
      { cause: err },
    );
  } finally {
    await client.end().catch(() => {});
  }
}

let preflightPromise: Promise<void> | null = null;

export async function verifyTestEnvironment(): Promise<void> {
  if (!preflightPromise) {
    preflightPromise = (async () => {
      await checkPrismaClient();
      await checkDatabaseReachable();
    })();
  }
  return preflightPromise;
}

export function getTestPrisma(): PrismaClient {
  return getPrismaClient(TEST_DATABASE_URL);
}

export function getTestDirectPrisma(): PrismaClient {
  return getPrismaClient(TEST_DIRECT_URL);
}

export async function closeAllTestClients(): Promise<void> {
  await disconnectPrismaClient(TEST_DATABASE_URL);
  await disconnectPrismaClient(TEST_DIRECT_URL);
}

/**
 * Resets the test database between test suites using migration_owner privileges.
 * Temporarily disables user append-only triggers, executes TRUNCATE CASCADE, and re-enables triggers.
 */
export async function resetTestDatabase(): Promise<void> {
  await verifyTestEnvironment();
  const directPrisma = getTestDirectPrisma();

  await directPrisma.$executeRawUnsafe(`
    ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_entries_append_only;
    ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_entries_truncate_guard;
    ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_append_only;
    ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_truncate_guard;

    TRUNCATE TABLE
      user_update_reads,
      invitation_attempts,
      idempotency_keys,
      audit_log,
      bank_reconciliations,
      approval_votes,
      approval_eligible_voters,
      approval_requests,
      payment_submissions,
      ledger_entries,
      invitations,
      group_memberships,
      groups,
      users
    CASCADE;

    ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_entries_append_only;
    ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_entries_truncate_guard;
    ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_append_only;
    ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_truncate_guard;
  `);
}

export interface SeededGroupFixture {
  readonly group: {
    id: string;
    name: string;
    expectedPaisa: bigint;
    dueDay: number;
  };
  readonly owner: {
    user: { id: string; email: string; firebaseUid: string };
    membership: { id: string };
  };
  readonly secondTreasurer: {
    user: { id: string; email: string; firebaseUid: string };
    membership: { id: string };
  };
  readonly member1: {
    user: { id: string; email: string; firebaseUid: string };
    membership: { id: string };
  };
  readonly member2: {
    user: { id: string; email: string; firebaseUid: string };
    membership: { id: string };
  };
  readonly member3: {
    user: { id: string; email: string; firebaseUid: string };
    membership: { id: string };
  };
}

/**
 * Seeds a standard savings group with 5 members:
 * - Owner (also Treasurer)
 * - Second Treasurer
 * - 3 regular Members
 */
export async function seedStandardGroup(
  prisma: PrismaClient,
  options?: {
    readonly expectedPaisa?: bigint;
    readonly dueDay?: number;
    readonly name?: string;
  },
): Promise<SeededGroupFixture> {
  const ownerUserId = generateId();
  const treasurer2UserId = generateId();
  const member1UserId = generateId();
  const member2UserId = generateId();
  const member3UserId = generateId();

  // Create users
  await prisma.user.createMany({
    data: [
      {
        id: ownerUserId,
        firebaseUid: `fb-${ownerUserId}`,
        email: `owner-${ownerUserId}@example.com`,
        displayName: 'Aarav Owner',
      },
      {
        id: treasurer2UserId,
        firebaseUid: `fb-${treasurer2UserId}`,
        email: `treasurer-${treasurer2UserId}@example.com`,
        displayName: 'Bina Treasurer',
      },
      {
        id: member1UserId,
        firebaseUid: `fb-${member1UserId}`,
        email: `member1-${member1UserId}@example.com`,
        displayName: 'Chirag Member',
      },
      {
        id: member2UserId,
        firebaseUid: `fb-${member2UserId}`,
        email: `member2-${member2UserId}@example.com`,
        displayName: 'Deepa Member',
      },
      {
        id: member3UserId,
        firebaseUid: `fb-${member3UserId}`,
        email: `member3-${member3UserId}@example.com`,
        displayName: 'Eshaan Member',
      },
    ],
  });

  const groupId = generateId();
  const expectedPaisa = options?.expectedPaisa ?? 500000n; // 5,000 NPR
  const dueDay = options?.dueDay ?? 15;
  const name = options?.name ?? 'Pokhara Trip 2026';

  // Create group
  await prisma.group.create({
    data: {
      id: groupId,
      name,
      expectedPaisa,
      dueDay,
      createdByUserId: ownerUserId,
    },
  });

  // Create memberships
  const ownerMemberId = generateId();
  const treasurer2MemberId = generateId();
  const member1Id = generateId();
  const member2Id = generateId();
  const member3Id = generateId();

  await prisma.groupMembership.createMany({
    data: [
      {
        id: ownerMemberId,
        groupId,
        userId: ownerUserId,
        isOwner: true,
        isTreasurer: true,
      },
      {
        id: treasurer2MemberId,
        groupId,
        userId: treasurer2UserId,
        isOwner: false,
        isTreasurer: true,
      },
      {
        id: member1Id,
        groupId,
        userId: member1UserId,
        isOwner: false,
        isTreasurer: false,
      },
      {
        id: member2Id,
        groupId,
        userId: member2UserId,
        isOwner: false,
        isTreasurer: false,
      },
      {
        id: member3Id,
        groupId,
        userId: member3UserId,
        isOwner: false,
        isTreasurer: false,
      },
    ],
  });

  return {
    group: { id: groupId, name, expectedPaisa, dueDay },
    owner: {
      user: {
        id: ownerUserId,
        email: `owner-${ownerUserId}@example.com`,
        firebaseUid: `fb-${ownerUserId}`,
      },
      membership: { id: ownerMemberId },
    },
    secondTreasurer: {
      user: {
        id: treasurer2UserId,
        email: `treasurer-${treasurer2UserId}@example.com`,
        firebaseUid: `fb-${treasurer2UserId}`,
      },
      membership: { id: treasurer2MemberId },
    },
    member1: {
      user: {
        id: member1UserId,
        email: `member1-${member1UserId}@example.com`,
        firebaseUid: `fb-${member1UserId}`,
      },
      membership: { id: member1Id },
    },
    member2: {
      user: {
        id: member2UserId,
        email: `member2-${member2UserId}@example.com`,
        firebaseUid: `fb-${member2UserId}`,
      },
      membership: { id: member2Id },
    },
    member3: {
      user: {
        id: member3UserId,
        email: `member3-${member3UserId}@example.com`,
        firebaseUid: `fb-${member3UserId}`,
      },
      membership: { id: member3Id },
    },
  };
}
