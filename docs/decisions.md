# Technical Decisions & Architecture Recommendations

Design recommendations and trade-off analyses for the Broke Travelers backend REST API.

---

## 1. Architecture & Project Layout
**Recommendation**: Layered / Clean Architecture with isolated domain logic.
- `src/domain/`: Pure TypeScript business logic (ledger math, obligation status derivation, due date clamping, approval quorum). Zero dependencies on Express, Prisma, or Firebase.
- `src/application/`: Application services / use cases orchestrating transactions and idempotency.
- `src/infrastructure/`: Prisma database repositories, Firebase Admin client, and external adapters.
- `src/http/`: Express routes, middleware (auth, rate limiting, error handling), and controllers.
- *Trade-off*: Higher initial file count vs complete portability, zero-mock domain unit tests, and seamless migration from Flutter mocks.

---

## 2. Single Implementation of Financial Logic
**Recommendation**: The pure TypeScript domain functions (ported 1:1 from Dart) are the SOLE authority.
- The server loads group ledger rows and submissions inside a row-locked transaction (`SELECT id FROM groups WHERE id = $1 FOR UPDATE`) and computes verified balances and obligations in memory using the domain functions.
- For ~6 members (~100-300 rows/year), memory evaluation takes `< 2ms` and eliminates duplicate SQL logic drift.
- SQL `SUM` queries are reserved for background health/monitoring checks and verified by parity tests.

---

## 3. Validation & Serialization
**Recommendation**: **Zod** schema validation.
- Validates boundary inputs (params, query, body) and parses strictly typed DTOs.
- *Trade-off*: Slightly higher runtime overhead than TypeBox/Ajv, but offers superior TypeScript type inference, zero build-step requirement, and expressive custom validations.

---

## 4. Testing Strategy
**Recommendation**: **Vitest** with separated test suites.
- **Unit Suite (Domain)**: Pure in-memory unit tests for domain functions without DB or network, executing in `< 1s`.
- **Integration Suite**: Runs against a real PostgreSQL instance via Docker Compose.
- **Posting Concurrency Verification**: Specific test launching 10 concurrent requests attempting to post expenses against a fixed balance. Asserts that group row locks (`FOR UPDATE`) serialize execution, exactly one transaction succeeds, and subsequent requests fail with `insufficient_balance` (zero negative balance drift).
- *Trade-off*: Docker required for integration tests vs guaranteeing real PostgreSQL transaction locking semantics.

---

## 5. Logging, Configuration & Reverse Proxy
- **Logging**: **Pino** for structured JSON logging with request-ID propagation (`X-Request-Id`) and automatic field redaction (`headers.authorization`, `reference`, `password`).
- **Configuration**: `dotenv` with a strict Zod `env.ts` schema. The service fails immediately on startup if any required environment variable is missing or malformed.
- **Reverse Proxy**: Configure `app.set('trust proxy', 1)` so Express accurately extracts client IPs from `X-Forwarded-For` behind Render / Railway / Cloudflare reverse proxies for rate limiting.

---

## 6. Firebase Admin & Authentication
- **Production**: Firebase Admin SDK verifying JWT ID tokens via Google public certificates.
- **Testing**: Firebase Auth Emulator (`FIREBASE_AUTH_EMULATOR_HOST`) for local and CI integration testing without hitting Google servers.
- *Trade-off*: Real Firebase keys not required in CI; tests remain isolated and deterministic.

---

## 7. Database Roles, Migrations & Neon Connection Pooling
- **Roles**:
  - `migration_owner`: DDL permissions, executes Prisma migrations, creates raw append-only triggers and partial unique indexes.
  - `api_user`: Runtime role used by Express. Has `SELECT`, `INSERT`, `UPDATE` (except on immutable tables); strictly `REVOKE UPDATE, DELETE ON ledger_entries, audit_log`.
- **Neon Configuration**:
  - `DATABASE_URL`: Pooled connection string (`port 6543`, `?pgbouncer=true`, pool max = 5) for application runtime, respecting free-tier connection limits (e.g. 20 connections max).
  - `DIRECT_URL`: Non-pooled direct connection string (`port 5432`) configured as `directUrl` in `schema.prisma` for executing schema migrations, partial indexes, and raw triggers.

---

## 8. Staging Deployment & Backups
- **Compute**: Render / Railway Web Service (Node.js). Region: Mumbai (`ap-south-1`) or Singapore (`ap-southeast-1`) for lowest latency to Nepal.
- **Backups**: Render free instances do not support standing cron daemons. Automated backups are executed via a scheduled GitHub Actions workflow in this repository running `pg_dump -Fc` using `DIRECT_URL` stored as a secret, uploading encrypted dumps to owner-controlled S3/R2 storage. Monthly local restore drills verify dump validity.

---

## 9. Shared Test Vectors Generated from Dart Reference
To guarantee strict 1:1 parity with the Flutter client, test vectors are GENERATED AS GOLDEN FILES directly from the Dart domain functions in `../broke_travelers`:
- **Generator**: A Dart script in the Flutter repository (`tool/generate_test_vectors.dart`, executed by the owner) exports canonical test scenarios into JSON files.
- **Location**: Committed into this repository under `test/vectors/*.json`.
- **Schema**:
  ```json
  {
    "suite": "obligation_status",
    "version": 1,
    "scenarios": [
      {
        "name": "latest_submission_rejected_overrides_pending",
        "input": { ... },
        "expected": { "status": "rejected" }
      }
    ]
  }
  ```
- The TypeScript unit tests in Vitest ingest these exact JSON files, ensuring zero divergence.

---

## 10. OWASP API Security Checklist
1. **BOLA / IDOR (API1)**: Every group endpoint enforces active membership lookup `(group_id, caller_user_id)` before loading data. Non-members receive 404 `group_not_found`.
2. **Broken Authentication (API2)**: Firebase tokens verified on every request; no custom JWT signing logic; token claims never trusted for roles.
3. **Broken Object Property Level Authorization (API3)**: Output DTOs filter out sensitive fields (unmasked references, other members' emails).
4. **Unrestricted Resource Consumption (API4)**: Global rate limiting (100 req/min/IP), invitation brute-force lockout (5 fails / 5 min), body size limits (100kb max).
5. **Broken Function Level Authorization (API5)**: Strict role gates (`is_owner`, `is_treasurer`) checked server-side for admin endpoints.
6. **Server-Side Request Forgery (API6)**: The API makes zero outbound HTTP requests based on user input.
7. **Security Misconfiguration (API7)**: CORS configured strictly for allowed mobile origins; security headers applied via `helmet`.
8. **Lack of Protection from Automated Threats (API8)**: Single-use invitation codes with 7-day expiration and brute-force throttling.
9. **Improper Inventory Management (API9)**: API strictly versioned under `/v1`; documentation kept in sync.
10. **Unsafe Consumption of APIs (API10)**: Firebase Admin SDK inputs validated before execution.

---

## 11. Explicit Non-Goals for Phase 5
- **Push Notifications**: Firebase Cloud Messaging (FCM) deferred; polling/pull-based `/v1/groups/:id/updates` used initially.
- **Web Dashboard**: Web interface is Phase 6 (React/Vite).
- **Payment Gateway Integrations**: Direct API webhooks with eSewa/Khalti out-of-scope; recordkeeping only.
- **Phone / SMS Authentication**: Omitted due to SMS gateway costs; email/password and Google sign-in only.
- **App Store / Play Store Publishing**: Distribution to testing group via direct APK and TestFlight.

---

## 12. Domain Module Conventions

The `src/domain/` module contains the 1:1 pure TypeScript port of all financial, obligation, approval, and reporting logic from the Dart reference implementation. It adheres to the following conventions:

### 12.1 Monetary Representation (`Paisa` Branded Safe Integers)
- Money is strictly denominated in integer paisa (1 NPR = 100 paisa) using TypeScript branded safe integers (`type Paisa = number & { readonly [PaisaBrand]: typeof PaisaBrand }`).
- **Why Safe Integers over BigInt or Decimal.js**:
  - JavaScript safe integers represent integers precisely up to `Number.MAX_SAFE_INTEGER` ($2^{53} - 1 \approx 9 \times 10^{15}$ paisa, or 90 trillion NPR).
  - Individual transactions in Broke Travelers are capped at $1,000,000,000$ paisa ($10,000,000$ NPR), comfortably within safe integer boundaries.
  - Safe integers serialize natively to JSON as standard numbers without requiring custom serializers (BigInt requires `BigInt.prototype.toJSON` or custom replacers) and avoid runtime library overhead (`decimal.js`, `bignumber.js`), keeping the domain module zero-dependency.
  - Type branding prevents mixing monetary paisa with raw numbers or loop counters at compile time.
  - Runtime guards (`assertPaisa`, `addPaisa`, `subtractPaisa`, `multiplyPaisa`) reject non-integers, `NaN`, `Infinity`, and safe integer overflow.

### 12.2 WallClock Pure Civil Calendar Representation
- Built-in JavaScript `Date` incorporates ambient timezone offsets, daylight saving transitions, and mutating methods that make financial calculations nondeterministic.
- `WallClock` represents calendar date-time values `{ y, m, d, h, mi, s, ms }` purely as civil time using Howard Hinnant's calendar algorithms.
- All domain functions accept an explicit `now: WallClock` parameter rather than reading system time or `Date.now()`, ensuring 100% deterministic test execution and replayability.

### 12.3 DomainError Codes
- Domain exceptions inherit from `DomainError` with stable, machine-readable codes matching Dart exception names:
  - `invalidInput`: Malformed parameters, out-of-range dates, or invalid transaction kinds.
  - `groupAccess`: Unknown group ID or non-member viewer.
  - `permissionDenied`: Insufficient role (e.g. non-treasurer recording transactions).
  - `insufficientBalance`: Attempted expense or withdrawal exceeds verified group balance.
  - `duplicateReference`: Payment reference already exists in active status for the same method.
  - `conflict`: Concurrent state conflict or expired approval action.
  - `notFound`: Target entity does not exist.
  - `unknown`: Unexpected internal state error.
- Machine-readable codes map cleanly to HTTP status envelopes in Phase 5.3+ without leaking raw internal exception strings to clients.

### 12.4 Obligation Status Input Ordering
- In `deriveObligationStatus`, when evaluating member submissions for a given contribution period, candidate entries must be ordered by `(occurredAt DESC, id DESC)` (or monotonic database sequence `seq DESC`).
- The latest submission determines the member's current status for the period (e.g., a rejected submission occurring after a pending submission marks the period as `rejected`, not `pendingVerification`).

### 12.5 Payment Reference Masking
- The Flutter client UI (`my_payments_screen.dart:85`) rendered payment references of 4 characters or fewer in full plain text.
- The backend API enforces privacy protection: any reference of 4 characters or fewer is strictly masked as `'Ref ••••'` to prevent leaking short credentials or transaction codes to activity feeds or non-privileged viewers. For references longer than 4 characters, it returns `'Ref ••••'` followed by the last 4 characters (e.g., `'Ref ••••3456'`).


### 12.6 pg Driver Version and Concurrent Transaction Queries

- The `@prisma/adapter-pg` package bundles its own nested `pg` (currently `^8.x`) under `node_modules/@prisma/adapter-pg/node_modules/pg`.
- In `pg@8`, calling `client.query()` while the same underlying connection already has an in-flight query triggers a `DeprecationWarning`: *"Calling client.query() when the client is already executing a query"*. This will become a hard error in `pg@9`.
- **Root cause**: Prisma interactive transactions (`$transaction(async tx => ...)`) pin every `tx.*` call to a **single** connection. Using `Promise.all([tx.a.findMany(...), tx.b.findMany(...)])` submits two queries concurrently on that one connection — the second query lands while the first is still in flight, triggering the warning.
- **Fix applied (Task 5.7d)**: All `Promise.all` calls on a Prisma transaction client `tx` inside `src/application/` were converted to sequential `await` calls:
  - `approvals-service.ts` — `createApproval`: replaced single multi-include `tx.approvalRequest.create` with a helper `loadApprovalWithRelations` that runs sub-queries sequentially.
  - `payments-service.ts` — `submitPayment`: sequential `await tx.ledgerEntry.findMany` then `await tx.paymentSubmission.findMany`.
  - `members-service.ts` — role-change transaction: sequential ledger + submission reads.
- **Rule**: never use `Promise.all` on a Prisma transaction client `tx`. Concurrent reads are only safe on the pool client (`this.prisma`), which picks separate pooled connections for each query.
- **Upgrading to pg@9**: before upgrading, run the full integration suite (`npm run test:integration`) and confirm the new hard error is not triggered. No `Promise.all` on `tx` should remain in `src/`.
