# Broke Travelers API — Deployment Runbook

> **Scope**: This runbook covers deploying to Render + a managed PostgreSQL database (e.g. Neon),
> running migrations, verifying least-privilege database roles, running smoke tests, monitoring health,
> and restoring from an encrypted backup. All commands use PowerShell unless noted.

---

## 1. Prerequisites

### Engine & Platform Requirements

> [!IMPORTANT]
> **PostgreSQL 17 Requirement**: The managed PostgreSQL project (e.g. Neon) **must** be created
> with **PostgreSQL 17** to match the local Docker container engine, the migration schema, and the
> backup workflow `pg_dump` / `pg_restore` client.

### Environment Variables (Required in Production)

| Variable | Description | Source |
|---|---|---|
| `DATABASE_URL` | Pooled PostgreSQL connection string (for runtime traffic) | Platform Secret |
| `DIRECT_URL` | Direct (non-pooled) PostgreSQL connection string (for migrations & role setup) | Platform Secret |
| `FIREBASE_PROJECT_ID` | Firebase project ID for server-side token verification | Platform Secret |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Raw JSON string **or** base64-encoded service account key | Platform Secret |
| `TRUST_PROXY_HOPS` | Number of reverse proxy hops (e.g. `1` on Render) | Fixed / Env |
| `REQUIRE_VERIFIED_EMAIL` | Require email verification before API access (`true` or `false`) | Fixed / Env |
| `LOG_LEVEL` | Application logging verbosity (`info`, `warn`, or `error`) | Fixed / Env |
| `BACKUP_DATABASE_URL` | Direct PostgreSQL connection string for daily backup job | GitHub Secret |
| `BACKUP_ENCRYPTION_KEY` | GPG symmetric passphrase for AES256 backup encryption | GitHub Secret |

> [!CAUTION]
> Never commit real credentials or secrets to version control. Placeholder values such as
> `changeme`, `secret`, `placeholder`, or empty strings are rejected on startup in `NODE_ENV=production`.

---

## 2. Target Database Safety & Session Verification

> [!WARNING]
> **Never rely on the local `.env` file when executing production commands.**
> The `.env` file contains local development credentials (`localhost:5533`).
> Before running `npm run db:deploy`, role creation, or smoke tests, explicitly set `DIRECT_URL`
> and `DATABASE_URL` in your active PowerShell session, and verify the target host.

Use the provided helper script `scripts/show-db-target.ps1` to print the target host and database name
without ever revealing usernames or passwords:

```powershell
# Set production URLs in your current PowerShell session:
$env:DIRECT_URL   = "postgresql://neondb_owner:password@ep-sample-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"
$env:DATABASE_URL = "postgresql://api_user:password@ep-sample-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"

# Verify targets before executing any database command:
.\scripts\show-db-target.ps1
```

Confirm that the output indicates `Targets REMOTE / MANAGED database` and that the host is **not**
`localhost` or `127.0.0.1`.

---

## 3. Database Role Setup and Verification

Managed databases require two roles:
1. **Database Owner (`neondb_owner` / `migration_owner`)**: Has DDL privileges, owns all tables, and executes migrations.
2. **Application User (`api_user`)**: Least-privilege runtime role used by the running web service.

> [!IMPORTANT]
> `managed-db-roles.sql` **must** be executed using the **OWNER / DIRECT connection string** (`$env:DIRECT_URL`),
> **never** with the `api_user` connection string (`DATABASE_URL`). An unprivileged user cannot grant
> permissions or alter roles.

### Step 1 — Create / Update `api_user`

Store the desired password in a session variable to avoid recording secrets in PowerShell command history:

```powershell
# Generate a strong password and set it in the session variable
$env:API_USER_PASSWORD = "<strong_random_password>"
```

**Variant A — Using local `psql` (if PostgreSQL client is installed on Windows):**
```powershell
# Pass $env:API_USER_PASSWORD to psql variable 'api_password' without extra quotes
psql "$env:DIRECT_URL" -v api_password="$env:API_USER_PASSWORD" -f scripts/sql/managed-db-roles.sql
```

**Variant B — Using Docker (if `psql` is not installed on the Windows host):**
```powershell
docker run --rm -it -v "${PWD}\scripts:/scripts" postgres:17 psql "$env:DIRECT_URL" -v api_password="$env:API_USER_PASSWORD" -f /scripts/sql/managed-db-roles.sql
```

The script is idempotent and performs the following least-privilege setup:
- Creates `api_user` with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT` if missing, or updates password if present.
- Grants `CONNECT` on the current database and `USAGE` on schema `public`.
- Strictly revokes `CREATE` on schema `public` from `api_user`.
- Grants `SELECT, INSERT, UPDATE` on application tables.
- Enforces append-only security: strictly revokes `UPDATE, DELETE, TRUNCATE` on `ledger_entries` and `audit_log`.

### Step 2 — Verify Role Constraints

Set `DATABASE_URL` using the newly created `api_user` credentials and run the verification test:

```powershell
$env:DATABASE_URL = "postgresql://api_user:<strong_random_password>@<neon-host>/neondb?sslmode=require"
npm run db:verify-roles   # runs scripts/verify-roles.js
```

This automated verification asserts that `api_user` cannot perform DDL, cannot alter role privileges,
and is physically blocked by database permissions from modifying or truncating the financial ledger.

---

## 4. Running Database Migrations

Database migrations **must** connect using `DIRECT_URL` (the direct, non-pooled connection with owner privileges):

```powershell
# Confirm target is remote
.\scripts\show-db-target.ps1

# Apply all pending migrations
npm run db:deploy   # executes: prisma migrate deploy
```

Migrations are forward-only and idempotent; already-applied migrations are safely skipped.

---

## 5. Deploying to Render

The service is configured in `render.yaml` at the repository root.

1. Connect your GitHub repository to your Render account.
2. Render detects `render.yaml` and provisions the web service in `singapore`.
3. In the Render Dashboard under **Environment**, configure:
   - `DATABASE_URL`: The **pooled** connection URL using `api_user` (e.g. `postgresql://api_user:...@ep-...-pooler.../neondb?sslmode=require`).
   - `DIRECT_URL`: The **direct** connection URL for migrations.
   - `FIREBASE_PROJECT_ID`: Your Firebase project ID.
   - `FIREBASE_SERVICE_ACCOUNT_JSON`: Your Firebase service account credentials JSON.
   - `TRUST_PROXY_HOPS`: `1`
   - `REQUIRE_VERIFIED_EMAIL`: `true` (or `false` for staging).
   - `LOG_LEVEL`: `info`
4. Deploy the service.
5. Render performs health checks against `GET /v1/health/ready`. When this endpoint returns `200 { status: 'ready' }`, traffic is routed to the new deployment.

---

## 6. Smoke Testing the Deployment

Run the smoke test script against your live deployment URL to verify operational integrity:

```powershell
.\scripts\smoke-test.ps1 -BaseUrl https://<your-service>.onrender.com
```

The script executes 5 automated checks:
1. `GET /v1/health` → `200` with `{ status: "ok" }` (shallow liveness check).
2. `GET /v1/health/ready` → `200` with `{ status: "ready" }` (deep database readiness check).
3. `GET /v1/profile` unauthenticated → `401` with `code: "unauthenticated"`.
4. Security header `X-Content-Type-Options: nosniff` present.
5. `X-Powered-By` header stripped.

To verify authenticated profile resolution, supply a valid Firebase ID token:
```powershell
.\scripts\smoke-test.ps1 -BaseUrl https://<your-service>.onrender.com -TestToken "<firebase_jwt>"
```

---

## 7. Automated Backups & Artifact Verification

Automated backups run daily at **02:30 NPT** (20:45 UTC) via `.github/workflows/backup.yml`.

- **Engine**: Runs inside the official `postgres:17` container to guarantee exact client/server version parity.
- **Parameters**: `pg_dump -Fc --no-owner --no-privileges` (custom compressed format).
- **Sanitization**: Automatically strips Prisma-only URI parameters (`?schema=public`) that libpq rejects.
- **Size Validation**: Fails if the dump file is under 10 KB (an empty schema dump is ~48 KB).
- **Encryption**: Encrypted via GPG symmetric cipher (`AES256`) reading passphrase from stdin.
- **Automated Verification**: In the same workflow, the `.gpg` file is decrypted to a temporary dump and verified via `pg_restore --list` to confirm table-of-contents presence of `ledger_entries` and `audit_log`.
- **Retention**: Uploaded to GitHub Actions artifacts with **30-day retention**.

### Manual Backup Trigger
To trigger an immediate backup outside the daily schedule:
GitHub → **Actions** → **Database Backup** → **Run workflow**.

---

## 8. Restoring from Backup

### A. Local Restore Drill (Automated Test)

To test database restoration locally against a throwaway PostgreSQL 17 Docker container:

```powershell
# Takes a live dump from local container and validates restoration:
.\scripts\restore-drill.ps1
```

### B. Restoring from a Downloaded Backup Artifact

When disaster recovery requires restoring from a GitHub Actions backup artifact (`db-backup-<id>.zip`):

1. Unzip the artifact to obtain `backup.dump.gpg`.
2. Decrypt and verify using `scripts/restore-drill.ps1` directly:
   ```powershell
   # restore-drill.ps1 auto-decrypts .gpg files (prompts for passphrase if not set in env)
   .\scripts\restore-drill.ps1 -DumpFile .\backup.dump.gpg
   ```
   *Or decrypt manually before restoring:*
   ```powershell
   gpg --decrypt -o backup.dump backup.dump.gpg
   .\scripts\restore-drill.ps1 -DumpFile .\backup.dump
   ```

### C. Restoring into Managed / Production PostgreSQL

```powershell
# Decrypt archive
gpg --decrypt -o production_restore.dump backup.dump.gpg

# Restore into target database using DIRECT_URL (owner privileges required)
docker run --rm -v "${PWD}:/work" postgres:17 pg_restore -d "$env:DIRECT_URL" --no-owner --no-privileges /work/production_restore.dump

# Securely remove unencrypted dump
Remove-Item -Force production_restore.dump
```

> [!CRITICAL]
> **Post-Restore Privilege Re-application**:
> Because backups are created with `--no-privileges` for environment portability,
> database role permissions are **not** included in the dump archive.
> **After any database restore, you MUST immediately re-run:**
> 1. `managed-db-roles.sql` (Section 3, Step 1)
> 2. `npm run db:verify-roles` (Section 3, Step 2)
>
> Failing to re-run role setup will cause the API to fail with permission denied errors.

---

## 9. Android SHA-1 Configuration (Prerequisite for Task 5.8)

Before the Flutter mobile app can sign in with Google Firebase Authentication in Task 5.8,
its Android debug signing key fingerprint must be registered in the Firebase Console.

### Step 1 — Extract Debug SHA-1 on Windows

Run Java `keytool` against your local Android debug keystore:

```powershell
keytool -list -v -keystore "$env:USERPROFILE\.android\debug.keystore" -alias androiddebugkey -storepass android -keypass android
```

In the output, locate the line:
```
Certificate fingerprints:
     SHA1: XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX
```

### Step 2 — Register in Firebase Console

1. Navigate to [Firebase Console](https://console.firebase.google.com/) -> Select your project (`broke-travelers-dev` / production).
2. Go to **Project Settings** (gear icon) -> **General** tab.
3. Scroll down to **Your apps** and select your Android application.
4. Click **Add fingerprint**.
5. Paste the extracted SHA-1 fingerprint and click **Save**.
6. Download the updated `google-services.json` file.
7. Place the file at: `C:\Users\Legion\Documents\developer\developer\flutter\broke_travelers\android\app\google-services.json`
   *(Note: strictly during Task 5.8 client integration).*

> [!NOTE]
> The debug keystore fingerprint allows authentication on local emulators and development devices.
> Before building release binaries, the production release keystore SHA-1 must also be added.

---

## 10. Rollback Procedure

To roll back a bad application deployment on Render:
1. Render Dashboard → Web Service → **Deploys**.
2. Identify the last known stable commit.
3. Click **Redeploy**.

*Database Note*: Migrations are forward-only. If a migration needs reversal, apply a new forward
corrective migration via `npm run db:deploy`.
