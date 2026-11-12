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

  it('proves that two different users in the same group may use the SAME key string independently without collision or cache leak', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    const sharedKey = 'shared-key-across-actors-123';

    // User 1 (Owner) posts an entry with sharedKey and amount 500,000 paisa
    const responseOwner = await postLedgerEntry(apiPrisma, {
      groupId: fixture.group.id,
      actorMemberId: fixture.owner.membership.id,
      kind: 'contribution',
      title: 'Owner Deposit',
      magnitudePaisa: 500000,
      idempotencyKey: sharedKey,
    });

    // User 2 (Second Treasurer) posts an entry with SAME sharedKey and DIFFERENT amount 200,000 paisa
    // Since scope is (groupId, actorUserId, operation, idempotencyKey), User 2 does NOT see
    // an idempotency_conflict and does NOT receive User 1's cached response.
    const responseTreasurer = await postLedgerEntry(apiPrisma, {
      groupId: fixture.group.id,
      actorMemberId: fixture.secondTreasurer.membership.id,
      kind: 'contribution',
      title: 'Treasurer Deposit',
      magnitudePaisa: 200000,
      idempotencyKey: sharedKey,
    });

    // Different entries created
    expect(responseOwner.id).not.toBe(responseTreasurer.id);
    expect(responseOwner.magnitudePaisa).toBe(500000);
    expect(responseTreasurer.magnitudePaisa).toBe(200000);

    // Replay for Owner gets Owner's cached response
    const replayOwner = await postLedgerEntry(apiPrisma, {
      groupId: fixture.group.id,
      actorMemberId: fixture.owner.membership.id,
      kind: 'contribution',
      title: 'Owner Deposit',
      magnitudePaisa: 500000,
      idempotencyKey: sharedKey,
    });
    expect(replayOwner.id).toBe(responseOwner.id);
    expect(replayOwner.magnitudePaisa).toBe(500000);

    // Replay for Treasurer gets Treasurer's cached response
    const replayTreasurer = await postLedgerEntry(apiPrisma, {
      groupId: fixture.group.id,
      actorMemberId: fixture.secondTreasurer.membership.id,
      kind: 'contribution',
      title: 'Treasurer Deposit',
      magnitudePaisa: 200000,
      idempotencyKey: sharedKey,
    });
    expect(replayTreasurer.id).toBe(responseTreasurer.id);
    expect(replayTreasurer.magnitudePaisa).toBe(200000);

    // Exactly 2 ledger entries exist in database
    const count = await directPrisma.ledgerEntry.count({
      where: { groupId: fixture.group.id },
    });
    expect(count).toBe(2);

    // Exactly 2 idempotency records exist in database
    const keyCount = await directPrisma.idempotencyKey.count({
      where: { idempotencyKey: sharedKey },
    });
    expect(keyCount).toBe(2);
  });
});
