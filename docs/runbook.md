# Broke Travelers API — Deployment Runbook

> **Scope**: This runbook covers deploying to Render + a managed PostgreSQL (e.g. Neon), running
> migrations, verifying database roles, running the smoke test, monitoring health, and restoring
> from a backup. All commands are PowerShell unless noted.

---

## 1. Prerequisites

### Environment Variables (Required in Production)

| Variable | Description |
|---|---|
| `DATABASE_URL` | Pooled Postgres connection (e.g. Neon pooled) |
| `DIRECT_URL` | Direct (non-pooled) connection — migrations only |
| `FIREBASE_PROJECT_ID` | Firebase project ID for token verification |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Raw JSON **or** base64-encoded service account key |
| `TRUST_PROXY_HOPS` | Number of reverse proxy hops (usually `1` on Render) |
| `REQUIRE_VERIFIED_EMAIL` | `true` or `false` |
| `LOG_LEVEL` | `info`, `warn`, or `error` |
| `BACKUP_DATABASE_URL` | Direct URL used by GitHub Actions backup job |
| `BACKUP_ENCRYPTION_KEY` | GPG symmetric passphrase for backup encryption |

> [!IMPORTANT]
> Never commit real credentials. All secrets above must be injected by the platform (Render
> environment, GitHub repository secrets). Placeholder values such as `changeme` or empty strings
> are rejected on startup in `NODE_ENV=production`.

---

## 2. Deploying to Render

The service is defined in `render.yaml` at the repository root.

1. Connect the GitHub repository to your Render account.
2. Render auto-detects `render.yaml` and creates the web service.
3. Set each environment variable listed above in the Render dashboard under **Environment**.
4. Render builds with:
   ```
   npm ci && npm run build
   ```
5. Render starts with:
   ```
   npm run start:prod   # node dist/server.js
   ```
6. Health check path: `GET /v1/health/ready` — Render marks the deployment healthy when this returns `200`.

> [!NOTE]
> The service uses `region: singapore`. Change in `render.yaml` → `region` to match your user base.

---

## 3. Running Database Migrations

**Requires** `DIRECT_URL` to be set (superuser or migration-owner credentials).

```powershell
npm run db:deploy   # prisma migrate deploy
```

This applies all pending migrations in `prisma/migrations/` in order. It is safe to run on every
deploy; already-applied migrations are skipped.

> [!CAUTION]
> Never edit a migration file that has already been applied to any environment. Add a new migration
> instead.

---

## 4. Database Role Setup and Verification

After creating a fresh managed database or after a major Postgres upgrade:

**Step 1 — Create / update the runtime role:**
```powershell
psql -d $env:DATABASE_URL -v "api_password='<runtime_password>'" -f scripts/sql/managed-db-roles.sql
```
The script is idempotent and safe to re-run. It:
- Creates `api_user` with LOGIN and no superuser privileges
- Grants CONNECT, USAGE on the schema, SELECT/INSERT/UPDATE on application tables
- Grants SELECT/INSERT only on `ledger_entries` and `audit_log` (no UPDATE/DELETE/TRUNCATE)

**Step 2 — Verify the role constraints:**
```powershell
npm run db:verify-roles   # node scripts/verify-roles.js
```
Exits 0 on success; prints which check failed and exits 1 on failure.

---

## 5. Smoke Test

Run after every deployment to verify the live server is functional.

```powershell
.\scripts\smoke-test.ps1 -BaseUrl https://<your-service>.onrender.com
```

Checks:
1. `GET /v1/health` → 200 `{ status: 'ok' }` (liveness)
2. `GET /v1/health/ready` → 200 `{ status: 'ready' }` (DB reachable)
3. `GET /v1/profile` unauthenticated → 401 with `code: 'unauthenticated'`
4. `X-Content-Type-Options: nosniff` header present
5. `X-Powered-By` header absent

Optionally provide a Firebase ID token for an authenticated profile check:
```powershell
.\scripts\smoke-test.ps1 -BaseUrl https://... -TestToken "<firebase_id_token>"
```

---

## 6. Health Endpoints

| Endpoint | Purpose | Expected |
|---|---|---|
| `GET /v1/health` | Shallow liveness — always cheap, no DB query | `200 { status: 'ok' }` |
| `GET /v1/health/ready` | Deep readiness — runs `SELECT 1` via Prisma | `200 { status: 'ready' }` or `503 { status: 'unready' }` |

Both endpoints are rate-limited (120 req/min) and publicly accessible without authentication.

> [!NOTE]
> On cold start (e.g. free-tier Render spin-up), the service runs up to 5 database connectivity
> retries with exponential back-off (max 8 s between attempts) before accepting traffic. During this
> window Render will see the health check fail — this is expected and resolves automatically.

---

## 7. Automated Backups

Backups are scheduled daily at **02:30 NPT** (20:45 UTC) via `.github/workflows/backup.yml`.

**Secrets required** in the GitHub repository (Settings → Secrets → Actions):

| Secret | Description |
|---|---|
| `BACKUP_DATABASE_URL` | Direct Postgres URL with read privileges |
| `BACKUP_ENCRYPTION_KEY` | GPG symmetric passphrase |

Backups are stored as GitHub Actions artifacts with **30-day retention**.

**Manual trigger:**
1. GitHub → Actions → "Scheduled Database Backup" → Run workflow

---

## 8. Restore Drill

The restore drill spins up a throwaway Postgres 17 container, copies the latest dump into it, and
verifies schema integrity.

```powershell
.\scripts\restore-drill.ps1
```

What it does:
1. Dumps the live `broke-travelers-db` Docker container to a temp file.
2. Starts a throwaway `postgres:17-alpine` container on port 5534.
3. Copies the dump and restores it with `pg_restore`.
4. Runs an integrity verification query (row counts, balance math).
5. Tears down the throwaway container.

> [!IMPORTANT]
> Run the drill after any significant schema migration to confirm backup fidelity before an incident.
> Requires Docker Desktop to be running and the main `broke-travelers-db` container to be healthy.

---

## 9. Rollback

To roll back to a previous deploy on Render:

1. Render dashboard → your service → **Deploys**.
2. Find the last known-good deploy and click **Redeploy**.

There is no automated database rollback. Migrations are forward-only. If a migration introduced
a problem, write a new corrective migration.

---

## 10. Troubleshooting

### Server fails to start — missing env vars
The startup log lists the NAMES (never values) of missing or placeholder variables:
```
[STARTUP FAILED] Missing or invalid environment variables: DATABASE_URL, FIREBASE_PROJECT_ID
```
Set the listed variables in the Render environment and redeploy.

### `/v1/health/ready` returns 503
- Managed Postgres may be warming up (wait 10–30 s and retry).
- Verify `DATABASE_URL` is the **pooled** URL and credentials are correct.
- Check the Render service logs for `Database connectivity check failed` messages.

### Integration tests fail locally with "unreachable"
```powershell
npm run db:up   # starts broke-travelers-db Docker container
```

### Port 3000 inaccessible locally (Windows Hyper-V port exclusion)
On Windows, Hyper-V may exclude port ranges including 3000:
```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```
If 3000 is excluded, change `PORT=` in `.env` to an available port (e.g. `4000`) and restart the server.

### Prisma client not generated
```powershell
npm run prisma:generate
```
(`npm ci` triggers this automatically via postinstall.)
