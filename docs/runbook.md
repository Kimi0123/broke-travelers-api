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
| `DATABASE_URL` | Pooled PostgreSQL connection string (for runtime traffic) | Platform Secret (Render / .env) |
| `DIRECT_URL` | Direct (non-pooled) connection string (for developer migrations & role setup; NOT set on Render) | Developer Session |
| `FIREBASE_PROJECT_ID` | Firebase project ID for server-side token verification | Platform Secret (Render) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Raw JSON string **or** base64-encoded service account key | Platform Secret (Render) |
| `TRUST_PROXY_HOPS` | Number of reverse proxy hops (configured as `1` in `render.yaml`) | render.yaml / Env |
| `REQUIRE_VERIFIED_EMAIL` | Require email verification (`false` in `render.yaml` for staging; `true` once UI is ready) | render.yaml / Env |
| `LOG_LEVEL` | Application logging verbosity (`info` in `render.yaml`) | render.yaml / Env |
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
# Note: DIRECT_URL uses the direct (non-pooler) host; DATABASE_URL uses the pooled host.
# Always use sslmode=verify-full to avoid pg driver deprecation warnings.
$env:DIRECT_URL   = "postgresql://neondb_owner:password@ep-sample.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full"
$env:DATABASE_URL = "postgresql://api_user:password@ep-sample-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full"

# Verify targets before executing any database command:
.\scripts\show-db-target.ps1
```

Confirm that the output indicates `Targets REMOTE / MANAGED database` and that the host is **not**
`localhost` or `127.0.0.1`.

---

## 3. Managed Database Bootstrap, Migrations, and Least-Privilege Role Setup

When provisioning a managed PostgreSQL database (e.g. Neon), the execution order is critical:
The initial migration grants privileges to `api_user`, so **`api_user` must exist before migrations are deployed**.

The exact execution sequence is:
1. **Set Session Variables**: Set `$env:DIRECT_URL` (direct host) and `$env:API_USER_PASSWORD` in your active session.
2. **Bootstrap Database (`npm run db:bootstrap`)**: Creates the `api_user` role and grants `CONNECT` on the database.
3. **Deploy Migrations (`npm run db:deploy`)**: Runs Prisma migrations using `DIRECT_URL`, creating application tables and initial grants.
4. **Apply Role Permissions & Append-Only Guarantees (`managed-db-roles.sql`)**: Configures default privileges, view grants, and revokes mutation on append-only tables.
5. **Verify Role Constraints (`npm run db:verify-roles`)**: Validates that `api_user` cannot perform DDL or alter ledger history.

### Step 1 — Session Environment Configuration

Store the owner connection string and desired application password in session variables:

```powershell
# Set direct owner connection (using direct non-pooler host and sslmode=verify-full):
$env:DIRECT_URL = "postgresql://neondb_owner:<owner_password>@ep-sample.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full"

# Set a strong, random password for the application user:
$env:API_USER_PASSWORD = "<strong_random_password>"

# Verify targets before executing:
.\scripts\show-db-target.ps1
```

> [!NOTE]
> **SSL Mode**: Always specify `sslmode=verify-full` on managed databases (e.g. Neon) to avoid pg driver SSL deprecation warnings and ensure strict TLS verification.
> **Host Endpoints**: `DIRECT_URL` and `BACKUP_DATABASE_URL` **must** connect to the direct host (e.g. `ep-sample...`), never the connection pooler endpoint (`-pooler`). The runtime `DATABASE_URL` uses the `-pooler` endpoint.

### Step 2 — Bootstrap the Database (`npm run db:bootstrap`)

Execute the bootstrap script to create `api_user` and grant `CONNECT`:

```powershell
npm run db:bootstrap   # executes scripts/db-bootstrap.js
```

**Variant A — Using local `psql`:**
```powershell
psql "$env:DIRECT_URL" -v api_password="$env:API_USER_PASSWORD" -f scripts/sql/managed-db-bootstrap.sql
```

**Variant B — Using Docker (if `psql` is not installed on the Windows host):**
```powershell
docker run --rm -it -v "${PWD}\scripts:/scripts" postgres:17 psql "$env:DIRECT_URL" -v api_password="$env:API_USER_PASSWORD" -f /scripts/sql/managed-db-bootstrap.sql
```

The bootstrap step creates `api_user` with `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT` and grants `CONNECT` on the database. It is idempotent (running it again safely updates the password).

### Step 3 — Run Database Migrations (`npm run db:deploy`)

Database migrations **must** connect using `DIRECT_URL` (the direct, non-pooled connection with owner privileges):

```powershell
npm run db:deploy   # executes: prisma migrate deploy
```

Prisma creates all schemas, tables, indices, triggers, and applies initial table grants to `api_user`. Migrations are forward-only and idempotent; already-applied migrations are safely skipped.

### Step 4 — Apply Advanced Role Permissions & Append-Only Guarantees (`managed-db-roles.sql`)

Once tables exist, configure default privileges, views, and ledger append-only immutability.

> [!IMPORTANT]
> `managed-db-roles.sql` **must** be executed using the **OWNER / DIRECT connection string** (`$env:DIRECT_URL`),
> **never** with the `api_user` connection string (`DATABASE_URL`). An unprivileged user cannot grant
> permissions or alter roles.

**Variant A — Using local `psql`:**
```powershell
psql "$env:DIRECT_URL" -v api_password="$env:API_USER_PASSWORD" -f scripts/sql/managed-db-roles.sql
```

**Variant B — Using Docker:**
```powershell
docker run --rm -it -v "${PWD}\scripts:/scripts" postgres:17 psql "$env:DIRECT_URL" -v api_password="$env:API_USER_PASSWORD" -f /scripts/sql/managed-db-roles.sql
```

The script is idempotent and performs the following least-privilege setup:
- Grants `USAGE` on schema `public` and strictly revokes `CREATE` on schema `public` from `api_user`.
- Sets default privileges so future tables and sequences automatically grant `SELECT, INSERT, UPDATE` to `api_user`.
- Grants `SELECT` on `v_activity_items`.
- Enforces append-only security: strictly revokes `UPDATE, DELETE, TRUNCATE` on `ledger_entries` and `audit_log`.

### Step 5 — Verify Role Constraints (`npm run db:verify-roles`)

Set `DATABASE_URL` using the newly created `api_user` credentials and run the verification test:

```powershell
$env:DATABASE_URL = "postgresql://api_user:<strong_random_password>@ep-sample-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full"
npm run db:verify-roles   # runs scripts/verify-roles.js
```

This automated verification asserts that `api_user` cannot perform DDL, cannot alter role privileges,
and is physically blocked by database permissions from modifying or truncating the financial ledger.

---

## 4. Recovering from a Failed Migration ("Migration Failed Halfway")

If a migration fails midway (for example, if `npm run db:deploy` was run before `api_user` existed, or if a DDL syntax or connection error occurred), Prisma marks the migration as failed in the `_prisma_migrations` tracking table. Subsequent runs of `prisma migrate deploy` will abort with an error indicating a failed migration.

*(Note: These recovery procedures are documented operational patterns based on PostgreSQL and Prisma specifications; they are not executed against live Neon instances during local development).*

### Detection
A failed migration is detected by checking the `_prisma_migrations` table or running `prisma migrate status`:
```powershell
npx prisma migrate status
```
Or via SQL query on `$env:DIRECT_URL`:
```sql
SELECT migration_name, started_at, finished_at, rolled_back_at
FROM _prisma_migrations
WHERE finished_at IS NULL;
```
If a row has `finished_at IS NULL` and `rolled_back_at IS NULL`, the migration failed halfway, leaving partial tables or objects.

### Scenario A — Brand-New Empty Database Recovery (DESTRUCTIVE)
> [!CAUTION]
> **DESTRUCTIVE OPERATION**: The following recovery procedure completely wipes all objects in schema `public`.
> **NEVER** run this on a database containing production or historical user data. Use this ONLY on a brand-new, freshly provisioned database during initial setup.

On a fresh database with no production data, the cleanest recovery is to reset schema `public` and restart from Step 2:

```powershell
# Drop and recreate schema public using the owner connection:
psql "$env:DIRECT_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO neondb_owner; GRANT ALL ON SCHEMA public TO public;"
```
*(Or in Docker: `docker run --rm postgres:17 psql "$env:DIRECT_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO neondb_owner; GRANT ALL ON SCHEMA public TO public;"`)*

Then rerun the bootstrap sequence in order:
1. `npm run db:bootstrap`
2. `npm run db:deploy`
3. Run `managed-db-roles.sql`
4. `npm run db:verify-roles`

### Scenario B — Database Containing Data (Non-Destructive)
If the database already contains data:
1. Identify the specific error in the migration output.
2. Connect using `$env:DIRECT_URL` and manually revert or complete any partial DDL changes made by the failing migration step.
3. Mark the migration as rolled back in Prisma's tracking table:
   ```powershell
   npx prisma migrate resolve --rolled-back "<migration_name>"
   ```
4. Fix the root cause (e.g. missing permissions, role, or conflicting object).
5. Rerun `npm run db:deploy`.

---

## 5. Deploying to Render

The service is configured in `render.yaml` at the repository root. The build command is `npm ci --include=dev && npm run build` (ensuring devDependencies like `typescript` and `prisma` CLI are available despite `NODE_ENV=production`).

1. Connect your GitHub repository to your Render account.
2. Render detects `render.yaml` and provisions the web service in `singapore`.
3. In the Render Dashboard under **Environment**, configure the required secret variables (Render needs only these three secrets; all other configuration is supplied by `render.yaml`):
   - `DATABASE_URL`: The **pooled** connection URL using `api_user` with the `-pooler` host (e.g. `postgresql://api_user:...@ep-...-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full`).
   - `FIREBASE_PROJECT_ID`: Your Firebase project ID.
   - `FIREBASE_SERVICE_ACCOUNT_JSON`: Your Firebase service account credentials JSON (base64-encoded string recommended, or raw JSON).
   *(Note: `DIRECT_URL` is intentionally omitted from Render as runtime traffic only uses `DATABASE_URL`; migrations run from the developer machine. `TRUST_PROXY_HOPS: '1'`, `REQUIRE_VERIFIED_EMAIL: 'false'` for staging, and `LOG_LEVEL: 'info'` are defined in `render.yaml`).*
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

### Required GitHub Secrets for Backups
Configure the following secrets in GitHub Repository Settings → **Secrets and variables** → **Actions**:
1. `BACKUP_DATABASE_URL`: Direct (non-pooled) PostgreSQL connection string (e.g. `postgresql://neondb_owner:...@ep-sample.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full`).
   > [!WARNING]
   > Do **not** use a connection pooler host (`-pooler`) for backups. `pg_dump` requires a direct connection to snapshot database state without transaction pooling timeouts or protocol limitations.
2. `BACKUP_ENCRYPTION_KEY`: A strong, randomly generated symmetric passphrase used by GPG AES-256 to encrypt the dump archive.
   > [!CRITICAL]
   > **Keep a copy of `BACKUP_ENCRYPTION_KEY` outside the repository** (e.g. in your secure 1Password or Bitwarden team vault). If this key is lost, backup archives cannot be decrypted and data cannot be recovered in a disaster recovery scenario.

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
> 1. `npm run db:bootstrap` (Section 3, Step 2)
> 2. `managed-db-roles.sql` (Section 3, Step 4)
> 3. `npm run db:verify-roles` (Section 3, Step 5)
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
