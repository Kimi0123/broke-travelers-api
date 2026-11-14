#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const connectionString =
  process.env['DIRECT_URL'] ?? process.env['DATABASE_URL'];

if (!connectionString) {
  console.error(
    'Error: Neither DIRECT_URL nor DATABASE_URL environment variable is set.',
  );
  process.exit(1);
}

const sqlPath = path.join(__dirname, 'verify-roles.sql');
const rawSql = fs.readFileSync(sqlPath, 'utf8');

// Strip psql meta-commands (lines starting with \)
const cleanSql = rawSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('\\'))
  .join('\n');

const client = new pg.Client({ connectionString });

async function verifyRoles() {
  try {
    await client.connect();
    client.on('notice', (msg) => {
      console.log(msg.message);
    });

    await client.query(cleanSql);
    console.log('Role verification passed: api_user is properly restricted.');
    process.exit(0);
  } catch (err) {
    console.error('Role verification FAILED:', (err && err.message) || err);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

verifyRoles();
