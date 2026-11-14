# Broke Travelers API

The backend REST API service for Broke Travelers, a group savings recordkeeping application.

Broke Travelers is an immutable financial ledger and group transparency recordkeeping tool. It is NOT a bank, digital wallet, or payment processor. It records and tracks verified balances for travel groups whose financial transactions occur out-of-band.

## Tech Stack
- **Runtime & Language**: Node.js (v22+) with TypeScript (strict mode)
- **Framework**: Express.js 5 with Helmet & Pino
- **Database & ORM**: PostgreSQL 17 with Prisma ORM
- **Authentication**: Firebase Authentication
- **Testing**: Vitest with golden vectors ported from Dart, supertest integration suite

## Current Status
**Phase 5.7 complete — Deployment Preparation.**
Express 5 REST API with Firebase ID token authentication, user session provisioning, groups CRUD, single-use invitations with brute-force lockout, member role management, contribution periods, payment submissions & reviews (with separation of duties and reference masking), transactions & reversals, keyset-paginated unified activity (`v_activity_items`), detailed member history, multi-member approval governance workflow, formal bank statement reconciliations at NPT calendar boundaries, dashboard summaries, aggregated reports (selectable months, monthly, member-wise, annual, outflow with reversal netting), and dynamic per-viewer updates notifications feed with persisted read-state tracking. Production-hardened with startup env validation, liveness/readiness health endpoints, managed database role scripts, Render/Docker deployment config, GitHub Actions encrypted backup workflow, and a PowerShell smoke test + runbook. Verified across 232 unit/vector tests (1 skipped) and 150 integration tests across 28 suites against real PostgreSQL.

## Implemented Endpoints Reference

| Endpoint | Method | Scope / Roles | Description |
|---|---|---|---|
| `/v1/health` | GET | Public | Shallow liveness check — always 200, no DB query |
| `/v1/health/ready` | GET | Public | Deep readiness check — 200 when DB reachable, 503 when not |
| `/v1/session` | POST | Authenticated User | Idempotent user profile provisioning |
| `/v1/profile` | GET | Authenticated User | Current user profile, active roles, and groups |
| `/v1/groups` | POST | Authenticated User | Create group (assigns Owner + Treasurer) |
| `/v1/groups/:id` | GET | Active Member | Group details, contribution amount, member count |
| `/v1/groups/:id/settings` | PATCH | Group Owner | Update group name and due day settings |
| `/v1/groups/:id/invitations` | POST | Group Owner | Issue 8-char single-use invite code (7-day expiry) |
| `/v1/groups/:id/invitations` | GET | Group Owner | List group invitations with dynamic status |
| `/v1/groups/:id/invitations/:invId` | DELETE | Group Owner | Revoke pending invitation |
| `/v1/invitations/accept` | POST | Authenticated User | Accept invitation code (rate limited to 5 fails/5m) |
| `/v1/groups/:id/members` | GET | Active Member | Active members list with derived obligation status |
| `/v1/groups/:id/members/:memberId` | GET | Active Member | Member profile, totals, and monthly history |
| `/v1/groups/:id/members/:memberId/role` | PATCH | Group Owner | Promote/demote treasurer role |
| `/v1/groups/:id/members/:memberId` | DELETE | Group Owner | Soft removal enforcing strict invariant precedence |
| `/v1/groups/:id/contributions/periods` | GET | Active Member | Period summaries from earliest entry to current anchor |
| `/v1/groups/:id/contributions/periods/:periodId` | GET | Active Member | Period detail and member obligation breakdown |
| `/v1/groups/:id/payments` | POST | Active Member | Submit payment with server-derived expected amount & masked ref return |
| `/v1/groups/:id/payments/my` | GET | Active Member | Personal submissions with masked references |
| `/v1/groups/:id/payments/pending` | GET | Treasurer | Pending review queue with unmasked references |
| `/v1/groups/:id/payments/:subId/verify` | POST | Treasurer | Atomic verify, ledger post, and audit log write |
| `/v1/groups/:id/payments/:subId/reject` | POST | Treasurer | Atomic reject with structured reason & note |
| `/v1/groups/:id/transactions` | GET | Active Member | Unified activity feed with keyset pagination |
| `/v1/groups/:id/transactions/:txId` | GET | Active Member | Compound ID lookup (`ledger:<id>` or `submission:<id>`) |
| `/v1/groups/:id/transactions` | POST | Treasurer | Record direct expense or interest entry |
| `/v1/groups/:id/transactions/:txId/reverse` | POST | Treasurer | Reverse expense/interest with balance guard |
| `/v1/groups/:id/approvals` | POST | Active Member | Create approval request with eligible voter snapshot (>= 2 members) |
| `/v1/groups/:id/approvals` | GET | Active Member | List approvals with status/kind filters, keyset pagination, and myVote |
| `/v1/groups/:id/approvals/:reqId` | GET | Active Member | Get approval request detail and voter breakdown |
| `/v1/groups/:id/approvals/:reqId/vote` | POST | Eligible Voter | Cast vote with quorum threshold & early rejection |
| `/v1/groups/:id/approvals/:reqId/cancel` | POST | Requester | Cancel open approval request |
| `/v1/groups/:id/approvals/:reqId/execute` | POST | Treasurer | Execute approved request with separation of duties |
| `/v1/groups/:id/reconciliations` | GET | Active Member | List bank reconciliation records |
| `/v1/groups/:id/reconciliations/recorded-balance` | GET | Active Member | Query recorded balance at NPT statement date cutoff |
| `/v1/groups/:id/reconciliations` | POST | Treasurer | Record bank statement reconciliation against ledger |
| `/v1/groups/:id/dashboard` | GET | Active Member | Complete dashboard metrics (balance, pending, deadlines, activity) |
| `/v1/groups/:id/reports/months` | GET | Active Member | Selectable months and years from group creation to current anchor |
| `/v1/groups/:id/reports/monthly` | GET | Active Member | Monthly statement with opening/closing balances and derived counts |
| `/v1/groups/:id/reports/members` | GET | Active Member | Member obligation report with viewer privacy filtering |
| `/v1/groups/:id/reports/annual` | GET | Active Member | Annual statement with monthly rows and net derivations |
| `/v1/groups/:id/reports/expenses` | GET | Active Member | Annual expenses breakdown with reversal netting |
| `/v1/groups/:id/reports/withdrawals` | GET | Active Member | Annual withdrawals breakdown with reversal netting |
| `/v1/groups/:id/updates` | GET | Active Member | Dynamic per-viewer updates feed (privacy-filtered, up to 50 items) |
| `/v1/groups/:id/updates/read` | POST | Active Member | Idempotently mark specific update IDs as read |
| `/v1/groups/:id/updates/read-all` | POST | Active Member | Idempotently mark all current feed items as read |
| `/v1/groups/:id/updates/unread-count` | GET | Active Member | Dynamic unread updates badge count |

## Run the API Locally

1. **Environment Setup**:
   ```bash
   cp .env.example .env
   # Edit .env: set FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON (Roadmap 5.0c)
   ```

2. **Start Database & Deploy Migrations**:
   ```bash
   npm run db:up       # Starts PostgreSQL on port 5533
   npm run db:migrate  # Applies Prisma migrations and triggers
   ```

3. **Start Development Server**:
   ```bash
   npm run dev         # Starts server on http://localhost:3000
   ```

4. **Example Requests**:
   ```bash
   # Health check (unauthenticated)
   curl http://localhost:3000/v1/health

   # User session provisioning (requires Firebase ID token)
   curl -X POST http://localhost:3000/v1/session \
     -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"displayName": "Nirvan"}'
   ```
   *(Note: The `fake:<uid>:<email>` token syntax is accepted strictly by the in-memory test double `FakeTokenVerifier` inside test suites. Live dev/prod instances require real Firebase ID tokens from the project configured in roadmap 5.0c).*

## Testing & Quality

```bash
npm run verify            # Run lint, format:check, typecheck, build, and test:unit in order
npm run verify:all        # Full verification: runs verify + test:integration against PostgreSQL
npm run test:unit         # Unit & Dart golden vector tests (242 tests, 1 skipped)
npm run test:integration  # Real PostgreSQL integration tests (150 tests across 28 suites)
npm run lint              # ESLint check
npm run format:check      # Prettier format check
npm run typecheck         # TypeScript compiler check (includes test/ directory)
npm run build             # Build TypeScript output to dist/
```
*(Note: `npm ci` generates the Prisma client automatically; run `npm run prisma:generate` after editing `prisma/schema.prisma`).*

## Troubleshooting

### 1. Database Unreachable or Container Not Running
If running `npm run test:integration` or `npm run dev` fails with:
```
[PREFLIGHT CHECK FAILED] Test database is unreachable at localhost:5533.
```
- **Cause**: The PostgreSQL Docker container is stopped or Docker Desktop is not running.
- **Fix**: Verify Docker status with `docker compose ps` and start the database with:
  ```bash
  npm run db:up
  ```
  Check container logs if needed:
  ```bash
  npm run db:logs
  ```

### 2. Missing Prisma Client
If typecheck or test preflight fails with:
```
[PREFLIGHT CHECK FAILED] Prisma client is missing or cannot be imported.
```
- **Cause**: The Prisma client has not been generated into `node_modules/@prisma/client`.
- **Fix**: Run:
  ```bash
  npm run prisma:generate
  ```
  *(Note: `npm ci` automatically generates the client via its postinstall hook).*

### 3. Port 5533 Conflict & Hyper-V Dynamic Port Exclusions (Windows)
- **Cause**: On Windows, Hyper-V or Windows NAT (WinNAT) dynamically reserves TCP port ranges, occasionally conflicting with exposed ports like 5533.
- **Verification**: Check reserved port blocks in PowerShell:
  ```powershell
  netsh interface ipv4 show excludedportrange protocol=tcp
  ```
- **Fix**: If port 5533 falls within a reserved range, restart the WinNAT service in an administrative shell:
  ```powershell
  Restart-Service winnat
  ```
  Alternatively, update the external port mapping in `docker-compose.yml` and the corresponding port in `.env`.

### 4. Resetting or Applying Migrations to the Database
If tables or triggers are out of date:
```bash
npm run db:migrate
```

## Documentation Index
- [`docs/domain-rules.md`](docs/domain-rules.md): Authoritative business rules extracted from Flutter client.
- [`docs/schema.md`](docs/schema.md): Relational PostgreSQL schema, immutability triggers, and concurrency.
- [`docs/api-contract.md`](docs/api-contract.md): Versioned REST API specification (`/v1`) and error envelopes.
- [`docs/decisions.md`](docs/decisions.md): Architecture recommendations, domain conventions, and security.
- [`docs/roadmap.md`](docs/roadmap.md): Phased execution roadmap for Phase 5 tasks.
- [`docs/runbook.md`](docs/runbook.md): Deployment, migration, role verification, smoke test, backup, and restore procedures.

## Deployment

### Render

The service ships with `render.yaml` for one-click Render deployment:

- **Build**: `npm ci && npm run build`
- **Start**: `npm run start:prod` (`node dist/server.js`)
- **Health check**: `GET /v1/health/ready` (DB connectivity verified)
- **Region**: Singapore (configurable in `render.yaml`)

Set all required environment variables (`DATABASE_URL`, `FIREBASE_PROJECT_ID`,
`FIREBASE_SERVICE_ACCOUNT_JSON`, `TRUST_PROXY_HOPS`, `REQUIRE_VERIFIED_EMAIL`, `LOG_LEVEL`) in
the Render dashboard. See [`docs/runbook.md`](docs/runbook.md) for the full list.

### Docker

Multi-stage `Dockerfile` — builder compiles TypeScript, runner copies only production artifacts:

```powershell
docker build -t broke-travelers-api .
docker run --rm -e NODE_ENV=production broke-travelers-api  # exits with missing-var message
```

### Database Roles

```powershell
# Create / update runtime role (idempotent)
psql -d $env:DIRECT_URL -v "api_password='<password>'" -f scripts/sql/managed-db-roles.sql
# Verify least-privilege constraints
npm run db:verify-roles
```

### Smoke Test

```powershell
.\scripts\smoke-test.ps1 -BaseUrl https://<your-service>.onrender.com
```

### Automated Backups

`.github/workflows/backup.yml` runs daily at 02:30 NPT (20:45 UTC), dumps the database with
`pg_dump -Fc`, encrypts with GPG, and uploads as a GitHub Actions artifact (30-day retention).
Requires `BACKUP_DATABASE_URL` and `BACKUP_ENCRYPTION_KEY` repository secrets.

Restore drill (local Docker):
```powershell
.\scripts\restore-drill.ps1
```
