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

### Task 5.4: Financial Operations: Contributions, Payments & Ledger Endpoints — [DONE]
- **Goal**: Implement contribution period queries, member payment submissions, treasurer verification/rejection, direct transactions, reversals, unified activity feed, and member detail with idempotency protection.
- **Status**: **DONE** (Backend commits `e4b8e2f`, `eb67b2e`, `59e16e2`, `8d2a999`, `d43c77f`, `b601f8e`, `e50966f` on branch `main`).
- **Deliverables**:
  - Contribution period list and detail endpoints with dynamic obligation derivation (`GET /v1/groups/:id/contributions/periods`, `GET .../periods/:periodId`).
  - Payment submission with server-derived expected amounts, method-scoped reference uniqueness, and validation against open/obligated periods (`POST /v1/groups/:id/payments`).
  - Personal payment history (`GET /v1/groups/:id/payments/my`) with reference masking and status mapping (`pendingVerification`, `verified`, `rejected`).
  - Pending reviews queue (`GET /v1/groups/:id/payments/pending`) with unmasked references and `isOwnSubmission` separation-of-duties indicator.
  - Atomic payment verification (`POST .../verify`) posting immutable ledger entries (`postVerifiedEntry`), updating audit log, and feeding unified activity.
  - Payment rejection (`POST .../reject`) recording structured reasons and freeing members for resubmission.
  - Transactions & Reversals (`POST /v1/groups/:id/transactions`, `POST .../:transactionId/reverse`) supporting expense and interest entries, 366-day backdating guard, verified balance guard, and non-modifiable linked reversal entries.
  - Unified activity read model (`GET /v1/groups/:id/transactions`, `GET .../:transactionId`) backed by `v_activity_items` with opaque base64url keyset pagination (`?cursor=...&limit=...`).
  - Member detail endpoint (`GET /v1/groups/:id/members/:memberId`) returning profile, cumulative verified total, pending total, verified month count, and privacy-filtered monthly contribution history.
  - Full Flutter end-to-end parity test suite validating matching financial outcomes between Flutter mocks and backend PostgreSQL.
- **Acceptance Tests**: 226 unit tests (1 skipped); 78 integration tests across 21 suites passing against real PostgreSQL; verified across 3 consecutive runs with 0 flakiness.
- **Flutter Impact**: None (backend standalone).
- **Next Task**: Task 5.5 (Governance, Reports, Reconciliation & Updates Endpoints).

---

### Task 5.5: 5.4 Cleanup, Governance Approvals & Bank Reconciliation Endpoints — [DONE]
- **Goal**: Resolve 5.4 cleanup items (compound IDs, stale submission-to-ledger resolution, rejected submission visibility, masked references on submission creation), implement multi-member approval lifecycle (request, vote, cancel, execute with separation of duties), and provide formal bank statement reconciliation against the verified ledger.
- **Status**: **DONE** (Backend commits `1f3a9d4`, `f4c1eb9`, `6d4015f`, `8482300`, `9c3b83d` on branch `main`).
- **Deliverables**:
  - 5.4 Cleanup: Compound transaction IDs only (`ledger:<uuid>`, `submission:<uuid>`; bare UUID returns 404); automatic resolution of verified `submission:<uuid>` to resulting `ledger:<ledgerEntryId>`; rejected submission privacy (visible only to submitter or treasurer/owner); masked reference returned on `POST /v1/groups/:groupId/payments` 201.
  - Governance Approvals (`/v1/groups/:groupId/approvals`):
    - Create approval request with active member check (>= 2 members), verified balance check at submission, and eligible voter snapshot excluding requester.
    - List approvals with `status` and `kind` filters, keyset pagination, and per-caller `myVote` derivation.
    - Approval detail with individual voter statuses.
    - Voting endpoint with dynamic expiry check (7 calendar days at 23:59:59.999 NPT), strict majority threshold (`votesNeeded = ceil((activeMembers - 1) / 2)`), and early rejection when remaining potential votes cannot reach threshold.
    - Cancel endpoint restricted to requester while open.
    - Execution endpoint restricted to treasurers with separation of duties (requester cannot execute own request if another active treasurer exists), verified balance re-check, and atomic posting of immutable ledger entry.
  - Bank Reconciliation (`/v1/groups/:groupId/reconciliations`):
    - List reconciliations ordered by `statementDate DESC, id DESC`.
    - Recorded balance derivation (`/recorded-balance?date=YYYY-MM-DD`) evaluating cutoff at NPT statement date end-of-day (`23:59:59.999 NPT`).
    - Record reconciliation endpoint for treasurers with date uniqueness, server-side balance & difference calculation, and immutable audit logging.
  - Integration and parity test suite mirroring Flutter `approvals_e2e_test.dart` and `reports_e2e_test.dart` scenarios.
- **Deferred to Task 5.6**: Dashboard summary (`GET /v1/groups/:groupId/dashboard` / `summary`), aggregated reports (`GET /v1/groups/:groupId/reports/*` for monthly, members, annual, and outflow), and the per-viewer updates feed (`GET /v1/groups/:groupId/updates`, `POST .../mark-read`) are DEFERRED to Task 5.6.
- **Acceptance Tests**: 226 unit tests (1 skipped); 91 integration tests across 23 suites passing against real PostgreSQL; verified across 3 consecutive runs with 0 flakiness.
- **Flutter Impact**: None (backend standalone).
- **Next Task**: Task 5.6 (Reports, Dashboard Summary & Updates Feed).

---

### Task 5.6: Reports, Dashboard Summary & Updates Feed
- **Goal**: Implement aggregated financial reports (monthly, member-wise, annual, outflow), dashboard summary cards, and the per-viewer updates notification feed with read-state tracking.
- **Deliverables**: Endpoints for `/v1/groups/:groupId/dashboard`, `/v1/groups/:groupId/reports/*`, `/v1/groups/:groupId/updates`, and `/v1/groups/:groupId/updates/mark-read`.
- **Acceptance Tests**: Report date ranges validated against group history; cumulative month-boundary balances match Flutter report builders; updates feed strictly omits sensitive references and other members' pending amounts.
- **Flutter Impact**: None.

---

### Task 5.7: Staging Deployment, Automated Backups & End-to-End Verification
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
