import { describe, expect, it } from 'vitest';
import { resolveDatasourceUrl } from '../../src/config/datasource-url.js';

describe('resolveDatasourceUrl', () => {
  const localFallback =
    'postgresql://api_user:api_user_local_dev_secret@localhost:5533/broke_travelers?schema=public';

  describe('production mode (NODE_ENV=production)', () => {
    it('returns DIRECT_URL when DIRECT_URL is configured in production', () => {
      const result = resolveDatasourceUrl({
        NODE_ENV: 'production',
        DIRECT_URL: 'postgresql://owner:pass@prod-direct:5432/neondb',
        DATABASE_URL: 'postgresql://api_user:pass@prod-pooled:5432/neondb',
      });
      expect(result).toBe('postgresql://owner:pass@prod-direct:5432/neondb');
    });

    it('returns DATABASE_URL when DIRECT_URL is unset in production', () => {
      const result = resolveDatasourceUrl({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://api_user:pass@prod-pooled:5432/neondb',
      });
      expect(result).toBe('postgresql://api_user:pass@prod-pooled:5432/neondb');
    });

    it('throws error naming missing variables when neither DIRECT_URL nor DATABASE_URL is set in production', () => {
      expect(() =>
        resolveDatasourceUrl({
          NODE_ENV: 'production',
        }),
      ).toThrowError(/DIRECT_URL.*DATABASE_URL/i);
    });

    it('throws error when URLs are empty or whitespace in production', () => {
      expect(() =>
        resolveDatasourceUrl({
          NODE_ENV: 'production',
          DIRECT_URL: '   ',
          DATABASE_URL: '',
        }),
      ).toThrowError(/DIRECT_URL.*DATABASE_URL/i);
    });

    it('never leaks credential values in error message when failing in production', () => {
      try {
        resolveDatasourceUrl({
          NODE_ENV: 'production',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain('localhost');
        expect(message).not.toContain('secret');
        expect(message).not.toContain('password');
        expect(message).toContain('DIRECT_URL');
        expect(message).toContain('DATABASE_URL');
      }
    });

    it('never returns the local fallback URL in production', () => {
      try {
        const result = resolveDatasourceUrl({
          NODE_ENV: 'production',
        });
        expect(result).not.toBe(localFallback);
      } catch {
        // Expected throw
      }
    });
  });

  describe('non-production mode (development, test, unset)', () => {
    it('returns the local Docker fallback when neither variable is set in development', () => {
      const result = resolveDatasourceUrl({
        NODE_ENV: 'development',
      });
      expect(result).toBe(localFallback);
    });

    it('returns the local Docker fallback when NODE_ENV is unset', () => {
      const result = resolveDatasourceUrl({});
      expect(result).toBe(localFallback);
    });

    it('prefers DIRECT_URL over DATABASE_URL in development when both are provided', () => {
      const result = resolveDatasourceUrl({
        NODE_ENV: 'development',
        DIRECT_URL: 'postgresql://custom-direct:5432/db',
        DATABASE_URL: 'postgresql://custom-pooled:5432/db',
      });
      expect(result).toBe('postgresql://custom-direct:5432/db');
    });

    it('uses DATABASE_URL in development when DIRECT_URL is absent', () => {
      const result = resolveDatasourceUrl({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://custom-pooled:5432/db',
      });
      expect(result).toBe('postgresql://custom-pooled:5432/db');
    });
  });
});
