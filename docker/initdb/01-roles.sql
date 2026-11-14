-- 01-roles.sql
-- Broke Travelers Database Roles & Initialization Script (Local Docker Environment)

-- 1. Create Application and Migration Roles
DO $$
BEGIN
  -- CREATEROLE is needed so the bootstrap integration test can create a throwaway role;
  -- mirrors the Neon project owner (which has CREATEROLE); local/CI environment only.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'migration_owner') THEN
    CREATE ROLE migration_owner WITH LOGIN CREATEDB CREATEROLE PASSWORD 'migration_owner_local_dev_secret';
  ELSE
    ALTER ROLE migration_owner CREATEDB CREATEROLE;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'api_user') THEN
    CREATE ROLE api_user WITH LOGIN PASSWORD 'api_user_local_dev_secret' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

-- 2. Create the Test Database
SELECT 'CREATE DATABASE broke_travelers_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'broke_travelers_test')\gexec

-- Grant database ownership / connect permissions
GRANT CONNECT ON DATABASE broke_travelers TO migration_owner, api_user;
GRANT CONNECT ON DATABASE broke_travelers_test TO migration_owner, api_user;

ALTER DATABASE broke_travelers OWNER TO migration_owner;
ALTER DATABASE broke_travelers_test OWNER TO migration_owner;

-- 3. Configure Development Database Privileges
\connect broke_travelers

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO migration_owner;
GRANT USAGE ON SCHEMA public TO api_user;

ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO api_user;

ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO api_user;

-- 4. Configure Test Database Privileges
\connect broke_travelers_test

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO migration_owner;
GRANT USAGE ON SCHEMA public TO api_user;

ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO api_user;

ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO api_user;
