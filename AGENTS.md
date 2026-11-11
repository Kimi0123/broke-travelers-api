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

## Financial Rules (Critical & Non-Negotiable)

- Money is ALWAYS integer paisa (1 NPR = 100 paisa). Stored as `BIGINT` in PostgreSQL and safe integer representation in TypeScript (`bigint` or validated safe integers).
- NEVER use float, double, or floating-decimal types for money anywhere in the domain, persistence, or API layers.
- Posted ledger entries are strictly immutable: no `UPDATE` and no `DELETE`. Corrections must be recorded as separate compensating reversal or adjustment entries.
- Verified balance separation: pending or unverified payments NEVER count toward the verified group balance.
- All signed ledger math respects direction: contributions and interest are inflows (+); expenses and withdrawals are outflows (-); reversals invert the original entry's sign.
- Guard against negative balance: no ledger posting or approval execution may result in a negative verified group balance.
- Every financial rule must have domain-level unit test coverage that runs without HTTP or database dependencies.

## Security & Server Authority

- The server is the sole source of truth. Never trust client claims for user roles, member IDs, amount signs, payment status, group membership, or posting timestamps.
- Authentication uses Firebase ID tokens verified server-side. Resolve the user from the Firebase UID. Never store or trust custom claims for group roles.
- Authorization: every group-owned endpoint is scoped by `groupId` in the URL and validates active membership (`leftAt IS NULL`) server-side before execution.
- Separation of duties: payment verification is restricted to Treasurers. A Treasurer cannot review their own payment when another active Treasurer exists.
- Approvals: approval is not execution. Executing an approved expense/withdrawal requires a Treasurer and creates an immutable ledger entry.
- Idempotency: every money-writing endpoint (`POST /v1/groups/:id/...`) requires an `Idempotency-Key` header to protect against double-submission and network retry races.
- Privacy & leak prevention: errors must return safe, generic error envelopes. Never expose stack traces, database internals, credentials, or other members' payment references in logs or responses.
- References: payment references are normalized for uniqueness and masked (`Ref ••••3456`) to non-privileged viewers. Never expose references in public feeds.
- Secrets hygiene: never commit `.env` or Firebase service account keys. Commit only `.env.example`.

## TypeScript & Code Quality

- TypeScript strict mode enabled (`"strict": true`). No `any` allowed; use explicit types, unknown with narrowing, or discriminated unions.
- Validate all incoming HTTP payloads at the boundary using a schema validator before passing data to application services.
