# Broke Travelers API

The backend REST API service for Broke Travelers, a group savings recordkeeping application.

Broke Travelers is an immutable financial ledger and group transparency recordkeeping tool. It is NOT a bank, digital wallet, or payment processor. It records and tracks verified balances for travel groups whose financial transactions occur out-of-band.

## Tech Stack
- **Runtime & Language**: Node.js (v22+) with TypeScript (strict mode)
- **Framework**: Express.js
- **Database & ORM**: PostgreSQL with Prisma ORM
- **Authentication**: Firebase Authentication (ID token verification server-side; email/password & Google sign-in)

## Relation to Flutter Client
The Flutter mobile application lives in the sibling directory (`../broke_travelers`). That repository serves as the executable specification of all business and financial logic through its mock repository suite. The Flutter repository is treated as strictly read-only by backend tooling.

## Current Status
**Design phase (Task 5.0) — no application code yet.**
All design documents, data models, domain rules, and API specifications have been extracted, audited, and reviewed prior to project scaffolding.

## Deployment Context
- **Target Audience**: Small friend circles (~6 members per group) sharing shared travel fund accounts.
- **Development**: Local PostgreSQL running via Docker Compose (`docker compose up`).
- **Staging / Initial Production**: Low-cost or free managed tiers (e.g., Render web service + Neon serverless PostgreSQL).
- **Backups**: Automated cron `pg_dump` snapshots sent to owner-controlled storage, verified with routine restore drill tests to mitigate free-tier retention limits.

## Documentation Index
- [`docs/domain-rules.md`](docs/domain-rules.md): Authoritative business rules extracted from the Flutter client codebase.
- [`docs/schema.md`](docs/schema.md): Relational PostgreSQL database schema, append-only ledger guarantees, constraints, and concurrency model.
- [`docs/api-contract.md`](docs/api-contract.md): Versioned REST API specification (`/v1`), endpoints, request/response envelopes, and idempotency semantics.
- [`docs/decisions.md`](docs/decisions.md): Architecture recommendations, trade-off analyses, security controls, and testing strategy.
- [`docs/roadmap.md`](docs/roadmap.md): Phased execution roadmap for Phase 5 implementation tasks.
