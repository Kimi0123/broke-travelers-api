import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { generateId } from '../../src/infrastructure/db/ids.js';
import {
  closeAllTestClients,
  getTestDirectPrisma,
  getTestPrisma,
  resetTestDatabase,
  seedStandardGroup,
} from './setup.js';

describe('Append-Only Enforcement (ledger_entries and audit_log)', () => {
  const apiPrisma = getTestPrisma();
  const directPrisma = getTestDirectPrisma();

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeAllTestClients();
  });

  it('rejects UPDATE, DELETE, and TRUNCATE from api_user at database permission level', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    // Insert an initial ledger entry as migration_owner
    const entryId = generateId();
    await directPrisma.ledgerEntry.create({
      data: {
        id: entryId,
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'Initial Savings',
        magnitudePaisa: 500000n,
        occurredAt: new Date(),
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        memberId: fixture.owner.membership.id,
        actorMemberId: fixture.owner.membership.id,
      },
    });

    // Insert an audit log entry
    const auditId = generateId();
    await directPrisma.auditLog.create({
      data: {
        id: auditId,
        groupId: fixture.group.id,
        actorUserId: fixture.owner.user.id,
        action: 'test.init',
        field: 'status',
      },
    });

    // 1. UPDATE on ledger_entries by api_user -> 42501 permission denied
    await expect(
      apiPrisma.$executeRawUnsafe(
        `UPDATE ledger_entries SET title = 'Hacked' WHERE id = '${entryId}'::uuid`,
      ),
    ).rejects.toThrow(/permission denied/i);

    // 2. DELETE on ledger_entries by api_user -> permission denied
    await expect(
      apiPrisma.$executeRawUnsafe(
        `DELETE FROM ledger_entries WHERE id = '${entryId}'::uuid`,
      ),
    ).rejects.toThrow(/permission denied/i);

    // 3. TRUNCATE on ledger_entries by api_user -> permission denied
    await expect(
      apiPrisma.$executeRawUnsafe(`TRUNCATE TABLE ledger_entries`),
    ).rejects.toThrow(/permission denied/i);

    // 4. UPDATE on audit_log by api_user -> permission denied
    await expect(
      apiPrisma.$executeRawUnsafe(
        `UPDATE audit_log SET action = 'tampered' WHERE id = '${auditId}'::uuid`,
      ),
    ).rejects.toThrow(/permission denied/i);

    // 5. DELETE on audit_log by api_user -> permission denied
    await expect(
      apiPrisma.$executeRawUnsafe(
        `DELETE FROM audit_log WHERE id = '${auditId}'::uuid`,
      ),
    ).rejects.toThrow(/permission denied/i);

    // 6. TRUNCATE on audit_log by api_user -> permission denied
    await expect(
      apiPrisma.$executeRawUnsafe(`TRUNCATE TABLE audit_log`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('rejects UPDATE, DELETE, and TRUNCATE from migration_owner via BEFORE triggers', async () => {
    const fixture = await seedStandardGroup(directPrisma);

    const entryId = generateId();
    await directPrisma.ledgerEntry.create({
      data: {
        id: entryId,
        groupId: fixture.group.id,
        kind: 'contribution',
        title: 'Initial Savings',
        magnitudePaisa: 500000n,
        occurredAt: new Date(),
        periodMonth: new Date('2026-11-01T00:00:00.000Z'),
        memberId: fixture.owner.membership.id,
        actorMemberId: fixture.owner.membership.id,
      },
    });

    const auditId = generateId();
    await directPrisma.auditLog.create({
      data: {
        id: auditId,
        groupId: fixture.group.id,
        actorUserId: fixture.owner.user.id,
        action: 'test.init',
        field: 'status',
      },
    });

    // 1. UPDATE on ledger_entries by migration_owner -> caught by trigger
    await expect(
      directPrisma.$executeRawUnsafe(
        `UPDATE ledger_entries SET title = 'Altered' WHERE id = '${entryId}'::uuid`,
      ),
    ).rejects.toThrow(/append_only_violation/i);

    // 2. DELETE on ledger_entries by migration_owner -> caught by trigger
    await expect(
      directPrisma.$executeRawUnsafe(
        `DELETE FROM ledger_entries WHERE id = '${entryId}'::uuid`,
      ),
    ).rejects.toThrow(/append_only_violation/i);

    // 3. TRUNCATE on ledger_entries by migration_owner -> caught by trigger
    await expect(
      directPrisma.$executeRawUnsafe(`TRUNCATE TABLE ledger_entries CASCADE`),
    ).rejects.toThrow(/append_only_violation/i);

    // 4. UPDATE on audit_log by migration_owner -> caught by trigger
    await expect(
      directPrisma.$executeRawUnsafe(
        `UPDATE audit_log SET action = 'tampered' WHERE id = '${auditId}'::uuid`,
      ),
    ).rejects.toThrow(/append_only_violation/i);

    // 5. DELETE on audit_log by migration_owner -> caught by trigger
    await expect(
      directPrisma.$executeRawUnsafe(
        `DELETE FROM audit_log WHERE id = '${auditId}'::uuid`,
      ),
    ).rejects.toThrow(/append_only_violation/i);

    // 6. TRUNCATE on audit_log by migration_owner -> caught by trigger
    await expect(
      directPrisma.$executeRawUnsafe(`TRUNCATE TABLE audit_log CASCADE`),
    ).rejects.toThrow(/append_only_violation/i);
  });
});
