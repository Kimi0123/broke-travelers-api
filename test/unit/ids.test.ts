import { describe, expect, it } from 'vitest';
import { generateId } from '../../src/infrastructure/db/ids.js';

describe('generateId (UUIDv7)', () => {
  const UUID_V7_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it('generates valid UUIDv7 strings matching RFC 9562', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateId();
      expect(id).toMatch(UUID_V7_REGEX);
    }
  });

  it('generates unique IDs across successive calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = generateId();
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
  });

  it('generates monotonically increasing or equal timestamp prefixes', () => {
    const id1 = generateId();
    const id2 = generateId();
    // Compare first 8 hex characters (32-bit high timestamp)
    const prefix1 = id1.slice(0, 8);
    const prefix2 = id2.slice(0, 8);
    expect(prefix2 >= prefix1).toBe(true);
  });
});
