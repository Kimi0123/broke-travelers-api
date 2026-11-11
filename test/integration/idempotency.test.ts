import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyConflictError } from '../../src/application/errors.js';
import { postLedgerEntry } from '../../src/application/posting-service.js';
import {
  closeAllTestClients,
  getTestDirectPrisma,
  getTestPrisma,
  resetTestDatabase,
  seedStandardGroup,
} from './setup.js';

describe('Idempotency Protocol Integration', () => {
  const apiPrisma = getTestPrisma();
  const directPrisma = getTestDirectPrisma();

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeAllTestClients();
  });

  it('returns stored response on exact replay and throws on conflicting payload', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    const idempotencyKey = 'idemp-replay-key-001';

    // 1. Initial request
    const response1 = await postLedgerEntry(apiPrisma, {
      groupId: fixture.group.id,
      actorMemberId: fixture.owner.membership.id,
      kind: 'contribution',
      title: 'Initial Seed',
      magnitudePaisa: 500000,
      idempotencyKey,
    });

    expect(response1.id).toBeDefined();

    // 2. Replay with identical payload returns cached response
    const response2 = await postLedgerEntry(apiPrisma, {
      groupId: fixture.group.id,
      actorMemberId: fixture.owner.membership.id,
      kind: 'contribution',
      title: 'Initial Seed',
      magnitudePaisa: 500000,
      idempotencyKey,
    });

    expect(response2.id).toBe(response1.id);
    expect(response2.magnitudePaisa).toBe(response1.magnitudePaisa);

    // Exactly one ledger entry exists in database
    const count = await directPrisma.ledgerEntry.count({
      where: { groupId: fixture.group.id },
    });
    expect(count).toBe(1);

    // 3. Replay with conflicting payload throws IdempotencyConflictError
    await expect(
      postLedgerEntry(apiPrisma, {
        groupId: fixture.group.id,
        actorMemberId: fixture.owner.membership.id,
        kind: 'contribution',
        title: 'Initial Seed',
        magnitudePaisa: 600000, // Conflict: different magnitude
        idempotencyKey,
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('guarantees exactly one entry created when 10 concurrent requests share the same idempotency key', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    const sharedKey = 'concurrent-shared-idemp-key-999';

    // Fire 10 concurrent identical requests
    const attempts = Array.from({ length: 10 }, () =>
      postLedgerEntry(apiPrisma, {
        groupId: fixture.group.id,
        actorMemberId: fixture.owner.membership.id,
        kind: 'contribution',
        title: 'Concurrent Deposit',
        magnitudePaisa: 500000,
        idempotencyKey: sharedKey,
      }),
    );

    const results = await Promise.all(attempts);

    // All 10 requests must receive the exact same entry ID
    const firstId = results[0]?.id;
    expect(firstId).toBeDefined();

    for (const res of results) {
      expect(res.id).toBe(firstId);
    }

    // Exactly one ledger entry created in database
    const count = await directPrisma.ledgerEntry.count({
      where: { groupId: fixture.group.id },
    });
    expect(count).toBe(1);

    // Exactly one idempotency record stored
    const keyCount = await directPrisma.idempotencyKey.count({
      where: { idempotencyKey: sharedKey },
    });
    expect(keyCount).toBe(1);
  });
});
