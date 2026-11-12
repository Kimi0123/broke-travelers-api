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
