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

  it('requires Firebase, TRUST_PROXY_HOPS, and LOG_LEVEL variables in production', () => {
    const prodEnvWithoutVars = {
      ...baseValidEnv,
      NODE_ENV: 'production',
    };

    try {
      loadConfig(prodEnvWithoutVars);
      expect.fail('Should have thrown an error');
    } catch (err: unknown) {
      const message = (err as Error).message;
      expect(message).toContain('FIREBASE_PROJECT_ID');
      expect(message).toContain('FIREBASE_SERVICE_ACCOUNT_JSON');
      expect(message).toContain('TRUST_PROXY_HOPS');
      expect(message).toContain('LOG_LEVEL');
    }
  });

  it('succeeds in production when all required variables are provided with raw JSON', () => {
    const prodEnvValid = {
      ...baseValidEnv,
      NODE_ENV: 'production',
      FIREBASE_PROJECT_ID: 'broke-travelers-prod',
      FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"broke-travelers-prod"}',
      TRUST_PROXY_HOPS: '1',
      LOG_LEVEL: 'info',
    };

    const config = loadConfig(prodEnvValid);
    expect(config.NODE_ENV).toBe('production');
    expect(config.FIREBASE_PROJECT_ID).toBe('broke-travelers-prod');
    expect(config.FIREBASE_SERVICE_ACCOUNT_JSON).toBe(
      '{"project_id":"broke-travelers-prod"}',
    );
    expect(config.TRUST_PROXY_HOPS).toBe(1);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('succeeds in production when FIREBASE_SERVICE_ACCOUNT_JSON is base64 encoded JSON', () => {
    const rawJson =
      '{"project_id":"broke-travelers-prod","client_email":"test@prod.iam.gserviceaccount.com"}';
    const base64Json = Buffer.from(rawJson).toString('base64');

    const prodEnvBase64 = {
      ...baseValidEnv,
      NODE_ENV: 'production',
      FIREBASE_PROJECT_ID: 'broke-travelers-prod',
      FIREBASE_SERVICE_ACCOUNT_JSON: base64Json,
      TRUST_PROXY_HOPS: '2',
      LOG_LEVEL: 'warn',
    };

    const config = loadConfig(prodEnvBase64);
    expect(config.NODE_ENV).toBe('production');
    expect(config.FIREBASE_SERVICE_ACCOUNT_JSON).toBe(rawJson);
    expect(config.TRUST_PROXY_HOPS).toBe(2);
    expect(config.LOG_LEVEL).toBe('warn');
  });

  it('rejects placeholder values and empty strings without leaking values', () => {
    const placeholders = ['changeme', 'placeholder', 'secret', 'xxx', '   '];
    for (const placeholder of placeholders) {
      const badEnv = {
        ...baseValidEnv,
        DATABASE_URL: placeholder,
      };

      try {
        loadConfig(badEnv);
        expect.fail(`Should have rejected placeholder: "${placeholder}"`);
      } catch (err: unknown) {
        const message = (err as Error).message;
        expect(message).toContain('DATABASE_URL');
        if (placeholder.trim().length > 0) {
          expect(message).not.toContain(placeholder.trim());
        }
      }
    }
  });

  it('rejects invalid JSON in FIREBASE_SERVICE_ACCOUNT_JSON', () => {
    const badJsonEnv = {
      ...baseValidEnv,
      NODE_ENV: 'production',
      FIREBASE_PROJECT_ID: 'broke-travelers-prod',
      FIREBASE_SERVICE_ACCOUNT_JSON: 'not-a-valid-json-string',
      TRUST_PROXY_HOPS: '1',
      LOG_LEVEL: 'info',
    };

    expect(() => loadConfig(badJsonEnv)).toThrowError(
      /FIREBASE_SERVICE_ACCOUNT_JSON/,
    );
  });
});
