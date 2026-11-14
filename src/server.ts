if (process.env['NODE_ENV'] !== 'production') {
  try {
    await import('dotenv/config');
  } catch {
    // In production or when .env is not present, environment variables are provided by the platform
  }
}

import { pino, type Logger } from 'pino';
import type { PrismaClient } from '@prisma/client';
import type { TokenVerifier } from './application/ports/token-verifier.js';
import { loadConfig } from './config/env.js';
import { createApp } from './http/app.js';
import {
  disconnectPrismaClient,
  getPrismaClient,
} from './infrastructure/db/client.js';
import { FirebaseTokenVerifier } from './infrastructure/firebase/firebase-token-verifier.js';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const prisma = getPrismaClient(config.DATABASE_URL);

let tokenVerifier: TokenVerifier | undefined;
if (config.FIREBASE_PROJECT_ID || config.FIREBASE_SERVICE_ACCOUNT_JSON) {
  tokenVerifier = new FirebaseTokenVerifier({
    firebaseProjectId: config.FIREBASE_PROJECT_ID,
    firebaseServiceAccountJson: config.FIREBASE_SERVICE_ACCOUNT_JSON,
  });
}

const app = createApp({
  prisma,
  config,
  logger,
  tokenVerifier,
});

/**
 * On boot in production, verify connectivity to the database with exponential backoff.
 * Logs ONLY attempt counts (never connection strings, secrets, or credentials).
 */
async function waitForDatabase(
  client: PrismaClient,
  log: Logger,
  maxAttempts = 5,
): Promise<void> {
  let attempt = 1;
  let delayMs = 1000;
  while (attempt <= maxAttempts) {
    try {
      log.info({ attempt, maxAttempts }, 'Checking database connectivity...');
      await client.$queryRaw`SELECT 1`;
      log.info('Database connectivity established');
      return;
    } catch {
      log.warn(
        { attempt, maxAttempts },
        'Database connectivity check failed, retrying...',
      );
      if (attempt === maxAttempts) {
        throw new Error(
          `Failed to connect to database after ${maxAttempts} attempts`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 8000);
      attempt++;
    }
  }
}

if (config.NODE_ENV === 'production') {
  await waitForDatabase(prisma, logger);
}

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'Server started');
});

let isShuttingDown = false;

function handleShutdown(signal: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown initiated');

  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out after 10s, forcing exit');
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Error during server close');
      process.exit(1);
    }
    disconnectPrismaClient(config.DATABASE_URL)
      .then(() => {
        logger.info('Database connections closed cleanly');
        process.exit(0);
      })
      .catch((dbErr: unknown) => {
        logger.error({ err: dbErr }, 'Error disconnecting database client');
        process.exit(1);
      });
  });
}

process.on('SIGTERM', () => {
  handleShutdown('SIGTERM');
});
process.on('SIGINT', () => {
  handleShutdown('SIGINT');
});
