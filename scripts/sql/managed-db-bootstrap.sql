-- scripts/sql/managed-db-bootstrap.sql
-- Managed DB bootstrap script for creating role api_user BEFORE running initial migrations.
-- To be run once by the database owner (Neon project owner / migration_owner) using psql.
-- Usage:
--   psql "$DIRECT_URL" -v api_password="$API_USER_PASSWORD" -f scripts/sql/managed-db-bootstrap.sql
--
-- Note: This only creates/updates the role and grants CONNECT on the database.
-- Table, schema, and sequence grants are handled by Prisma migrations and managed-db-roles.sql.

\set ON_ERROR_STOP on

-- 1. Create role api_user if missing, or update password if it exists
SELECT format(
  'CREATE ROLE api_user WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
  :'api_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_user')\gexec

SELECT format(
  'ALTER ROLE api_user WITH LOGIN PASSWORD %L',
  :'api_password'
)
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_user')\gexec

-- 2. Grant CONNECT on current database to api_user
SELECT format('GRANT CONNECT ON DATABASE %I TO api_user', current_database())\gexec
