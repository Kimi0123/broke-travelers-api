# Broke Travelers API - Contributor Rules

Backend REST API for Broke Travelers (Node.js, Express, TypeScript, PostgreSQL, Prisma, Firebase Authentication). Group savings RECORDKEEPING API. It is NOT a bank, wallet, or payment processor.

## Workflow Rules

- Never push (`git push`). Remote pushing is strictly reserved for the repository owner.
- Work on branch `main` unless explicitly instructed otherwise. Commit after each step using the exact specified commit message.
- Commit type hygiene: `docs:`, `feat:`, `fix:`, `refactor:`, `test:`, `chore:`. Production code changes belong exclusively in `feat:`, `fix:`, or `refactor:`. Tests belong in `test:`.
- Never claim commands ran if they did not. If a command fails or cannot run, report the exact error and stop.
- Never use `git reset --hard`, `git stash`, `git checkout .`, `git clean`, rebasing, branch deletion, or force flags.
- Sibling Flutter repository (`../broke_travelers`) is strictly READ-ONLY. Never create, edit, delete, format, or commit files there.
- npm install only for dependencies approved by the current task; always commit package-lock.json; no runtime dependency in src/domain.
- Keep architecture simple: single service, single database. Do not introduce microservices, caching layers, or message queues unless documented and approved.
- Run integration tests before touching ledger/idempotency code; never use TRUNCATE/DELETE outside test setup.

## Financial Rules (Critical & Non-Negotiable)

- Money is ALWAYS integer paisa (1 NPR = 100 paisa). Stored as `BIGINT` in PostgreSQL and safe integer representation in TypeScript (`bigint` or validated safe integers).
- NEVER use float, double, or floating-decimal types for money anywhere in the domain, persistence, or API layers.
- Posted ledger entries are strictly immutable: no `UPDATE` and no `DELETE`. Corrections must be recorded as separate compensating reversal or adjustment entries.
- Verified balance separation: pending or unverified payments NEVER count toward the verified group balance.
- All signed ledger math respects direction: contributions and interest are inflows (+); expenses and withdrawals are outflows (-); reversals invert the original entry's sign.
- Guard against negative balance: no ledger posting or approval execution may result in a negative verified group balance.
- Dashboard, reports and updates are derived on read from the domain builders in one REPEATABLE READ snapshot; no financial logic in SQL or routes.
- Every financial rule must have domain-level unit test coverage that runs without HTTP or database dependencies.

## Security & Server Authority

- The server is the sole source of truth. Never trust client claims for user roles, member IDs, amount signs, payment status, group membership, or posting timestamps.
- Authentication uses Firebase ID tokens verified server-side. Resolve the user from the Firebase UID. Never store or trust custom claims for group roles.
- Authorization: every group-owned endpoint is scoped by `groupId` in the URL and validates active membership (`leftAt IS NULL`) server-side before execution.
- Separation of duties: payment verification is restricted to Treasurers. A Treasurer cannot review their own payment when another active Treasurer exists.
- Approvals: approval is not execution. Executing an approved expense/withdrawal requires a Treasurer and creates an immutable ledger entry. Execution of an approved request takes amount/title/payee only from the stored request; the client sends only paymentMethod (and reference where applicable). Approvals require at least 2 members on roster at creation.
- Idempotency: every money-writing endpoint (`POST /v1/groups/:id/...`) requires an `Idempotency-Key` header to protect against double-submission and network retry races.
- Privacy & leak prevention: errors must return safe, generic error envelopes. Never expose stack traces, database internals, credentials, or other members' payment references in logs or responses.
- References: payment references are normalized for uniqueness and masked (`Ref ••••3456`) to non-privileged viewers. Never expose references in public feeds.
- Never log request bodies, tokens or payment references; test code must not be imported by src/.
- Secrets hygiene: never commit `.env` or Firebase service account keys. Commit only `.env.example`.

## TypeScript & Code Quality

- TypeScript strict mode enabled (`"strict": true`). No `any` allowed; use explicit types, unknown with narrowing, or discriminated unions.
- Validate all incoming HTTP payloads at the boundary using a schema validator before passing data to application services.

## Deployment Artifacts (Task 5.7)

The following files were added in Task 5.7 and must be kept consistent:

| File / Script | Purpose |
|---|---|
| `render.yaml` | Render web service definition (region, build/start commands, health check path) |
| `Dockerfile` | Multi-stage production image (builder → runner, `node:22-slim`) |
| `.dockerignore` | Excludes `node_modules`, `dist`, `.env*`, `test/`, `*.dump`, `*.gpg` |
| `scripts/sql/managed-db-roles.sql` | Idempotent `api_user` runtime role setup (least-privilege) |
| `scripts/verify-roles.sql` | DO $$ block — asserts role constraints, raises on failure |
| `scripts/verify-roles.js` | Node runner for `verify-roles.sql` via `pg` client |
| `scripts/smoke-test.ps1` | 5-check PowerShell smoke test; use `-BaseUrl` to target any env |
| `scripts/restore-drill.ps1` | Local restore drill — throwaway Postgres 17 container, schema integrity check |
| `.github/workflows/backup.yml` | Daily encrypted `pg_dump` backup to GitHub Actions artifact (30-day retention) |
| `docs/runbook.md` | Deployment, migration, role verification, smoke test, backup, restore procedures |

### npm scripts added in Task 5.7

| Script | Command |
|---|---|
| `npm run start:prod` | `node dist/server.js` (production start) |
| `npm run db:deploy` | `prisma migrate deploy` (apply pending migrations) |
| `npm run db:verify-roles` | `node scripts/verify-roles.js` (assert least-privilege role) |

### Health endpoints (changed in Task 5.7)

- `GET /v1/health` — **shallow liveness only**: always `200 { status: 'ok' }`, no DB query. Use for load-balancer keepalive.
- `GET /v1/health/ready` — **deep readiness**: runs `SELECT 1` via Prisma; `200 { status: 'ready' }` or `503 { status: 'unready' }`. Use for Render health check and smoke test.

### Pending-amount privacy (changed in Task 5.7)

- Dashboard `pendingTotal`: group-wide sum of all pending submissions — visible to **all active members**.
- `GET /reports/members` `pendingPaisa` column: viewers who are plain members (not the subject member, not treasurer, not owner) receive **`null`** (never 0) for other members' pending amounts. The member's status field (e.g. `pending`) is always visible.
