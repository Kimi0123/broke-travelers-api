/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/http/app.js';
import type { AppConfig } from '../../src/config/env.js';
import { closeAllTestClients, getTestPrisma } from './setup.js';

describe('GET /v1/health Integration', () => {
  const prisma = getTestPrisma();
  const testConfig: AppConfig = {
    NODE_ENV: 'test',
    PORT: 3000,
    LOG_LEVEL: 'fatal',
    TRUST_PROXY_HOPS: 1,
    REQUIRE_VERIFIED_EMAIL: false,
    DATABASE_URL: process.env['DATABASE_URL'] ?? '',
  };

  afterAll(async () => {
    await closeAllTestClients();
  });

  it('returns 200 ok when database is reachable', async () => {
    const app = createApp({
      prisma,
      config: testConfig,
      logger: pino({ level: 'silent' }),
    });

    const res = await request(app).get('/v1/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      db: 'connected',
      time: expect.any(String),
    });
  });

  it('returns 503 degraded when database query fails or times out', async () => {
    const failingPrisma = {
      $queryRaw: () => Promise.reject(new Error('Connection refused')),
    } as unknown as PrismaClient;

    const app = createApp({
      prisma: failingPrisma,
      config: testConfig,
      logger: pino({ level: 'silent' }),
    });

    const res = await request(app).get('/v1/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: 'degraded',
      db: 'unreachable',
    });
  });
});
