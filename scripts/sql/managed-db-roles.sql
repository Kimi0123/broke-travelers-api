-- scripts/sql/managed-db-roles.sql
-- Idempotent role creation and least-privilege setup for managed PostgreSQL (Neon / Staging / Production).
-- To be run once by the database owner (Neon project owner / migration_owner).
-- Usage: psql -v api_password='<secure_password>' -f scripts/sql/managed-db-roles.sql

\set ON_ERROR_STOP on

-- 1. Create api_user if it does not exist, or update password if it exists
SELECT format(
  'CREATE ROLE api_user WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
  :'api_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_user')\gexec

SELECT format(
  'ALTER ROLE api_user WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
  :'api_password'
)
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_user')\gexec

-- 2. Grant CONNECT on current database to api_user
SELECT format('GRANT CONNECT ON DATABASE %I TO api_user', current_database())\gexec

-- 3. Schema privileges: USAGE only, strictly NO DDL (REVOKE CREATE)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM api_user;
GRANT USAGE ON SCHEMA public TO api_user;

-- 4. Default privileges: Ensure future tables/sequences created in public schema grant least-privilege access to api_user
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO api_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO api_user;

-- 5. Existing tables & sequences (grants for any existing tables)
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO api_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api_user;

-- 6. Grant SELECT on views if they exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_activity_items') THEN
    GRANT SELECT ON v_activity_items TO api_user;
  END IF;
END
$$;

-- 7. Grant DELETE on invitation_attempts if it exists (for opportunistic rate-limit cleanup)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'invitation_attempts') THEN
    GRANT DELETE ON invitation_attempts TO api_user;
  END IF;
END
$$;

-- 8. Enforce append-only on ledger_entries and audit_log: strictly REVOKE UPDATE, DELETE, TRUNCATE
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ledger_entries') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries FROM api_user, PUBLIC;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_log') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM api_user, PUBLIC;
  END IF;
END
$$;
