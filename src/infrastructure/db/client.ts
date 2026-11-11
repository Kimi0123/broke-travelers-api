import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '@prisma/client';

const clientCache = new Map<string, PrismaClient>();

/**
 * Returns a cached PrismaClient connected via the pg driver adapter,
 * creating a lazy singleton for the specified connection URL (defaults to process.env.DATABASE_URL).
 */
export function getPrismaClient(url?: string): PrismaClient {
  const connectionUrl = url ?? process.env['DATABASE_URL'];
  if (!connectionUrl) {
    throw new Error(
      'DATABASE_URL environment variable is required to create PrismaClient',
    );
  }

  const cached = clientCache.get(connectionUrl);
  if (cached) {
    return cached;
  }

  const adapter = new PrismaPg(connectionUrl);
  const prisma = new PrismaClient({ adapter });

  clientCache.set(connectionUrl, prisma);
  return prisma;
}

/**
 * Closes the PrismaClient for the given URL (or all cached clients if url is omitted).
 */
export async function disconnectPrismaClient(url?: string): Promise<void> {
  if (url) {
    const cached = clientCache.get(url);
    if (cached) {
      await cached.$disconnect();
      clientCache.delete(url);
    }
  } else {
    for (const [key, cached] of clientCache.entries()) {
      await cached.$disconnect();
      clientCache.delete(key);
    }
  }
}

/**
 * Executes a callback within a Prisma interactive transaction configured with
 * READ COMMITTED isolation.
 *
 * Why Read Committed instead of Serializable:
 * In a group savings system, heavy concurrent financial mutations within the same group
 * (such as multiple members posting expenses or verifying submissions concurrently)
 * under Serializable isolation cause frequent 40001 serialization failures, retry storms,
 * and distributed transaction deadlocks.
 *
 * Instead, we use Read Committed transaction isolation coupled with explicit application-level
 * row locking on the root tenant (`SELECT id FROM groups WHERE id = $1 FOR UPDATE`).
 * This serializes all writes per group deterministically without deadlocks or application retry storms,
 * while allowing transactions across different groups to execute in full parallel without contention.
 */
export async function withTransaction<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(fn, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 5000,
    timeout: 10000,
  });
}
