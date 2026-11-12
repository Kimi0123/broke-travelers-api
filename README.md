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
**Phase 5.3 complete — HTTP Layer: Authentication, Session, Groups, Invitations, Members.**
Express 5 REST API with Firebase ID token authentication (TokenVerifier port with Firebase adapter), user provisioning, groups CRUD, single-use invitations with brute-force lockout, member role management, and soft removal invariants. Verified across 218 unit/vector tests and 41 integration tests against real PostgreSQL.

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
npm run test:unit         # Unit & 135 Dart golden vector tests (218 tests)
npm run test:integration  # Real PostgreSQL integration tests (41 tests across 14 suites)
npm run lint              # ESLint check
npm run format:check      # Prettier format check
npm run typecheck         # TypeScript compiler check
npm run build             # Build TypeScript output to dist/
```
*(Note: `npm ci` generates the Prisma client automatically; run `npm run prisma:generate` after editing `prisma/schema.prisma`).*

## Documentation Index
- [`docs/domain-rules.md`](docs/domain-rules.md): Authoritative business rules extracted from Flutter client.
- [`docs/schema.md`](docs/schema.md): Relational PostgreSQL schema, immutability triggers, and concurrency.
- [`docs/api-contract.md`](docs/api-contract.md): Versioned REST API specification (`/v1`) and error envelopes.
- [`docs/decisions.md`](docs/decisions.md): Architecture recommendations, domain conventions, and security.
- [`docs/roadmap.md`](docs/roadmap.md): Phased execution roadmap for Phase 5 tasks.
