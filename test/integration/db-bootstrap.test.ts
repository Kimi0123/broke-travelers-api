import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBootstrap } from '../../scripts/db-bootstrap.js';
import {
  closeAllTestClients,
  getTestDirectPrisma,
  TEST_DIRECT_URL,
} from './setup.js';

describe('Managed DB Bootstrap Script (Integration)', () => {
  const directPrisma = getTestDirectPrisma();
  const testRole = 'api_user_bootstrap_test';

  beforeAll(async () => {
    try {
      await directPrisma.$executeRawUnsafe(
        `REVOKE CONNECT ON DATABASE broke_travelers_test FROM ${testRole};`,
      );
      await directPrisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${testRole};`);
    } catch {
      // ignore if role doesn't exist
    }
  });

  afterAll(async () => {
    try {
      await directPrisma.$executeRawUnsafe(
        `REVOKE CONNECT ON DATABASE broke_travelers_test FROM ${testRole};`,
      );
      await directPrisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${testRole};`);
    } catch {
      // ignore if role doesn't exist
    } finally {
      await closeAllTestClients();
    }
  });

  it('runs bootstrap idempotently twice and provisions role with exact flags and CONNECT grant', async () => {
    // 1. Initial bootstrap run (role creation)
    await runBootstrap({
      DIRECT_URL: TEST_DIRECT_URL,
      API_USER_PASSWORD: 'initial_test_pass_123',
      API_USER_ROLE_NAME: testRole,
    });

    // 2. Second bootstrap run (idempotent ALTER password update)
    await runBootstrap({
      DIRECT_URL: TEST_DIRECT_URL,
      API_USER_PASSWORD: 'updated_test_pass_456',
      API_USER_ROLE_NAME: testRole,
    });

    // 3. Verify role exists in pg_roles with expected security flags
    const roles = await directPrisma.$queryRawUnsafe<
      Array<{
        rolname: string;
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
      }>
    >(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit
       FROM pg_roles
       WHERE rolname = $1`,
      testRole,
    );

    expect(roles).toHaveLength(1);
    const role = roles[0]!;
    expect(role.rolcanlogin).toBe(true);
    expect(role.rolsuper).toBe(false);
    expect(role.rolcreatedb).toBe(false);
    expect(role.rolcreaterole).toBe(false);
    expect(role.rolinherit).toBe(false);

    // 4. Verify CONNECT privilege on the current database
    const privs = await directPrisma.$queryRawUnsafe<
      Array<{ has_connect: boolean }>
    >(
      `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS has_connect`,
      testRole,
    );

    expect(privs).toHaveLength(1);
    expect(privs[0]!.has_connect).toBe(true);
  });
});
