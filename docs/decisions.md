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

## 2. Validation & Serialization
**Recommendation**: **Zod** schema validation.
- Validates boundary inputs (params, query, body) and parses strictly typed DTOs.
- *Trade-off*: Slightly higher runtime overhead than TypeBox/Ajv, but offers superior TypeScript type inference, zero build-step requirement, and expressive custom validations.

---

## 3. Testing Strategy
**Recommendation**: **Vitest** with separated test suites.
- **Unit Suite (Domain)**: Pure in-memory unit tests for domain functions without DB or network, executing in `< 1s`.
- **Integration Suite**: Runs against a real PostgreSQL instance via Docker Compose.
- **Posting Concurrency Verification**: Specific test launching 10 concurrent requests attempting to post expenses against a fixed balance. Asserts that group row locks (`FOR UPDATE`) serialize execution, exactly one transaction succeeds, and subsequent requests fail with `insufficient_balance` (zero negative balance drift).
- *Trade-off*: Docker required for integration tests vs guaranteeing real PostgreSQL transaction locking semantics.

---

## 4. Logging & Configuration
- **Logging**: **Pino** for structured JSON logging with request-ID propagation (`X-Request-Id`) and automatic field redaction (`headers.authorization`, `reference`, `password`).
- **Configuration**: `dotenv` with a strict Zod `env.ts` schema. The service fails immediately on startup if any required environment variable is missing or malformed.

---

## 5. Firebase Admin & Authentication
- **Production**: Firebase Admin SDK verifying JWT ID tokens via Google public certificates.
- **Testing**: Firebase Auth Emulator (`FIREBASE_AUTH_EMULATOR_HOST`) for local and CI integration testing without hitting Google servers.
- *Trade-off*: Real Firebase keys not required in CI; tests remain isolated and deterministic.

---

## 6. Database Migrations & Prisma
- **Tool**: Prisma Migrate.
- **Workflow**: `prisma migrate dev` for local schema iterations; `prisma migrate deploy` executed during container/app startup in staging.
- **Immutability Enforcement**: Migration scripts will include raw SQL triggers revoking `UPDATE` and `DELETE` on `ledger_entries` and `audit_log`.

---

## 7. Staging Deployment & Neon/Render Optimization
- **Compute**: Render / Railway Web Service (Node.js).
- **Database**: Neon Serverless PostgreSQL (free/starter tier).
- **Region**: Mumbai (`ap-south-1`) or Singapore (`ap-southeast-1`) for lowest latency to Nepal.
- **Connection Management**: Prisma configured with Neon pooled connection string (`?pgbouncer=true` or pool limit = 5) to prevent exhausting free-tier connection limits (e.g. 20 concurrent connections).
- **Cold Starts**: Render free instances spin down after inactivity. Implement `/v1/health` with a lightweight ping; client sets a 30s initial connect timeout and reuses `Idempotency-Key` on retry.

---

## 8. Continuous Integration (CI)
GitHub Actions workflow on PRs to `main`:
1. `npm run lint` & `npm run format:check`
2. `npm run typecheck` (`tsc --noEmit`)
3. `npm run test:unit` (pure domain tests)
4. PostgreSQL service container initialization -> `prisma migrate deploy` -> `npm run test:integration`.

---

## 9. 1:1 Domain Parity & Shared Test Vectors
To guarantee identical financial behavior between the Flutter mock and Node.js backend, extract test fixtures into shared JSON scenario vectors (`test/vectors/*.json`):
```json
{
  "scenario": "due_day_clamping_leap_year",
  "input": { "year": 2024, "month": 2, "dueDay": 31 },
  "expected": { "year": 2024, "month": 2, "day": 29 }
}
```
Both Dart tests (`flutter test`) and Node.js tests (`vitest`) ingest the exact same vector files.

---

## 10. OWASP API Security Checklist
1. **BOLA / IDOR (API1)**: Every group endpoint enforces active membership lookup `(group_id, caller_user_id)` before loading data.
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
