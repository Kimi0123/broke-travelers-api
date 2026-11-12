import type { IncomingMessage } from 'node:http';
import express, { type Express, type Request } from 'express';
import helmet from 'helmet';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { TokenVerifier } from '../application/ports/token-verifier.js';
import type { AppConfig } from '../config/env.js';
import { generateId } from '../infrastructure/db/ids.js';
import { createErrorHandler } from './errors.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { createGroupsRouter } from './routes/groups.js';
import { createInvitationsRouter } from './routes/invitations.js';
import { createMembersRouter } from './routes/members.js';
import { createProfileRouter } from './routes/profile.js';
import { createSessionRouter } from './routes/session.js';

export interface AppDependencies {
  readonly prisma: PrismaClient;
  readonly config: AppConfig;
  readonly tokenVerifier?: TokenVerifier | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
  readonly logger?: Logger | undefined;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();

  // Trust proxy configuration
  app.set('trust proxy', deps.config.TRUST_PROXY_HOPS);

  // Security headers & disable x-powered-by
  app.disable('x-powered-by');
  app.use(helmet());

  // Request ID middleware
  app.use(requestIdMiddleware());

  // Pino HTTP logging
  const baseLogger = deps.logger ?? pino({ level: deps.config.LOG_LEVEL });
  const httpLogger = pinoHttp({
    logger: baseLogger,
    genReqId: (req: IncomingMessage) =>
      (req as Request).id ?? `req_${generateId()}`,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.query',
        'req.body.reference',
        'req.body.password',
        'req.body.token',
      ],
      remove: true,
    },
    serializers: {
      req(req: IncomingMessage) {
        const expressReq = req as Request;
        return {
          id: expressReq.id,
          method: expressReq.method,
          url: expressReq.url,
          headers: expressReq.headers,
          remoteAddress: expressReq.socket?.remoteAddress,
          remotePort: expressReq.socket?.remotePort,
        };
      },
    },
  });
  app.use(httpLogger);

  // Body parser with 100kb limit
  app.use(express.json({ limit: '100kb' }));

  // Public health check endpoint
  app.get('/v1/health', async (_req, res) => {
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('DB health query timeout')),
          2000,
        );
        timer.unref?.();
      });

      await Promise.race([deps.prisma.$queryRaw`SELECT 1`, timeoutPromise]);

      const now = deps.clock ? deps.clock() : new Date();
      res.status(200).json({
        status: 'ok',
        db: 'connected',
        time: now.toISOString(),
      });
    } catch {
      res.status(503).json({
        status: 'degraded',
        db: 'unreachable',
      });
    }
  });

  // Authenticated routes
  if (deps.tokenVerifier) {
    app.use(
      createSessionRouter({
        prisma: deps.prisma,
        tokenVerifier: deps.tokenVerifier,
        config: deps.config,
        idGenerator: deps.idGenerator,
      }),
    );
    app.use(
      createProfileRouter({
        prisma: deps.prisma,
        tokenVerifier: deps.tokenVerifier,
      }),
    );
    app.use(
      createGroupsRouter({
        prisma: deps.prisma,
        tokenVerifier: deps.tokenVerifier,
        config: deps.config,
        clock: deps.clock,
        idGenerator: deps.idGenerator,
      }),
    );
    app.use(
      createInvitationsRouter({
        prisma: deps.prisma,
        tokenVerifier: deps.tokenVerifier,
        config: deps.config,
        clock: deps.clock,
        idGenerator: deps.idGenerator,
      }),
    );
    app.use(
      createMembersRouter({
        prisma: deps.prisma,
        tokenVerifier: deps.tokenVerifier,
        clock: deps.clock,
        idGenerator: deps.idGenerator,
      }),
    );
  }

  // 404 handler for unknown routes
  app.use((req, res) => {
    const requestId = req.id ?? 'unknown';
    res.status(404).json({
      error: {
        code: 'not_found',
        message: 'The requested endpoint was not found',
        requestId,
      },
    });
  });

  // Central error handling middleware
  app.use(createErrorHandler(baseLogger));

  return app;
}
