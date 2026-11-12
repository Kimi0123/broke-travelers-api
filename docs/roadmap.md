# Phase 5 Execution Roadmap

Ordered task breakdown for implementing the Broke Travelers backend API and completing the Flutter client integration.

---

### Task 4.3: Export Shared Test Vectors (Flutter Repository, Owner Task) — [DONE]
- **Goal**: Export canonical test scenarios directly from the existing Dart reference implementations into golden JSON vector files.
- **Status**: **DONE** (Flutter commit `d2b0672` on branch `phase-4-vectors`).
- **Deliverables**: Dart export generators in `tool/vectors/*` exported 7 golden files (135 total test scenarios) into `test/vectors/*.json` covering `signedPaisa`, `verifiedBalancePaisa`, `dueDateFor`, `deriveObligationStatus`, approval rules, report builders, transaction validators, and payment reference normalization/validation/uniqueness.
- **Acceptance Tests**: All 135 cases generated directly from production Dart functions; zero floats; structurally validated against schema version 1.
- **Flutter Impact**: Establishes reference golden test vectors for backend domain parity.

---

### Task 5.1: Project Scaffold, Pure Domain Module & Test Suite — [DONE]
- **Goal**: Initialize Node.js TypeScript project, configure tooling, port domain business logic 1:1 from Dart, and verify against golden vectors.
- **Status**: **DONE** (Backend commits `fe9e31d`, `40c41d5`, `c8a30a1`, `107ac3d`, `626ea70`, `ffad9e5` on branch `main`).
- **Deliverables**: TypeScript 5+ project scaffold with Node 22, strict ESLint flat config, Prettier, and Vitest; pure, dependency-free `src/domain/` module implementing `Paisa` safe integer arithmetic, `WallClock` civil calendar math, `signedPaisa`, `verifiedBalancePaisa`, `dueDateFor`, `deriveObligationStatus`, approval rules, transaction validators, payment reference normalizers, and report builders; 173 passing unit and vector tests across 9 suites.
- **Acceptance Tests**: 100% pass on all 135 golden test vectors; zero DB, HTTP, or runtime dependencies.
- **Flutter Impact**: None (backend standalone).

---

### Task 5.2: Database Schema, Prisma Migrations & Concurrency Verification — [DONE]
- **Goal**: Provision PostgreSQL via Docker Compose, apply Prisma schema, configure immutability triggers, and verify posting concurrency.
- **Status**: **DONE** (Backend commits `4bf4857`, `d76b81a`, `8753fbd`, `e737e64`, `333de1c`, `a2487dc`, `350dfb2` on branch `main`).
- **Deliverables**: `docker-compose.yml`, `prisma/schema.prisma`, initial migration with append-only triggers (`ledger_entries`, `audit_log`) and partial unique indexes; transaction posting service with `FOR UPDATE` group locks; integration test suite.
- **Requirements**:
  - `payment_submissions` table must include `seq BIGINT GENERATED ALWAYS AS IDENTITY` so submission insertion order is monotonic, reproducible, and provides deterministic tie-breaking for `deriveObligationStatus`.
- **Acceptance Tests**: Migrations execute cleanly; 10 concurrent requests attempting to post against balance are serialized without overdraw; raw `UPDATE`/`DELETE` on ledger entries is rejected; 23 integration tests pass across 9 test files.
- **Flutter Impact**: None.

---

### Task 5.3: Authentication, Session & Group Management Endpoints — [DONE]
- **Goal**: Implement Express REST API with Firebase ID token authentication (TokenVerifier port with fake verifier double), user session provisioning, group CRUD, invitations with brute-force lockout, and member role management.
- **Status**: **DONE** (Backend commits `3e149a5`, `74f35b3`, `19c5879`, `43103e7`, `081e350`, `e1a048d`, `9a2e6c9`, `ae79144` on branch `main`).
- **Deliverables**:
  - Express 5 REST API skeleton with Helmet, Pino structured logging, standard error envelopes, and `/v1/health`.
  - TokenVerifier port with `FirebaseTokenVerifier` adapter and `FakeTokenVerifier` test double.
  - Endpoints: `POST /v1/session`, `GET /v1/profile`, `POST /v1/groups`, `GET /v1/groups/:id`, `PATCH /v1/groups/:id/settings`, `POST /v1/groups/:id/invitations`, `GET /v1/groups/:id/invitations`, `DELETE /v1/groups/:id/invitations/:invitationId`, `POST /v1/invitations/accept`, `GET /v1/groups/:id/members`, `PATCH /v1/groups/:id/members/:memberId/role`, `DELETE /v1/groups/:id/members/:memberId`.
  - `invitation_attempts` table with brute-force lockout (5 attempts in 15m -> 429 `too_many_attempts` with `Retry-After`).
  - Row locking (`FOR UPDATE`) on invitation acceptance to prevent race conditions on concurrent redemptions.
  - Full HTTP integration test suite running against real PostgreSQL test database.
- **Moved to Task 5.4**: Member detail endpoint (`GET /v1/groups/:groupId/members/:memberId`) moved to Task 5.4 alongside contribution history and obligation ledger queries.
- **Acceptance Tests**: Authenticated routes reject invalid tokens; user-scoped and group-scoped idempotency replay and conflict verification; invitation single-use, 7-day expiry, and 5-attempt lockout verified; member removal invariant rules enforced in strict order; 41 integration tests pass across 14 test files.
- **Flutter Impact**: None (backend standalone).
- **Next Task**: Task 5.4 (Financial Operations: Contributions, Payments & Ledger Endpoints).

---

### Task 5.4: Financial Operations: Contributions, Payments & Ledger Endpoints
- **Goal**: Implement contribution period queries, member payment submissions, treasurer verification/rejection, direct transactions, and reversals with idempotency protection.
- **Deliverables**: Endpoints for `/v1/groups/:id/contributions`, `/v1/groups/:id/payments`, `/v1/groups/:id/transactions`; idempotency middleware with 48h cache; reference normalization and method-scoped uniqueness checks.
- **Acceptance Tests**: Replay of identical `Idempotency-Key` returns original response; conflicting key returns 409; payment verification creates ledger row (FIN-1); treasurer separation of duties enforced.
- **Flutter Impact**: None.

---

### Task 5.5: Governance, Reports, Reconciliation & Updates Endpoints
- **Goal**: Implement multi-member approval lifecycle, aggregated financial reports, bank reconciliation logging, and per-viewer updates feed.
- **Deliverables**: Endpoints for `/v1/groups/:id/approvals` (voting, quorum, execution), `/v1/groups/:id/reports/*` (monthly, member, annual, outflow), `/v1/groups/:id/reconciliations`, `/v1/groups/:id/updates` (with read-state tracking).
- **Acceptance Tests**: Strict majority and early rejection voting thresholds verified; report range boundaries enforced; updates feed strictly omits sensitive references.
- **Flutter Impact**: None.

---

### Task 5.6: Staging Deployment, Automated Backups & End-to-End Verification
- **Goal**: Deploy backend service to staging (Render + Neon PostgreSQL), configure connection pooling and cold-start health checks, and configure automated GitHub Actions backups with restore drills.
- **Deliverables**: Staging deployment config, `/v1/health` endpoint, `.github/workflows/backup.yml` running daily `pg_dump` pushing encrypted artifacts to owner S3/R2 storage, scripted local Docker restore test drill.
- **Acceptance Tests**: Staging API passes automated integration tests; restore drill successfully recreates database and validates ledger checksums.
- **Flutter Impact**: Provides live staging API URL for client configuration.

---

### Task 5.7: Flutter Client Integration & Incremental Switch-Over
- **Goal**: Incrementally replace Flutter mock repository providers with API-backed HTTP client implementations, verifying each feature independently.
- **Deliverables**: HTTP client repositories in `lib/features/*/data/repositories/http_*_repository.dart`; environment-based API base URL configuration; shared contract test verification.
- **Acceptance Tests**: Full Flutter test suite (`flutter test`) passes green with both mock and HTTP repositories; complete user journey verified on mobile emulator/device.
- **Flutter Impact**: Mobile app transitions to production-ready client backed by PostgreSQL.
