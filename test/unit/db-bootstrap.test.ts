import { describe, expect, it } from 'vitest';
import { validateBootstrapEnv } from '../../scripts/db-bootstrap.js';

describe('validateBootstrapEnv', () => {
  const validUrl =
    'postgresql://owner:secure_pass_123@ep-direct.neon.tech:5432/testdb';
  const testPassword = 'MySuperSecretPassword!987';

  it('accepts valid environment variables and extracts connection target details', () => {
    const env = {
      DIRECT_URL: validUrl,
      API_USER_PASSWORD: testPassword,
    };

    const result = validateBootstrapEnv(env);
    expect(result.host).toBe('ep-direct.neon.tech');
    expect(result.database).toBe('testdb');
    expect(result.roleName).toBe('api_user');
    expect(result.directUrl).toBe(validUrl);
    expect(result.apiUserPassword).toBe(testPassword);
  });

  it('respects API_USER_ROLE_NAME override when provided', () => {
    const env = {
      DIRECT_URL: validUrl,
      API_USER_PASSWORD: testPassword,
      API_USER_ROLE_NAME: 'custom_api_user',
    };

    const result = validateBootstrapEnv(env);
    expect(result.roleName).toBe('custom_api_user');
  });

  it('throws with variable names when variables are missing or empty', () => {
    expect(() => validateBootstrapEnv({})).toThrowError(
      /Missing or invalid environment variables: DIRECT_URL, API_USER_PASSWORD/,
    );

    expect(() =>
      validateBootstrapEnv({
        DIRECT_URL: validUrl,
        API_USER_PASSWORD: '   ',
      }),
    ).toThrowError(
      /Missing or invalid environment variables: API_USER_PASSWORD/,
    );

    expect(() =>
      validateBootstrapEnv({
        DIRECT_URL: '',
        API_USER_PASSWORD: testPassword,
      }),
    ).toThrowError(/Missing or invalid environment variables: DIRECT_URL/);
  });

  it('rejects known placeholder values', () => {
    for (const placeholder of [
      'changeme',
      'placeholder',
      'secret',
      'xxx',
      'your-secret',
    ]) {
      expect(() =>
        validateBootstrapEnv({
          DIRECT_URL: validUrl,
          API_USER_PASSWORD: placeholder,
        }),
      ).toThrowError(
        /Missing or invalid environment variables: API_USER_PASSWORD/,
      );

      expect(() =>
        validateBootstrapEnv({
          DIRECT_URL: placeholder,
          API_USER_PASSWORD: testPassword,
        }),
      ).toThrowError(/Missing or invalid environment variables: DIRECT_URL/);
    }
  });

  it('rejects pooled connection endpoints (-pooler)', () => {
    const pooledUrl =
      'postgresql://owner:pass@ep-sample-pooler.ap-southeast-1.aws.neon.tech/neondb';

    expect(() =>
      validateBootstrapEnv({
        DIRECT_URL: pooledUrl,
        API_USER_PASSWORD: testPassword,
      }),
    ).toThrowError(/pooled endpoint \(-pooler\)/);
  });

  it('never leaks the password or database URL in error messages', () => {
    const leakSensitivePass = 'UltraConfidentialSecret12345';
    const leakSensitiveUrl =
      'postgresql://sensitive_user:secret123@ep-sample-pooler.neon.tech/db';

    try {
      validateBootstrapEnv({
        DIRECT_URL: leakSensitiveUrl,
        API_USER_PASSWORD: leakSensitivePass,
      });
      expect.unreachable('Should have thrown on pooled endpoint');
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(leakSensitivePass);
      expect(msg).not.toContain(leakSensitiveUrl);
      expect(msg).not.toContain('sensitive_user');
      expect(msg).not.toContain('secret123');
    }

    try {
      validateBootstrapEnv({
        DIRECT_URL: 'invalid-url-string',
        API_USER_PASSWORD: leakSensitivePass,
      });
      expect.unreachable('Should have thrown on invalid url');
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(leakSensitivePass);
      expect(msg).not.toContain('invalid-url-string');
    }
  });
});
