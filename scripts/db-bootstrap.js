#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { URL, fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';

const PLACEHOLDERS = new Set([
  'changeme',
  'placeholder',
  'secret',
  'xxx',
  'your-secret',
]);

export function isPlaceholderOrBlank(val) {
  if (val === undefined || val === null) return true;
  const trimmed = String(val).trim();
  if (trimmed.length === 0) return true;
  return PLACEHOLDERS.has(trimmed.toLowerCase());
}

export function validateBootstrapEnv(env = process.env) {
  const invalidVars = [];
  const directUrl = env['DIRECT_URL'];
  const apiUserPassword = env['API_USER_PASSWORD'];

  if (isPlaceholderOrBlank(directUrl)) {
    invalidVars.push('DIRECT_URL');
  }
  if (isPlaceholderOrBlank(apiUserPassword)) {
    invalidVars.push('API_USER_PASSWORD');
  }

  if (invalidVars.length > 0) {
    throw new Error(
      `Missing or invalid environment variables: ${invalidVars.join(', ')}`,
    );
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(directUrl);
  } catch {
    throw new Error('Invalid DIRECT_URL: cannot parse connection string');
  }

  if (parsedUrl.hostname.includes('-pooler')) {
    throw new Error(
      'DIRECT_URL points to a pooled endpoint (-pooler); database bootstrap requires the direct owner connection',
    );
  }

  const roleName =
    env['API_USER_ROLE_NAME'] &&
    !isPlaceholderOrBlank(env['API_USER_ROLE_NAME'])
      ? String(env['API_USER_ROLE_NAME']).trim()
      : 'api_user';

  const dbName = parsedUrl.pathname.replace(/^\//, '') || 'postgres';

  return {
    directUrl: String(directUrl).trim(),
    apiUserPassword: String(apiUserPassword).trim(),
    roleName,
    host: parsedUrl.hostname,
    database: dbName,
  };
}

export async function runBootstrap(env = process.env) {
  const config = validateBootstrapEnv(env);
  const client = new pg.Client({ connectionString: config.directUrl });

  try {
    await client.connect();

    const infoRes = await client.query(
      'SELECT current_user AS role, current_database() AS db',
    );
    const connectingRole = infoRes.rows[0]?.role ?? 'unknown';
    const dbName = infoRes.rows[0]?.db ?? config.database;

    console.log(`[db-bootstrap] Target host: ${config.host}`);
    console.log(`[db-bootstrap] Database name: ${dbName}`);
    console.log(`[db-bootstrap] Connecting role: ${connectingRole}`);
    console.log(`[db-bootstrap] Target role: ${config.roleName}`);

    // Check if role exists
    const checkRole = await client.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [config.roleName],
    );

    let formatSql;
    if (checkRole.rowCount === 0) {
      formatSql =
        "SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', $1::text, $2::text) AS stmt";
    } else {
      formatSql =
        "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS stmt";
    }

    const formatResult = await client.query(formatSql, [
      config.roleName,
      config.apiUserPassword,
    ]);
    const ddlStmt = formatResult.rows[0].stmt;
    await client.query(ddlStmt);

    // Grant CONNECT on current database
    const grantResult = await client.query(
      "SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text) AS stmt",
      [config.roleName],
    );
    await client.query(grantResult.rows[0].stmt);

    console.log(
      `[db-bootstrap] Successfully bootstrapped role '${config.roleName}' and granted CONNECT on database '${dbName}'.`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) ===
    path.resolve(process.argv[1]);

if (isMain) {
  try {
    await runBootstrap();
    process.exit(0);
  } catch (err) {
    console.error(`[db-bootstrap] Error: ${err.message}`);
    process.exit(1);
  }
}
