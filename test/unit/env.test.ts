import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

describe('loadConfig', () => {
  const baseValidEnv: Record<string, string> = {
    NODE_ENV: 'test',
    REQUIRE_VERIFIED_EMAIL: 'false',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/testdb',
  };

  it('parses valid environment variables with defaults', () => {
    const config = loadConfig(baseValidEnv);
    expect(config.NODE_ENV).toBe('test');
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.TRUST_PROXY_HOPS).toBe(1);
    expect(config.REQUIRE_VERIFIED_EMAIL).toBe(false);
    expect(config.DATABASE_URL).toBe(baseValidEnv.DATABASE_URL);
  });

  it('requires REQUIRE_VERIFIED_EMAIL to be explicitly provided', () => {
    const envWithoutFlag = { ...baseValidEnv };
    delete envWithoutFlag.REQUIRE_VERIFIED_EMAIL;

    expect(() => loadConfig(envWithoutFlag)).toThrowError(
      /Invalid or missing environment variables: REQUIRE_VERIFIED_EMAIL/,
    );
  });

  it('rejects invalid boolean string for REQUIRE_VERIFIED_EMAIL', () => {
    const envWithBadFlag = {
      ...baseValidEnv,
      REQUIRE_VERIFIED_EMAIL: 'maybe',
    };

    expect(() => loadConfig(envWithBadFlag)).toThrowError(
      /Invalid or missing environment variables: REQUIRE_VERIFIED_EMAIL/,
    );
  });

  it('reports only variable names and never exposes values on error', () => {
    const secretValue = 'super_secret_password_12345';
    const invalidEnv = {
      ...baseValidEnv,
      PORT: secretValue,
    };

    try {
      loadConfig(invalidEnv);
      expect.fail('Should have thrown an error');
    } catch (err: unknown) {
      const message = (err as Error).message;
      expect(message).toContain('PORT');
      expect(message).not.toContain(secretValue);
    }
  });

  it('requires Firebase variables in production', () => {
    const prodEnvWithoutFirebase = {
      ...baseValidEnv,
      NODE_ENV: 'production',
    };

    expect(() => loadConfig(prodEnvWithoutFirebase)).toThrowError(
      /FIREBASE_PROJECT_ID/,
    );
    expect(() => loadConfig(prodEnvWithoutFirebase)).toThrowError(
      /FIREBASE_SERVICE_ACCOUNT_JSON/,
    );
  });

  it('succeeds in production when Firebase variables are provided', () => {
    const prodEnvWithFirebase = {
      ...baseValidEnv,
      NODE_ENV: 'production',
      FIREBASE_PROJECT_ID: 'broke-travelers-prod',
      FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"broke-travelers-prod"}',
    };

    const config = loadConfig(prodEnvWithFirebase);
    expect(config.NODE_ENV).toBe('production');
    expect(config.FIREBASE_PROJECT_ID).toBe('broke-travelers-prod');
  });
});
