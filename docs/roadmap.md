# Phase 5 Execution Roadmap

Ordered task breakdown for implementing the Broke Travelers backend API and completing the Flutter client integration.

---

### Task 5.1: Project Scaffold, Pure Domain Module & Test Suite
- **Goal**: Initialize Node.js TypeScript project, configure tooling, and port domain business logic 1:1 from Dart.
- **Deliverables**: `package.json`, `tsconfig.json`, ESLint, Prettier, Vitest configuration; `src/domain/` (money arithmetic, ledger math, due date clamping, obligation status derivation, approval rules); shared JSON scenario vectors (`test/vectors/*.json`).
- **Acceptance Tests**: 100% unit test pass on shared vectors; zero DB or HTTP dependencies.
- **Flutter Impact**: None (backend standalone).

---

### Task 5.2: Database Schema, Prisma Migrations & Concurrency Verification
- **Goal**: Provision PostgreSQL via Docker Compose, apply Prisma schema, configure immutability triggers, and verify posting concurrency.
- **Deliverables**: `docker-compose.yml`, `prisma/schema.prisma`, initial migration with append-only triggers (`ledger_entries`, `audit_log`); transaction posting service with `FOR UPDATE` group locks; integration test suite.
- **Acceptance Tests**: Migrations execute cleanly; 10 concurrent requests attempting to post against balance are serialized without overdraw; raw `UPDATE`/`DELETE` on ledger entries is rejected.
- **Flutter Impact**: None.

---

### Task 5.3: Authentication, Session & Group Management Endpoints
- **Goal**: Implement Firebase ID token authentication middleware, user profile resolution, group CRUD, invitations, and member role management.
- **Deliverables**: Auth middleware (Firebase Admin SDK + local emulator support), controllers for `/v1/profile`, `/v1/groups`, `/v1/invitations`, `/v1/groups/:id/members`; brute-force rate limiter; audit logger integration.
- **Acceptance Tests**: Authenticated routes reject invalid tokens; invitation single-use, 7-day expiry, and 5-attempt lockout verified; member removal invariant rules enforced.
- **Flutter Impact**: None.

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
- **Goal**: Deploy backend service to staging (e.g. Render + Neon PostgreSQL), configure connection pooling and cold-start health checks, and test automated backup/restore scripts.
- **Deliverables**: Staging deployment config, `/v1/health` endpoint, automated `pg_dump` cron script pushing to S3/R2 storage, scripted local Docker restore test drill.
- **Acceptance Tests**: Staging API passes automated integration tests; restore drill successfully recreates database and validates ledger checksums.
- **Flutter Impact**: Provides live staging API URL for client configuration.

---

### Task 5.7: Flutter Client Integration & Incremental Switch-Over
- **Goal**: Incrementally replace Flutter mock repository providers with API-backed HTTP client implementations, verifying each feature independently.
- **Deliverables**: HTTP client repositories in `lib/features/*/data/repositories/http_*_repository.dart`; environment-based API base URL configuration; shared contract test verification.
- **Acceptance Tests**: Full Flutter test suite (`flutter test`) passes green with both mock and HTTP repositories; complete user journey verified on mobile emulator/device.
- **Flutter Impact**: Mobile app transitions to production-ready client backed by PostgreSQL.
