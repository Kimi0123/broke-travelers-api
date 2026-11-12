# REST API Contract (v1)

Versioned HTTP REST API specification for Broke Travelers backend API.

---

## 1. Global Conventions & Protocol

### 1.1 Transport & Base URL
- Protocol: HTTPS only (`http` redirects to `https`).
- Base Path: `/v1`.
- Payloads: JSON (`Content-Type: application/json; charset=utf-8`).

### 1.2 Authentication & User Provisioning
- **Header**: `Authorization: Bearer <firebase_id_token>` verified via Firebase Admin SDK.
- **First Sign-In & User Provisioning**:
  - *Recommendation*: Explicit idempotent `POST /v1/session` endpoint invoked by the client upon authentication or session restore.
  - *Justification*: Keeps middleware read-only (avoiding hidden database writes or write-lock races during concurrent `GET` requests), provides deterministic error handling, and allows explicit syncing of `display_name` if absent in Firebase token claims.
  - *Email Verification Policy*: Creating or joining a group requires `email_verified: true` in the token. Unverified accounts receive 403 `email_not_verified` (*Owner Decision*).
- **Group Authorization**: Scoped by `groupId` in the URL path. Server queries `group_memberships` for `(group_id, user_id)` and verifies `left_at IS NULL`.
- **Non-Member & Cross-Group Access Policy**: Callers who are not active members of `:groupId` strictly receive HTTP 404 `group_not_found` (never 403), even if the group exists. This prevents group existence enumeration. HTTP 403 `forbidden` is reserved strictly for role failures inside a group the caller actively belongs to.
- **Multi-Group Note**: `GET /v1/profile` returns `groups[]`. The Flutter app uses the first group until a group switcher UI is added in Phase 6.

### 1.3 Data Types & Formatting
- **Money Representation**: Integer paisa as JSON `number` (e.g. `70000` = 700 NPR). JavaScript `Number.MAX_SAFE_INTEGER` ($9 \times 10^{15}$) easily encompasses the $10,000,000$ NPR ($1,000,000,000$ paisa) application ceiling.
- **Timestamps & Dates**: ISO-8601 UTC strings (`YYYY-MM-DDTHH:mm:ss.sssZ`); date-only fields as `YYYY-MM-DD`.
- **Nepal Standard Time (NPT, UTC+05:45)**: All timestamps are stored in UTC. Calendar boundaries (period start, due day clamping, reconciliation `asOf` cutoff) are evaluated against NPT (UTC+05:45, no DST).

### 1.4 Rate Limiting & Proxy Configuration
- **Reverse Proxy**: Server sets `app.set('trust proxy', 1)` so `req.ip` resolves client IP through reverse proxies (Render, Railway, Cloudflare).
- **Rate Limits**:
  | Target | Limit | Window | Exceeded Response |
  |---|---|---|---|
  | Global per IP | 100 requests | 1 minute | 429 `too_many_attempts` |
  | Authenticated user | 120 requests | 1 minute | 429 `too_many_attempts` |
  | Invitation acceptance | 5 failed attempts | 5 minutes | 429 `too_many_attempts` |
  | Financial writes (`POST`) | 10 requests | 1 minute | 429 `too_many_attempts` |
- **429 Response Envelope**: Header `Retry-After: <seconds>` accompanies:
  `{ "error": { "code": "too_many_attempts", "message": "Too many requests. Please try again later.", "requestId": "..." } }`

### 1.5 Idempotency
- **Header**: `Idempotency-Key: <string>` required on all money-writing POST endpoints, `POST /v1/groups`, and `POST /v1/invitations/accept`. Must be 8 to 100 characters of `[A-Za-z0-9_-]`.
- **Validation**: If missing, returns 400 `idempotency_key_required`. If present but malformed (too short, too long, other characters, whitespace, unicode), returns 400 `invalid_idempotency_key`.
- **Scopes**:
  - Group-scoped (`(group_id, actor_user_id, operation, idempotency_key)`): payments, transactions, approvals, reconciliations, invitations.
  - User-scoped (`(actor_user_id, operation, idempotency_key)` where `group_id IS NULL`): `POST /v1/groups` and `POST /v1/invitations/accept`.
- **Replay & Conflict**: Replaying with identical body returns cached response with `Idempotent-Replay: true`. Mismatched body returns 409 `idempotency_conflict`.

### 1.6 Cold-Start & Health Handling
- The Flutter client initiates a background, fire-and-forget `GET /v1/health` ping at launch (non-blocking) to warm free-tier instances (Render).
- The client configures a 60-second timeout for the first network request, and 20 seconds for subsequent requests.
- Upon network timeout on money-writing POST endpoints, the client retries with the SAME `Idempotency-Key`.

---

## 2. API Endpoints Reference

### 2.1 Session & Groups
#### `POST /v1/session`
- **Replaces**: `AuthRepository.restoreSession`, `refreshCurrentUser`
- **Auth**: Firebase Bearer Token | **Idempotent**: Yes
- **Errors**: 401 `unauthenticated` (missing/invalid token), 400 `invalid_token_claims` (token missing email)
- **Request**: `{ "displayName": "Nirvan" }`
- **Response 200**: `{ "user": { "id": "uuid", "name": "Nirvan", "email": "..." }, "groups": [...] }`

#### `GET /v1/profile`
- **Replaces**: `ProfileRepository.getProfile`
- **Auth**: Authenticated User (`user_not_provisioned` if session not initialized) | **Derivation**: Read-only
- **Response 200**: User profile, active roles, and group memberships.

#### `POST /v1/groups`
- **Replaces**: `GroupsRepository.createGroup`
- **Auth**: Authenticated User | **Idempotent**: User-scoped (`Idempotency-Key` required)
- **Request**: `{ "name": "Himalayan Crew", "monthlyContributionPaisa": 70000, "dueDay": 5 }`
- **Response 201**: Group object. Creator is granted Owner & Treasurer.
- **Audit**: Writes audit log for group creation.

#### `GET /v1/groups/:groupId`
- **Replaces**: `GroupsRepository.getGroup`
- **Auth**: Active Member | **Derivation**: Read-only
- **Errors**: Non-members, unknown IDs, and invalid UUIDs return uniform 404 `group_not_found` to prevent enumeration.
- **Response 200**: Group details, contribution amount, member count, and caller's active role.

#### `PATCH /v1/groups/:groupId/settings`
- **Replaces**: `GroupsRepository.updateGroupSettings`
- **Auth**: Group Owner | Non-owner members get 403 `forbidden`.
- **Request**: `{ "name": "New Name", "dueDay": 10 }`
- **Errors**: 400 `invalid_group_settings` (validation error or attempting to modify immutable `monthlyContributionPaisa`).
- **Response 200**: Updated Group object. Writes audit log row for each modified setting.

#### `POST /v1/groups/:groupId/invitations`
- **Replaces**: `InvitationsRepository.createInvitation`
- **Auth**: Group Owner
- **Response 201**: `{ "invitation": { "id": "uuid", "groupId": "uuid", "code": "HIMA2345", "status": "pending", "expiresAt": "...", ... } }`
- **Lifecycle**: Issues 8-character single-use code expiring in 7 days.

#### `GET /v1/groups/:groupId/invitations`
- **Replaces**: `InvitationsRepository.getInvitations`
- **Auth**: Group Owner
- **Response 200**: `{ "invitations": [...] }`. Dynamic status evaluation (`pending`, `accepted`, `revoked`, `expired`).

#### `DELETE /v1/groups/:groupId/invitations/:invitationId`
- **Replaces**: `InvitationsRepository.revokeInvitation`
- **Auth**: Group Owner
- **Errors**: 409 `invitation_not_revocable` (if invitation is already accepted, expired, or revoked).
- **Response 200**: Updated invitation object with `status: "revoked"`.

#### `POST /v1/invitations/accept`
- **Replaces**: `InvitationsRepository.acceptInvitation`
- **Auth**: Authenticated User | **Idempotent**: User-scoped (`Idempotency-Key` required)
- **Request**: `{ "code": "HIMA2345" }`
- **Rate Limit & Lockout**: 5 failed attempts within 5 minutes triggers 429 `too_many_attempts` with `Retry-After`. Successful accept clears window.
- **Multi-Group & Rejoining Semantics**: If user is already an active member of this group, returns 409 `already_in_group`. If user was previously removed (`left_at IS NOT NULL`), creates a new active membership row while preserving historical links.
- **Errors**: Unknown, expired, or revoked codes return uniform 400 `invalid_invitation_code`.
- **Response 200**: `{ "group": { ... }, "membership": { ... } }`.

---

### 2.2 Members & Roles
#### `GET /v1/groups/:groupId/members`
- **Replaces**: `MembersRepository.getMembers`
- **Auth**: Active Member | **Derivation**: Read-only
- **Errors**: Non-members and unknown groups return uniform 404 `group_not_found`.
- **Ordering & Privacy**: Active members (`left_at IS NULL`) ordered by `joined_at ASC, id ASC`. Internal auth identifiers (`firebaseUid`) and other members' email addresses are strictly omitted.
- **Obligation**: Dynamically derives `currentPeriodStatus` via `deriveObligationStatus`.
- **Response 200**: `{ "members": [ ... ] }`.
- *(Note: Member detail `GET /v1/groups/:groupId/members/:memberId` moved to Task 5.4 alongside contribution history).*

#### `PATCH /v1/groups/:groupId/members/:memberId/role`
- **Replaces**: `MembersRepository.setTreasurerRole`
- **Auth**: Group Owner
- **Request**: `{ "isTreasurer": true }`
- **Errors**: 404 `member_not_found` (if member not active or not in group), 409 `cannot_remove_last_treasurer` (cannot remove treasurer status if user is the only treasurer).
- **Response 200**: Updated member object. Writes audit log row.

#### `DELETE /v1/groups/:groupId/members/:memberId`
- **Replaces**: `MembersRepository.removeMember`
- **Auth**: Group Owner
- **Errors & Invariant Precedence**:
  1. Target is group owner -> 409 `cannot_remove_owner`
  2. Target has pending payment submissions -> 409 `member_has_pending_payments`
  3. Target is the last treasurer -> 409 `cannot_remove_last_treasurer`
  4. Target not in group or already left -> 404 `member_not_found`
- **Response 204**: Soft removal (`left_at = NOW()`). Member immediately loses access (future group calls return 404 `group_not_found`). Writes audit log row.

---

### 2.3 Contributions & Payments
#### `GET /v1/groups/:groupId/contributions/periods` & `GET .../periods/:periodId`
- **Replaces**: `ContributionsRepository.getPeriods`, `getPeriod`
- **Auth**: Active Member | **Derivation**: Read-only. Returns period summaries and member obligations.
- **Errors**: 404 `period_not_found` (unknown or out-of-range period).

#### `POST /v1/groups/:groupId/payments`
- **Replaces**: `PaymentsRepository.submitPayment`
- **Auth**: Active Member | **Idempotent**: Group-scoped (`Idempotency-Key`)
- **Request**: `{ "periodId": "2026-11", "method": "esewa", "reference": "ESW12345", "note": "Nov fee" }`
- **Response 201**: Submission object. `amountPaisa` set by server. Reference normalized.

#### `GET /v1/groups/:groupId/payments/my`
- **Replaces**: `PaymentsRepository.getMyPayments`
- **Auth**: Active Member | **Derivation**: Read-only. References masked as `Ref ••••3456`.

#### `GET /v1/groups/:groupId/payments/pending`
- **Replaces**: `PaymentsRepository.getPendingReviews`
- **Auth**: Treasurer | **Derivation**: Read-only. Full unmasked references; `isOwnSubmission` flagged.

#### `POST /v1/groups/:groupId/payments/:submissionId/verify` & `.../reject`
- **Replaces**: `PaymentsRepository.verifyPayment`, `rejectPayment`
- **Auth**: Treasurer (separation of duties enforced) | **Idempotent**: Group-scoped (`Idempotency-Key`)
- **Verify**: Posts immutable ledger entry via `postVerifiedEntry`.
- **Reject**: `{ "reason": "referenceNotFound", "note": "..." }`. Allows member resubmission.

---

### 2.4 Unified Activity & Transactions
#### `GET /v1/groups/:groupId/transactions`
- **Replaces**: `TransactionsRepository.getTransactions`
- **Auth**: Active Member | **Derivation**: Unified Read Model (`v_activity_items`)
- **Query Params**: `?cursor=<opaque>&limit=20` (sorted `occurred_at DESC, id DESC`).
- **Response 200**:
  ```json
  {
    "items": [
      {
        "id": "ledger:01931f6d-20d0-7a00-8800-000000000001",
        "source": "ledger",
        "rawId": "01931f6d-20d0-7a00-8800-000000000001",
        "kind": "contribution",
        "title": "Nirvan's contribution",
        "amountPaisa": 70000,
        "status": "verified",
        "occurredAt": "2026-11-01T04:15:00.000Z",
        "memberId": "uuid",
        "memberName": "Nirvan",
        "paymentMethod": "esewa",
        "note": null,
        "reversesTransactionId": null,
        "reversedByTransactionId": null,
        "signedAmountPaisa": 70000
      },
      {
        "id": "submission:01931f6d-20d0-7a00-8800-000000000002",
        "source": "submission",
        "rawId": "01931f6d-20d0-7a00-8800-000000000002",
        "kind": "contribution",
        "title": "Hari's contribution",
        "amountPaisa": 70000,
        "status": "pendingVerification",
        "occurredAt": "2026-11-04T05:00:00.000Z",
        "memberId": "uuid",
        "memberName": "Hari",
        "paymentMethod": "cash",
        "note": null,
        "reversesTransactionId": null,
        "reversedByTransactionId": null,
        "signedAmountPaisa": 70000
      }
    ],
    "nextCursor": "...",
    "hasMore": false
  }
  ```
  *Flutter Mapping*: Maps directly to `TransactionRecord`, retaining all existing fields.

#### `GET /v1/groups/:groupId/transactions/:transactionId`
- **Replaces**: `TransactionsRepository.getTransaction`
- **Auth**: Active Member | **Response 200**: Single unified activity item.

#### `POST /v1/groups/:groupId/transactions`
- **Replaces**: `TransactionsRepository.recordTransaction`
- **Auth**: Treasurer | **Idempotent**: Group-scoped (`Idempotency-Key`)
- **Request**: `{ "kind": "expense", "amountPaisa": 50000, "occurredAt": "...", "title": "Dinner", "note": "...", "method": "cash" }`
- **Constraint**: Only `interest` and `expense` allowed. Withdrawals must use Approvals.

#### `POST /v1/groups/:groupId/transactions/:transactionId/reverse`
- **Replaces**: `TransactionsRepository.reverseTransaction`
- **Auth**: Treasurer | **Idempotent**: Group-scoped (`Idempotency-Key`)
- **Request**: `{ "reason": "Incorrect billing amount" }`
- **Constraint**: Only verified `interest` and `expense` can be reversed.

---

### 2.5 Approvals
#### `GET /v1/groups/:groupId/approvals` & `GET .../:requestId`
- **Replaces**: `ApprovalsRepository.getApprovals`, `getApproval`
- **Auth**: Active Member | **Derivation**: Read-only. Returns voting tallies, quorum status, myVote.

#### `POST /v1/groups/:groupId/approvals`
- **Replaces**: `ApprovalsRepository.createApproval`
- **Auth**: Active Member | **Idempotent**: Group-scoped (`Idempotency-Key`)
- **Request**: `{ "kind": "withdrawal", "amountPaisa": 100000, "title": "Tent", "payee": "Shop", "description": "..." }`
- **Rule**: Requires >= 2 members; snap-shots eligible voters excluding requester.

#### `POST /v1/groups/:groupId/approvals/:requestId/vote`
- **Replaces**: `ApprovalsRepository.vote`
- **Auth**: Eligible Voter | **Request**: `{ "approve": true }`. Strict majority with early rejection.

#### `POST /v1/groups/:groupId/approvals/:requestId/cancel`
- **Replaces**: `ApprovalsRepository.cancelApproval`
- **Auth**: Requester only | **Response 200**: Status = `cancelled`.

#### `POST /v1/groups/:groupId/approvals/:requestId/execute`
- **Replaces**: `ApprovalsRepository.executeApproval`
- **Auth**: Treasurer | **Idempotent**: Group-scoped (`Idempotency-Key`)
- **Rule**: Re-checks verified balance; posts immutable ledger entry; requester cannot execute if another treasurer exists.

---

### 2.6 Dashboard, Reports, Reconciliations & Updates
- `GET /v1/groups/:groupId/dashboard`: Replaces `DashboardRepository.getDashboardSummary`.
- `GET /v1/groups/:groupId/reports/*`: Replaces `ReportsRepository` (monthly, members, annual, outflow).
- `GET /v1/groups/:groupId/reconciliations`: Replaces `ReconciliationRepository.getReconciliations`.
- `GET /v1/groups/:groupId/reconciliations/recorded-balance?date=YYYY-MM-DD`: Replaces `getRecordedBalance`.
- `POST /v1/groups/:groupId/reconciliations`: Replaces `recordReconciliation` (Treasurer only, date unique, idempotent).
- `GET /v1/groups/:groupId/updates`: Replaces `UpdatesRepository.getUpdates` (Derived per viewer; references strictly omitted).
- `POST /v1/groups/:groupId/updates/mark-read`: Replaces client-only read tracking.

---

## 3. Appendix: Error Code to Flutter Message Mapping

| Error Code | HTTP | Flutter Source Location | Fixed User-Facing Message |
|---|---|---|---|
| `group_not_found` | 404 | `lib/core/error/group_access_exception.dart` | Group not found or access denied |
| `member_not_found` | 404 | `lib/features/group/presentation/screens/group_members_screen.dart` | Member not found |
| `forbidden` | 403 | `lib/core/error/permission_denied_exception.dart` | You do not have permission to perform this action |
| `unauthenticated` | 401 | `lib/core/error/auth_exceptions.dart` | Authentication required |
| `user_not_provisioned` | 401 | `lib/core/error/auth_exceptions.dart` | User record not provisioned; session creation required |
| `invalid_token_claims` | 400 | `lib/core/error/auth_exceptions.dart` | Token missing required claims (email) |
| `invalid_cursor` | 400 | Backend middleware | Pagination cursor is invalid or malformed |
| `idempotency_key_required` | 400 | Backend middleware | Idempotency-Key header is required for this operation |
| `invalid_idempotency_key` | 400 | Backend middleware | Idempotency-Key must be 8 to 100 characters of [A-Za-z0-9_-] |
| `idempotency_conflict` | 409 | `lib/core/error/ledger_posting_exception.dart` | Conflicting request payload for this idempotency key |
| `invitation_not_revocable` | 409 | `lib/features/group/presentation/screens/group_settings_screen.dart` | Cannot revoke an invitation that is already accepted, expired, or revoked |
| `email_not_verified` | 403 | *New backend requirement* | Please verify your email address before joining or creating a group |
| `group_creation_failed`| 409 | `lib/core/error/group_creation_exception.dart` | Unable to create group for this user |
| `invalid_group_settings`| 400 | `lib/core/error/group_validation_exception.dart` | Group name or due day failed validation |
| `cannot_remove_owner` | 409 | `lib/core/error/member_removal_blocked_exception.dart`| The group owner cannot be removed |
| `member_has_pending_payments`| 409 | `lib/core/error/member_removal_blocked_exception.dart`| Cannot remove member with pending payments |
| `cannot_remove_last_treasurer`| 409 | `lib/features/members/presentation/screens/member_detail_screen.dart` | Cannot remove the group's only treasurer |
| `insufficient_balance` | 409 | `lib/core/error/ledger_posting_exception.dart` | Insufficient verified balance to record transaction |
| `report_range_invalid` | 400 | `lib/core/error/report_range_exception.dart` | Requested report period is outside the group's history |
| `invalid_credentials` | 401 | `lib/features/authentication/presentation/auth_error_messages.dart` | Invalid email or password |
| `email_already_in_use` | 409 | `lib/features/authentication/presentation/auth_error_messages.dart` | An account already exists with this email |
| `weak_password` | 400 | `lib/features/authentication/presentation/auth_error_messages.dart` | Password must be at least 8 characters |
| `invalid_invitation_code`| 400 | `lib/features/group/presentation/screens/join_group_screen.dart` | Invitation code is invalid or expired |
| `already_in_group` | 409 | `lib/features/group/presentation/screens/join_group_screen.dart` | You are already a member of this group |
| `too_many_attempts` | 429 | `lib/features/group/presentation/screens/join_group_screen.dart` | Too many attempts; please try again later |
| `not_obligated` | 400 | `lib/features/payments/presentation/screens/submit_payment_screen.dart` | You are not obligated for this period |
| `period_not_open` | 400 | `lib/features/payments/presentation/screens/submit_payment_screen.dart` | This period is not open for submission |
| `period_not_found` | 404 | `lib/features/contributions/presentation/screens/contributions_screen.dart` | Contribution period not found |
| `already_submitted` | 409 | `lib/features/payments/presentation/screens/submit_payment_screen.dart` | A payment has already been submitted for this period |
| `duplicate_reference` | 409 | `lib/features/payments/presentation/screens/submit_payment_screen.dart` | This reference has already been used for another payment. |
| `invalid_payment_input`| 400 | `lib/features/payments/presentation/screens/submit_payment_screen.dart` | Please check the form for errors |
| `submission_not_found` | 404 | `lib/features/payments/presentation/screens/verify_payments_screen.dart` | Payment not found |
| `already_reviewed` | 409 | `lib/features/payments/presentation/screens/verify_payments_screen.dart` | This payment has already been reviewed |
| `cannot_review_own_payment`| 403 | `lib/features/payments/presentation/screens/verify_payments_screen.dart` | You cannot verify your own payment when another treasurer exists |
| `invalid_review_input` | 400 | `lib/features/payments/presentation/screens/verify_payments_screen.dart` | Review rejection reason or note failed validation |
| `invalid_transaction_input`| 400 | `lib/features/transactions/presentation/screens/record_transaction_screen.dart` | Please check transaction details |
| `transaction_not_found`| 404 | `lib/features/transactions/presentation/screens/transaction_detail_screen.dart` | Transaction not found |
| `transaction_not_reversible`| 400 | `lib/features/transactions/presentation/screens/transaction_detail_screen.dart` | This transaction cannot be reversed |
| `transaction_already_reversed`| 409 | `lib/features/transactions/presentation/screens/transaction_detail_screen.dart` | This transaction has already been reversed |
| `invalid_approval_input`| 400 | `lib/features/approvals/presentation/screens/create_approval_screen.dart` | Approval input failed validation |
| `not_enough_members` | 400 | `lib/features/approvals/presentation/screens/create_approval_screen.dart` | Group needs at least two members for approvals |
| `approval_not_found` | 404 | `lib/features/approvals/presentation/screens/approval_detail_screen.dart` | Approval request not found |
| `approval_not_open` | 409 | `lib/features/approvals/presentation/screens/approval_detail_screen.dart` | Approval request is closed or expired |
| `approval_not_approved`| 409 | `lib/features/approvals/presentation/screens/approval_detail_screen.dart` | Request has not reached approval threshold |
| `already_voted` | 409 | `lib/features/approvals/presentation/screens/approval_detail_screen.dart` | You have already voted on this request |
| `not_eligible_to_vote` | 403 | `lib/features/approvals/presentation/screens/approval_detail_screen.dart` | You are not eligible to vote on this request |
| `cannot_vote_on_own_request`| 403 | `lib/features/approvals/presentation/screens/approval_detail_screen.dart` | You cannot vote on your own request |
| `approval_already_executed`| 409 | `lib/features/approvals/presentation/screens/approval_detail_screen.dart` | This approval request has already been recorded |
| `invalid_reconciliation_input`| 400 | `lib/features/reports/presentation/screens/reconciliation_screen.dart` | Please check the statement date and balance |
| `reconciliation_already_recorded`| 409 | `lib/features/reports/presentation/screens/reconciliation_screen.dart` | A reconciliation has already been recorded for this statement date |
