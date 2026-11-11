# Broke Travelers API

The backend REST API service for Broke Travelers, a group savings recordkeeping application.

Broke Travelers is an immutable financial ledger and group transparency recordkeeping tool. It is NOT a bank, digital wallet, or payment processor. It records and tracks verified balances for travel groups whose financial transactions occur out-of-band.

## Tech Stack
- **Runtime & Language**: Node.js (v22+) with TypeScript (strict mode)
- **Framework**: Express.js (Phase 5.3+)
- **Database & ORM**: PostgreSQL with Prisma ORM (Phase 5.2+)
- **Authentication**: Firebase Authentication (Phase 5.3+)
- **Testing**: Vitest with 1:1 golden vectors ported from Dart

## Relation to Flutter Client
The Flutter mobile application lives in the sibling directory (`../broke_travelers`). That repository serves as the executable specification of all business and financial logic through its mock repository suite. The Flutter repository is treated as strictly read-only by backend tooling.

## Current Status
**Phase 5.2 complete — database schema, immutability triggers, posting service, and concurrency verification.**
PostgreSQL schema is implemented with Prisma migrations, raw-SQL append-only triggers on `ledger_entries` and `audit_log`, partial unique indexes, database roles (`migration_owner`, `api_user`), group row locking for mutual exclusion, FIN-1 verification atomicity, and idempotency protection. Verified across 190 unit/vector tests and 23 integration tests against PostgreSQL 17.

## Local Database
Docker Compose provisions a local PostgreSQL 17 container on port 5533:

```bash
# Start database container and await healthy status
npm run db:up

# Deploy migrations
npm run db:migrate

# Run database integration test suite
npm run test:integration

# Stop database container
npm run db:down
```

## Domain Module Layout (`src/domain/`)
- `money.ts`: `Paisa` branded safe integer monetary arithmetic (no floating-point, integer paisa only)
- `wall-clock.ts`: Pure civil calendar representation and Hinnant arithmetic (no `Date` or system clock)
- `month-math.ts`: Civil month start and next month calculations
- `enums.ts`: Domain enums (`ActivityKind`, `PaymentStatus`, `PaymentMethod`, `GroupRole`, `ApprovalStatus`)
- `errors.ts`: Typed `DomainError` and functional `Result` monad
- `types.ts`: Core domain interfaces (`LedgerEntry`, `GroupMember`)
- `ledger-math.ts`: `signedPaisa` and `verifiedBalancePaisa` calculations
- `due-dates.ts`: `dueDateFor` calendar due date derivation and clamping
- `obligation-status.ts`: `deriveObligationStatus` contribution state machine
- `approval-rules.ts`: Quorum thresholds, early rejection, expiry, and status resolution
- `transaction-validators.ts`: Direct transaction and reversal reason validators
- `payment-reference.ts`: Payment reference normalization (`normalizePaymentReference`)
- `payment-validators.ts`: Reference and note validators, duplicate detection
- `reference-masking.ts`: Privacy reference masking (`maskPaymentReference`)
- `report-types.ts` & `report-builders.ts`: Monthly, member, annual, and outflow financial reports

## Development
Requirements: Node.js >= 22.0.0 and npm >= 10.0.0.

```bash
# Install dependencies
npm ci

# Run unit and golden vector tests
npm test

# Lint and typecheck
npm run lint
npm run typecheck

# Format check
npm run format:check

# Build TypeScript to dist/
npm run build
```

## Documentation Index
- [`docs/domain-rules.md`](docs/domain-rules.md): Authoritative business rules extracted from Flutter client.
- [`docs/schema.md`](docs/schema.md): Relational PostgreSQL schema, immutability triggers, and concurrency.
- [`docs/api-contract.md`](docs/api-contract.md): Versioned REST API specification (`/v1`) and envelopes.
- [`docs/decisions.md`](docs/decisions.md): Architecture recommendations, domain conventions, and security.
- [`docs/roadmap.md`](docs/roadmap.md): Phased execution roadmap for Phase 5 tasks.
