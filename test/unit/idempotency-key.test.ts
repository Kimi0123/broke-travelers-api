import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import {
  extractIdempotencyKey,
  IDEMPOTENCY_KEY_REGEX,
} from '../../src/http/middleware/idempotency-key.js';

function mockRequest(headerVal?: string): Request {
  return {
    header: (name: string) => {
      if (name.toLowerCase() === 'idempotency-key') {
        return headerVal;
      }
      return undefined;
    },
  } as unknown as Request;
}

describe('Idempotency Key Validation and Regex', () => {
  it('validates regex against allowed and disallowed formats', () => {
    // Length boundary checks
    expect(IDEMPOTENCY_KEY_REGEX.test('1234567')).toBe(false); // 7 chars (too short)
    expect(IDEMPOTENCY_KEY_REGEX.test('12345678')).toBe(true); // 8 chars (min)
    expect(IDEMPOTENCY_KEY_REGEX.test('a'.repeat(100))).toBe(true); // 100 chars (max)
    expect(IDEMPOTENCY_KEY_REGEX.test('a'.repeat(101))).toBe(false); // 101 chars (too long)

    // Character set checks
    expect(IDEMPOTENCY_KEY_REGEX.test('Valid-Key_1234')).toBe(true);
    expect(IDEMPOTENCY_KEY_REGEX.test('Key with space')).toBe(false);
    expect(IDEMPOTENCY_KEY_REGEX.test('key@123456')).toBe(false);
    expect(IDEMPOTENCY_KEY_REGEX.test('key!123456')).toBe(false);
    expect(IDEMPOTENCY_KEY_REGEX.test('key-🚀-emoji')).toBe(false);
    expect(IDEMPOTENCY_KEY_REGEX.test('')).toBe(false);
  });

  it('throws idempotency_key_required when header is missing', () => {
    const req = mockRequest(undefined);
    expect(() => extractIdempotencyKey(req)).toThrowError(
      expect.objectContaining({
        status: 400,
        code: 'idempotency_key_required',
      }),
    );
  });

  it('throws invalid_idempotency_key when header is malformed', () => {
    const badKeys = [
      '',
      '1234567',
      'a'.repeat(101),
      'has spaces here',
      'key.with.dots',
      'key$with$symbols',
      'unicode-✨-key',
    ];

    for (const key of badKeys) {
      const req = mockRequest(key);
      expect(() => extractIdempotencyKey(req)).toThrowError(
        expect.objectContaining({
          status: 400,
          code: 'invalid_idempotency_key',
        }),
      );
    }
  });

  it('extracts valid idempotency keys correctly', () => {
    const validKeys = [
      '12345678',
      'Valid_Key-12345',
      'a'.repeat(100),
      'my-special-idempotency-key_001',
    ];

    for (const key of validKeys) {
      const req = mockRequest(key);
      expect(extractIdempotencyKey(req)).toBe(key);
    }
  });
});
