/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/http/app.js';
import type { AppConfig } from '../../src/config/env.js';
import { createErrorHandler } from '../../src/http/errors.js';
import { requestIdMiddleware } from '../../src/http/middleware/request-id.js';

describe('Security Hardening & Error Handling', () => {
  const dummyPrisma = {
    $queryRaw: () => Promise.resolve([{ '?column?': 1 }]),
  } as unknown as PrismaClient;

  const testConfig: AppConfig = {
    NODE_ENV: 'test',
    PORT: 3000,
    LOG_LEVEL: 'info',
    TRUST_PROXY_HOPS: 1,
    REQUIRE_VERIFIED_EMAIL: false,
    DATABASE_URL: 'postgresql://dummy:dummy@localhost:5432/dummy',
  };

  it('throwing handler produces 500 without stack or query, and redacts Authorization header from logs', async () => {
    const logChunks: string[] = [];
    const customStream = {
      write: (chunk: string) => {
        logChunks.push(chunk);
        return true;
      },
    };
    const testLogger = pino({ level: 'info' }, customStream);

    const app = express();
    app.use(requestIdMiddleware());
    app.use(
      pinoHttp({
        logger: testLogger,
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie'],
          remove: true,
        },
      }),
    );

    // Route that throws an internal error containing sensitive SQL & secret tokens
    const secretSql =
      'SELECT * FROM users WHERE secret_token = "secret_pass_12345"';
    app.get('/test-internal-error', () => {
      throw new Error(`Database error executing: ${secretSql}`);
    });
    app.use(createErrorHandler(testLogger));

    const secretAuthToken = 'Bearer sensitive_auth_bearer_token_xyz_98765';
    const res = await request(app)
      .get('/test-internal-error')
      .set('Authorization', secretAuthToken)
      .set('Cookie', 'secret_session_cookie=abc');

    // 1. Assert 500 status and canonical error format
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred. Please try again later.',
        requestId: expect.any(String),
      },
    });

    // 2. Assert response body NEVER leaks stack, SQL query, or secret values
    const responseText = JSON.stringify(res.body);
    expect(responseText).not.toContain('stack');
    expect(responseText).not.toContain('SELECT');
    expect(responseText).not.toContain('secret_token');
    expect(responseText).not.toContain('secret_pass_12345');
    expect(responseText).not.toContain('sensitive_auth_bearer_token');

    // 3. Assert logs redact the Authorization header
    const combinedLogs = logChunks.join('\n');
    expect(combinedLogs).not.toContain('sensitive_auth_bearer_token_xyz_98765');
  });

  it('applies helmet security headers and removes x-powered-by', async () => {
    const app = createApp({
      prisma: dummyPrisma,
      config: testConfig,
      logger: pino({ level: 'silent' }),
    });

    const res = await request(app).get('/v1/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('enforces 100kb JSON body parser limit with 413 payload_too_large', async () => {
    const app = createApp({
      prisma: dummyPrisma,
      config: testConfig,
      logger: pino({ level: 'silent' }),
    });

    // Generate payload slightly larger than 100kb
    const largePayload = {
      data: 'x'.repeat(105 * 1024),
    };

    const res = await request(app)
      .post('/v1/health') // any endpoint accepts POST with body parser
      .set('Content-Type', 'application/json')
      .send(largePayload);

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: {
        code: 'payload_too_large',
        message: 'Request payload exceeds allowed limit',
        requestId: expect.any(String),
      },
    });
  });
});
