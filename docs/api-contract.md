# REST API Contract (v1)

Versioned HTTP REST API specification for Broke Travelers backend API.

---

## 1. Global Conventions & Protocol

### 1.1 Transport & Base URL
- Protocol: HTTPS only (`http` redirects to `https`).
- Base Path: `/v1`.
- Payloads: JSON (`Content-Type: application/json; charset=utf-8`).

### 1.2 Authentication & Authorization
- **Mechanism**: Firebase Authentication ID token passed via header:
  `Authorization: Bearer <firebase_id_token>`
- **Server Verification**: Validated on every authenticated request via Firebase Admin SDK.
- **Identity Resolution**: Server resolves internal `users.id` from `firebase_uid`. Token custom claims are NEVER used for group roles or permissions.
- **Group Authorization**: Group endpoints include `groupId` in the URL path. Server queries `group_memberships` for `(group_id, user_id)` and verifies `left_at IS NULL`. Active membership is required for all group endpoints.

### 1.3 Data Types & Formatting
- **Money Representation**: Integer paisa as JSON `number` (e.g. `70000` = 700 NPR).
  - *Justification*: JavaScript's `Number.MAX_SAFE_INTEGER` is $9,007,199,254,740,991$ (~90 trillion NPR). The application ceiling is $10,000,000$ NPR ($1,000,000,000$ paisa), fitting safely within JSON number limits across JS, Dart, and PostgreSQL.
- **Timestamps**: ISO-8601 strings in UTC: `YYYY-MM-DDTHH:mm:ss.sssZ`.
- **Dates**: Calendar dates without time: `YYYY-MM-DD`.
- **Nepal Standard Time (NPT, UTC+05:45)**: The server stores timestamps in UTC. Calendar boundaries (e.g., period start, due date, reconciliation `asOf` cutoff) are evaluated against NPT (Nepal Standard Time, which has no DST).

### 1.4 Standard Envelopes
- **Error Envelope**:
  ```json
  {
    "error": {
      "code": "insufficient_balance",
      "message": "Insufficient verified balance to record expense",
      "requestId": "req_01HX98Z123ABC"
    }
  }
  ```
  Machine-readable `code` aligns strictly with `docs/domain-rules.md` (Section 11). Messages are generic and friendly; internal stack traces or database errors are never exposed.
- **Pagination**: Cursor-based for activity, audit, and transactions:
  Query: `?cursor=<uuid_or_opaque>&limit=20` (max 50).
  Response envelope: `{ "items": [...], "nextCursor": "...", "hasMore": true }`.

### 1.5 Idempotency
- **Header**: `Idempotency-Key: <client-generated-uuidv4>` required on every financial write (`POST` creating payments, transactions, approvals, executions, reconciliations).
- **Scope**: Evaluated per `(group_id, actor_user_id, operation, idempotency_key)`.
- **Replay**: Matching request returns cached response with header `Idempotent-Replay: true`.
- **Conflict**: Same key with different payload returns HTTP 409 `idempotency_conflict`.
- **Retention**: Cached for 48 hours.

### 1.6 Cold-Start & Health Handling
- `GET /v1/health`: Returns `{ "status": "ok", "db": "connected", "time": "..." }`.
- **Client Cold-Start Guidance**: Free hosts (e.g. Render) spin down when idle. Clients must configure 30s connection timeout for initial ping, and upon network timeout on idempotent POST endpoints, MUST retry with the EXACT SAME `Idempotency-Key`.

---

## 2. API Endpoints Reference

### 2.1 System & Session
#### `GET /v1/health`
- **Replaces**: N/A (Infrastructure)
- **Auth**: None (Public)
- **Response 200**: `{ "status": "ok", "db": "connected", "time": "2026-11-11T12:00:00.000Z" }`

#### `GET /v1/profile`
- **Replaces**: `ProfileRepository.getProfile`, `AuthRepository.refreshCurrentUser`
- **Auth**: Authenticated User
- **Response 200**:
  ```json
  {
    "user": { "id": "uuid", "name": "Nirvan", "email": "nirvan@example.com" },
    "groups": [{ "id": "uuid", "name": "Himalayan Crew", "role": "owner", "isTreasurer": true }]
  }
  ```

---

### 2.2 Groups & Invitations
#### `POST /v1/groups`
- **Replaces**: `GroupsRepository.createGroup`
- **Auth**: Authenticated User | **Idempotent**: Yes (`Idempotency-Key`)
- **Request**: `{ "name": "Himalayan Crew", "monthlyContributionPaisa": 70000, "dueDay": 5 }`
- **Response 201**: Group object. Creator is granted Owner & Treasurer.
- **Errors**: 400 `invalid_group_settings`, 409 `group_creation_failed`. Enforces Domain Rule 2.2.

#### `GET /v1/groups/:groupId`
- **Replaces**: `GroupsRepository.getGroup`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: `{ "id": "uuid", "name": "Himalayan Crew", "monthlyContributionPaisa": 70000, "dueDay": 5, "createdAt": "...", "memberCount": 4 }`

#### `PATCH /v1/groups/:groupId/settings`
- **Replaces**: `GroupsRepository.updateGroupSettings`
- **Auth**: Group Owner
- **Request**: `{ "name": "New Name", "dueDay": 10 }`
- **Response 200**: Updated Group object.
- **Errors**: 403 `forbidden`, 400 `invalid_group_settings`. Enforces Domain Rule 2.3, 2.4.

#### `POST /v1/invitations/accept`
- **Replaces**: `InvitationsRepository.acceptInvitation`
- **Auth**: Authenticated User | **Idempotent**: Yes
- **Request**: `{ "code": "HIMA2345" }`
- **Response 200**: `{ "group": { "id": "uuid", "name": "Himalayan Crew" } }`
- **Errors**: 400 `invalid_invitation_code`, 409 `already_in_group`, 429 `too_many_attempts`. Enforces Domain Rule 2.5, 2.6.

#### `GET /v1/groups/:groupId/invitations`
- **Replaces**: `InvitationsRepository.getInvitations`
- **Auth**: Group Owner | **Derivation**: Read-only
- **Response 200**: `[{ "id": "uuid", "code": "HIMA2345", "status": "pending", "expiresAt": "..." }]`

#### `POST /v1/groups/:groupId/invitations`
- **Replaces**: `InvitationsRepository.createInvitation`
- **Auth**: Group Owner | **Idempotent**: Yes
- **Response 201**: Single-use 8-character code expiring in 7 days. Enforces Domain Rule 2.5.

#### `DELETE /v1/groups/:groupId/invitations/:invitationId`
- **Replaces**: `InvitationsRepository.revokeInvitation`
- **Auth**: Group Owner
- **Response 204**: No Content.

---

### 2.3 Members & Roles
#### `GET /v1/groups/:groupId/members`
- **Replaces**: `MembersRepository.getMembers`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: `[{ "id": "uuid", "displayName": "Sita", "roles": ["member"], "joinedAt": "...", "currentPeriodStatus": "verified" }]`

#### `GET /v1/groups/:groupId/members/:memberId`
- **Replaces**: `MembersRepository.getMemberDetail`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: Member detail, cumulative totals (`verifiedTotalPaisa`, `pendingTotalPaisa`), and monthly history rows.

#### `PATCH /v1/groups/:groupId/members/:memberId/role`
- **Replaces**: `MembersRepository.setTreasurerRole`
- **Auth**: Group Owner
- **Request**: `{ "isTreasurer": true }`
- **Response 200**: Updated member roles.
- **Errors**: 403 `forbidden`, 409 `cannot_remove_last_treasurer`. Enforces Domain Rule 2.9.

#### `DELETE /v1/groups/:groupId/members/:memberId`
- **Replaces**: `MembersRepository.removeMember`
- **Auth**: Group Owner
- **Response 204**: Soft removal (`left_at = NOW()`).
- **Errors**: 403 `forbidden`, 409 `cannot_remove_owner`, 409 `member_has_pending_payments`, 409 `cannot_remove_last_treasurer`. Enforces Domain Rule 2.7, 2.8.

---

### 2.4 Contributions & Obligations
#### `GET /v1/groups/:groupId/contributions/periods`
- **Replaces**: `ContributionsRepository.getPeriods`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: Monthly summaries (`periodId`, `dueDate`, `expectedTotalPaisa`, `verifiedReceivedPaisa`, `pendingTotalPaisa`, `aggregateStatus`).

#### `GET /v1/groups/:groupId/contributions/periods/:periodId`
- **Replaces**: `ContributionsRepository.getPeriod`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: Period summary with per-member obligation list. Enforces Domain Rule 3.1..3.4.

---

### 2.5 Payments
#### `POST /v1/groups/:groupId/payments`
- **Replaces**: `PaymentsRepository.submitPayment`
- **Auth**: Active Member | **Idempotent**: Required (`Idempotency-Key`)
- **Request**: `{ "periodId": "2026-11", "method": "esewa", "reference": "ESW12345", "note": "Nov fee" }`
- **Response 201**: Submission object (`amountPaisa` set by server). Status = `pending`.
- **Errors**: 400 `period_not_open`, 400 `not_obligated`, 409 `already_submitted`, 409 `duplicate_reference`, 400 `invalid_payment_input`. Enforces Domain Rule 4.1..4.4.

#### `GET /v1/groups/:groupId/payments/my`
- **Replaces**: `PaymentsRepository.getMyPayments`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: Submissions for the caller. References masked as `Ref ••••3456`. Enforces Domain Rule 4.6.

#### `GET /v1/groups/:groupId/payments/pending`
- **Replaces**: `PaymentsRepository.getPendingReviews`
- **Auth**: Treasurer | **Derivation**: Read-only
- **Response 200**: All pending submissions with unmasked references. Flag `isOwnSubmission` set. Enforces Domain Rule 4.6.

#### `POST /v1/groups/:groupId/payments/:submissionId/verify`
- **Replaces**: `PaymentsRepository.verifyPayment`
- **Auth**: Treasurer | **Idempotent**: Required (`Idempotency-Key`)
- **Response 200**: Verified submission and created ledger entry ID.
- **Errors**: 403 `forbidden`, 403 `cannot_review_own_payment`, 404 `submission_not_found`, 409 `already_reviewed`. Enforces Domain Rule 2.10, 4.5.

#### `POST /v1/groups/:groupId/payments/:submissionId/reject`
- **Replaces**: `PaymentsRepository.rejectPayment`
- **Auth**: Treasurer | **Idempotent**: Required (`Idempotency-Key`)
- **Request**: `{ "reason": "referenceNotFound", "note": "Cannot locate in statement" }`
- **Response 200**: Rejected submission.
- **Errors**: 403 `cannot_review_own_payment`, 404 `submission_not_found`, 409 `already_reviewed`, 400 `invalid_review_input`. Enforces Domain Rule 4.5.

---

### 2.6 Transactions & Ledger
#### `GET /v1/groups/:groupId/transactions`
- **Replaces**: `TransactionsRepository.getTransactions`
- **Auth**: Active Member | **Derivation**: Read-only (Paginated)
- **Response 200**: `{ "items": [TransactionRecord], "nextCursor": "..." }`

#### `GET /v1/groups/:groupId/transactions/:transactionId`
- **Replaces**: `TransactionsRepository.getTransaction`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: Single TransactionRecord.

#### `POST /v1/groups/:groupId/transactions`
- **Replaces**: `TransactionsRepository.recordTransaction`
- **Auth**: Treasurer | **Idempotent**: Required (`Idempotency-Key`)
- **Request**: `{ "kind": "expense", "amountPaisa": 50000, "occurredAt": "2026-11-10T10:00:00Z", "title": "Group dinner", "note": "Dinner bill", "method": "cash" }`
- **Response 201**: Created verified `TransactionRecord`.
- **Errors**: 400 `invalid_transaction_input`, 409 `insufficient_balance`. Enforces Domain Rule 5.3, 5.6, 5.7.

#### `POST /v1/groups/:groupId/transactions/:transactionId/reverse`
- **Replaces**: `TransactionsRepository.reverseTransaction`
- **Auth**: Treasurer | **Idempotent**: Required (`Idempotency-Key`)
- **Request**: `{ "reason": "Incorrect billing amount" }`
- **Response 201**: Linked compensating reversal record.
- **Errors**: 400 `transaction_not_reversible`, 409 `transaction_already_reversed`, 409 `insufficient_balance`. Enforces Domain Rule 5.5.

---

### 2.7 Approvals
#### `GET /v1/groups/:groupId/approvals`
- **Replaces**: `ApprovalsRepository.getApprovals`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: List of approval requests with live voting tallies.

#### `GET /v1/groups/:groupId/approvals/:requestId`
- **Replaces**: `ApprovalsRepository.getApproval`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: Single approval request with vote breakdown.

#### `POST /v1/groups/:groupId/approvals`
- **Replaces**: `ApprovalsRepository.createApproval`
- **Auth**: Active Member | **Idempotent**: Required (`Idempotency-Key`)
- **Request**: `{ "kind": "withdrawal", "amountPaisa": 100000, "title": "Tent purchase", "payee": "Camping Gear Ltd", "description": "Group equipment" }`
- **Response 201**: Created approval request with eligible voter snapshot.
- **Errors**: 400 `invalid_approval_input`, 400 `not_enough_members`, 409 `insufficient_balance`. Enforces Domain Rule 6.1..6.3.

#### `POST /v1/groups/:groupId/approvals/:requestId/vote`
- **Replaces**: `ApprovalsRepository.vote`
- **Auth**: Active Member (eligible voter) | **Idempotent**: Yes
- **Request**: `{ "approve": true }`
- **Response 200**: Updated approval request. Evaluates strict majority & early rejection.
- **Errors**: 403 `not_eligible_to_vote`, 403 `cannot_vote_on_own_request`, 409 `already_voted`, 409 `approval_not_open`. Enforces Domain Rule 6.3.

#### `POST /v1/groups/:groupId/approvals/:requestId/cancel`
- **Replaces**: `ApprovalsRepository.cancelApproval`
- **Auth**: Requester only | **Idempotent**: Yes
- **Response 200**: Cancelled request. Enforces Domain Rule 6.4.

#### `POST /v1/groups/:groupId/approvals/:requestId/execute`
- **Replaces**: `ApprovalsRepository.executeApproval`
- **Auth**: Treasurer | **Idempotent**: Required (`Idempotency-Key`)
- **Request**: `{ "method": "bankTransfer" }`
- **Response 200**: Executed request with linked ledger entry ID.
- **Errors**: 403 `forbidden`, 403 `cannot_review_own_payment`, 409 `approval_not_approved`, 409 `approval_already_executed`, 409 `insufficient_balance`. Enforces Domain Rule 6.5.

---

### 2.8 Dashboard & Reports
#### `GET /v1/groups/:groupId/dashboard`
- **Replaces**: `DashboardRepository.getDashboardSummary`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: `DashboardSummary` object (`verifiedBalancePaisa`, `pendingAmountPaisa`, `monthlyTargetPaisa`, `verifiedThisPeriodPaisa`, member statuses, recent activity, deadlines, balance history, last reconciliation). Enforces Domain Rule 8.1.

#### `GET /v1/groups/:groupId/reports/monthly?month=YYYY-MM`
- **Replaces**: `ReportsRepository.getMonthlyReport`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: `MonthlyReport` object. Enforces Domain Rule 8.2, 8.3.

#### `GET /v1/groups/:groupId/reports/members?month=YYYY-MM`
- **Replaces**: `ReportsRepository.getMemberReport`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: `MemberReport` object.

#### `GET /v1/groups/:groupId/reports/annual?year=YYYY&lastMonth=YYYY-MM`
- **Replaces**: `ReportsRepository.getAnnualReport`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: `AnnualReport` object.

#### `GET /v1/groups/:groupId/reports/outflow?year=YYYY&kind=expense|withdrawal`
- **Replaces**: `ReportsRepository.getOutflowReport`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: `OutflowReport` object.

---

### 2.9 Bank Reconciliation
#### `GET /v1/groups/:groupId/reconciliations`
- **Replaces**: `ReconciliationRepository.getReconciliations`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: List of past reconciliation records.

#### `GET /v1/groups/:groupId/reconciliations/recorded-balance?date=YYYY-MM-DD`
- **Replaces**: `ReconciliationRepository.getRecordedBalance`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: `{ "statementDate": "2026-11-05", "recordedBalancePaisa": 280000 }`. Enforces Domain Rule 7.3.

#### `POST /v1/groups/:groupId/reconciliations`
- **Replaces**: `ReconciliationRepository.recordReconciliation`
- **Auth**: Treasurer | **Idempotent**: Required (`Idempotency-Key`)
- **Request**: `{ "statementDate": "2026-11-05", "bankBalancePaisa": 280000, "note": "Statement verified" }`
- **Response 201**: Created `Reconciliation` record with difference.
- **Errors**: 403 `forbidden`, 400 `invalid_reconciliation_input`, 409 `reconciliation_already_recorded`. Enforces Domain Rule 7.1, 7.2, 7.5.

---

### 2.10 Updates & Feed
#### `GET /v1/groups/:groupId/updates`
- **Replaces**: `UpdatesRepository.getUpdates`
- **Auth**: Active Member | **Derivation**: Read-only
- **Response 200**: List of synthesized `UpdateItem` objects derived per caller. References and sensitive IDs are strictly omitted. Enforces Domain Rule 9.1..9.3.

#### `POST /v1/groups/:groupId/updates/mark-read`
- **Replaces**: In-memory read tracking in Flutter client
- **Auth**: Active Member
- **Request**: `{ "feedItemIds": ["due-2026-11", "appr-req123-needs-vote"] }`
- **Response 200**: `{ "markedCount": 2 }`

---

## 3. Versioning and Flutter Migration Plan

### 3.1 Migration Strategy
The Flutter app will swap mock implementations for API implementations incrementally via Riverpod provider overrides:
1. **Feature 1: Authentication & Session**: Swap `authRepositoryProvider` to call Firebase Auth & `/v1/profile`. Mock store remains for all groups.
2. **Feature 2: Group Management & Invitations**: Swap `groupsRepositoryProvider` and `invitationsRepositoryProvider`.
3. **Feature 3: Members & Roster**: Swap `membersRepositoryProvider`.
4. **Feature 4: Contributions & Payment Submissions**: Swap `contributionsRepositoryProvider` and `paymentsRepositoryProvider`.
5. **Feature 5: Transactions, Ledger & Approvals**: Swap `transactionsRepositoryProvider` and `approvalsRepositoryProvider`.
6. **Feature 6: Reports, Reconciliations & Updates**: Swap `reportsRepositoryProvider`, `reconciliationRepositoryProvider`, and `updatesRepositoryProvider`.

### 3.2 Shared Contract Testing
To ensure the backend API behaves identically to the Flutter mock repositories:
- Extract test fixtures (requests and expected responses) into shared JSON scenario vectors (`test/vectors/*.json`).
- Run the vector suite against:
  1. The Flutter mock repositories in Dart (`flutter test`).
  2. The Node.js Express API running against real PostgreSQL in Docker (`npm test`).
- Any divergence in status codes, error messages, or balance figures immediately fails CI.
