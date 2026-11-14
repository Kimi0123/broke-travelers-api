-- scripts/verify-roles.sql
-- Verifies that api_user follows the principle of least privilege:
-- 1. Must NOT be superuser, createdb, or createrole.
-- 2. Must NOT have CREATE privilege on schema public (no DDL rights).
-- 3. Must NOT own any tables or sequences (owner has implicit DDL rights).
-- 4. Must NOT have UPDATE, DELETE, or TRUNCATE on ledger_entries or audit_log.
-- Raises an exception inside a DO $$ block if any check fails; returns cleanly otherwise.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_role_exists BOOLEAN;
  v_is_superuser BOOLEAN;
  v_can_createdb BOOLEAN;
  v_can_createrole BOOLEAN;
  v_has_schema_create BOOLEAN;
  v_owned_tables INT;
  v_forbidden_grant RECORD;
BEGIN
  -- 1. Check api_user role exists
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_user') INTO v_role_exists;
  IF NOT v_role_exists THEN
    RAISE EXCEPTION 'ROLE_VERIFY_FAILED: Role api_user does not exist';
  END IF;

  -- 2. Check no administrative / DDL flags on the role
  SELECT rolsuper, rolcreatedb, rolcreaterole
  INTO v_is_superuser, v_can_createdb, v_can_createrole
  FROM pg_roles
  WHERE rolname = 'api_user';

  IF v_is_superuser THEN
    RAISE EXCEPTION 'ROLE_VERIFY_FAILED: api_user must not be SUPERUSER';
  END IF;
  IF v_can_createdb THEN
    RAISE EXCEPTION 'ROLE_VERIFY_FAILED: api_user must not have CREATEDB privilege';
  END IF;
  IF v_can_createrole THEN
    RAISE EXCEPTION 'ROLE_VERIFY_FAILED: api_user must not have CREATEROLE privilege';
  END IF;

  -- 3. Check schema privileges: api_user must NOT have CREATE on public schema (no DDL)
  SELECT has_schema_privilege('api_user', 'public', 'CREATE') INTO v_has_schema_create;
  IF v_has_schema_create THEN
    RAISE EXCEPTION 'ROLE_VERIFY_FAILED: api_user must not have CREATE privilege on schema public';
  END IF;

  -- 4. Check table ownership: api_user must not own any tables in public (owner bypasses grants)
  SELECT COUNT(*) INTO v_owned_tables
  FROM pg_tables
  WHERE schemaname = 'public' AND tableowner = 'api_user';

  IF v_owned_tables > 0 THEN
    RAISE EXCEPTION 'ROLE_VERIFY_FAILED: api_user must not own tables in public schema (found %)', v_owned_tables;
  END IF;

  -- 5. Check information_schema.role_table_grants for forbidden permissions
  FOR v_forbidden_grant IN
    SELECT table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE grantee = 'api_user'
      AND table_schema = 'public'
      AND table_name IN ('ledger_entries', 'audit_log')
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
  LOOP
    RAISE EXCEPTION 'ROLE_VERIFY_FAILED: Forbidden privilege % granted to api_user on table %',
      v_forbidden_grant.privilege_type, v_forbidden_grant.table_name;
  END LOOP;

  -- 6. Check has_table_privilege directly for ledger_entries and audit_log
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ledger_entries') THEN
    IF has_table_privilege('api_user', 'public.ledger_entries', 'UPDATE') THEN
      RAISE EXCEPTION 'ROLE_VERIFY_FAILED: api_user has UPDATE privilege on ledger_entries';
    END IF;
    IF has_table_privilege('api_user', 'public.ledger_entries', 'DELETE') THEN
      RAISE EXCEPTION 'ROLE_VERIFY_FAILED: api_user has DELETE privilege on ledger_entries';
    END IF;
    IF has_table_privilege('api_user', 'public.ledger_entries', 'TRUNCATE') THEN
      RAISE EXCEPTION 'ROLE_VERIFY_FAILED: api_user has TRUNCATE privilege on ledger_entries';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_log') THEN
    IF has_table_privilege('api_user', 'public.audit_log', 'UPDATE') THEN
      RAISE EXCEPTION 'ROLE_VERIFY_FAILED: api_user has UPDATE privilege on audit_log';
    END IF;
    IF has_table_privilege('api_user', 'public.audit_log', 'DELETE') THEN
      RAISE EXCEPTION 'ROLE_VERIFY_FAILED: api_user has DELETE privilege on audit_log';
    END IF;
    IF has_table_privilege('api_user', 'public.audit_log', 'TRUNCATE') THEN
      RAISE EXCEPTION 'ROLE_VERIFY_FAILED: api_user has TRUNCATE privilege on audit_log';
    END IF;
  END IF;

  RAISE NOTICE 'SUCCESS: api_user role and permissions verified cleanly.';
END
$$;
