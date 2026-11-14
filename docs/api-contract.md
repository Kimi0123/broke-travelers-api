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
- **Multi-Group Note**: `GET /v1/profile` returns `groups[]` ordered by `joinedAt ASC`. The Flutter app uses `groups[0]` until a group switcher UI is added in Phase 6.

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
  ```json
  {
    "user": {
      "id": "01931e50-1111-7000-8000-000000000001",
      "name": "Nirvan",
      "email": "nirvan@example.com"
    },
    "groups": [
      {
        "id": "01931e50-2222-7000-8000-000000000001",
        "name": "Himalayan Crew",
        "role": "owner",
        "isTreasurer": true,
        "monthlyContributionPaisa": 70000,
        "dueDay": 5,
        "memberCount": 5,
        "joinedAt": "2026-08-01T00:00:00.000Z"
      }
    ]
  }
  ```
- **Field Table (`groups[]`)**:
  | Field | Type | Description |
  |---|---|---|
  | `id` | UUID string | Group unique identifier |
  | `name` | string | Group display name |
  | `role` | `'owner' \| 'member'` | Caller's role in the group |
  | `isTreasurer` | boolean | Whether caller holds the Treasurer role |
  | `monthlyContributionPaisa` | integer | Group expected monthly contribution in paisa |
  | `dueDay` | integer (1–28) | Day of month when contributions are due |
  | `memberCount` | integer | Count of active members (`left_at IS NULL`) |
  | `joinedAt` | ISO-8601 UTC string | Timestamp when caller joined this group |

- **Flutter Mapping Note**:
  - `UserProfile.name` <- `user.name`
  - `roles` <- `role` (`'owner'` -> `GroupRole.owner`) + `isTreasurer` (`true` -> `GroupRole.treasurer`) (or `GroupRole.member` if neither)
  - `groupName` <- `groups[0].name`
  - `monthlyContribution` <- `Money.paisa(groups[0].monthlyContributionPaisa)` (integer only, never double)
  - `dueDay` <- `groups[0].dueDay`
  - `memberCount` <- `groups[0].memberCount`
  - `memberSince` <- `DateTime.parse(groups[0].joinedAt)` (UTC)
  - The Flutter app uses `groups[0]` (groups are ordered `joinedAt ASC`).

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
#### `GET /v1/groups/:groupId/members` (IMPLEMENTED)
- **Replaces**: `MembersRepository.getMembers`
- **Auth**: Active Member | **Derivation**: Read-only
- **Errors**: 404 `group_not_found`
- **Ordering & Privacy**: Active members (`left_at IS NULL`) ordered by `joined_at ASC, id ASC`. Internal auth identifiers (`firebaseUid`) and other members' email addresses are strictly omitted.
- **Obligation**: Dynamically derives `currentPeriodStatus` via `deriveObligationStatus`.
- **Response 200**: `{ "members": [ ... ] }`.

#### `GET /v1/groups/:groupId/members/:memberId` (IMPLEMENTED)
- **Replaces**: `MembersRepository.getMemberDetail`
- **Auth**: Active Member | **Derivation**: Read-only
- **Errors**: 404 `group_not_found`, 404 `member_not_found`
- **Privacy Filtering**: Only Treasurers and the member themselves see payment references in the contribution history. Non-treasurer members viewing another member's profile receive `reference: null`.
- **Response 200**:
  ```json
  {
    "member": {
      "id": "uuid",
      "name": "Nirvan",
      "role": "owner",
      "isTreasurer": true,
      "joinedAt": "2026-08-01T00:00:00.000Z",
      "verifiedTotalPaisa": 210000,
      "pendingTotalPaisa": 0,
      "verifiedMonthCount": 3,
      "history": [
        {
          "periodMonth": "2026-11",
          "status": "paid",
          "paidAt": "2026-11-02T10:00:00.000Z",
          "amountPaisa": 70000,
          "method": "esewa",
          "reference": "ESW12345"
        }
      ]
    }
  }
  ```

#### `PATCH /v1/groups/:groupId/members/:memberId/role` (IMPLEMENTED)
- **Replaces**: `MembersRepository.setTreasurerRole`
- **Auth**: Group Owner
- **Request**: `{ "isTreasurer": true }`
- **Errors**: 404 `member_not_found` (if member not active or not in group), 409 `cannot_remove_last_treasurer` (cannot remove treasurer status if user is the only treasurer).
- **Response 200**: Updated member object. Writes audit log row.

#### `DELETE /v1/groups/:groupId/members/:memberId` (IMPLEMENTED)
- **Replaces**: `MembersRepository.removeMember`
- **Auth**: Group Owner
- **Errors**: 404 `member_not_found`, 409 `cannot_remove_owner`, 409 `member_has_pending_payments`, 409 `cannot_remove_last_treasurer`
- **Invariant Precedence**:
  1. Target is group owner -> 409 `cannot_remove_owner`
  2. Target has pending payment submissions -> 409 `member_has_pending_payments`
  3. Target is the last treasurer -> 409 `cannot_remove_last_treasurer`
  4. Target not in group or already left -> 404 `member_not_found`
- **Response 204**: Soft removal (`left_at = NOW()`). Member immediately loses access (future group calls return 404 `group_not_found`). Writes audit log row.

---

### 2.3 Contributions & Payments
#### `GET /v1/groups/:groupId/contributions/periods` (IMPLEMENTED)
- **Replaces**: `ContributionsRepository.getPeriods`
- **Auth**: Active Member | **Derivation**: Read-only
- **Errors**: 404 `group_not_found`
- **Response 200**:
  ```json
  {
    "periods": [
      {
        "id": "2026-11",
        "month": "2026-11",
        "expectedAmountPaisa": 70000,
        "collectedAmountPaisa": 210000,
        "totalObligatedPaisa": 280000,
        "paidCount": 3,
        "obligatedCount": 4,
        "myStatus": "paid",
        "isCurrent": true
      }
    ]
  }
  ```

#### `GET /v1/groups/:groupId/contributions/periods/:periodId` (IMPLEMENTED)
- **Replaces**: `ContributionsRepository.getPeriod`
- **Auth**: Active Member | **Derivation**: Read-only
- **Errors**: 404 `group_not_found`, 404 `period_not_found`
- **Response 200**:
  ```json
  {
    "period": {
      "id": "2026-11",
      "month": "2026-11",
      "expectedAmountPaisa": 70000,
      "collectedAmountPaisa": 210000,
      "totalObligatedPaisa": 280000,
      "paidCount": 3,
      "obligatedCount": 4,
      "myStatus": "paid",
      "isCurrent": true
    },
    "obligations": [
      {
        "memberId": "uuid",
        "memberName": "Nirvan",
        "status": "paid",
        "paidAt": "2026-11-02T10:00:00.000Z",
        "amountPaisa": 70000
      }
    ]
  }
  ```

#### `POST /v1/groups/:groupId/payments` (IMPLEMENTED)
- **Replaces**: `PaymentsRepository.submitPayment`
- **Auth**: Active Member | **Idempotent**: Group-scoped (`Idempotency-Key` required)
- **Request**:
  ```json
  {
    "periodId": "2026-11",
    "method": "esewa",
    "reference": "ESW12345",
    "note": "Nov fee"
  }
  ```
- **Errors**: 400 `idempotency_key_required`, 400 `invalid_idempotency_key`, 400 `invalid_payment_input`, 400 `not_obligated`, 400 `period_not_open`, 404 `group_not_found`, 409 `already_submitted`, 409 `duplicate_reference`, 409 `idempotency_conflict`
- **Response 201**: Submission object. `amountPaisa` is derived server-side from group settings (client amounts are strictly rejected). Reference is normalized and returned masked (`referenceMasked` as `ESW-***-12345` or `N/A`), preventing raw reference credential leaks.

#### `GET /v1/groups/:groupId/payments/my` (IMPLEMENTED)
- **Replaces**: `PaymentsRepository.getMyPayments`
- **Auth**: Active Member | **Derivation**: Read-only
- **Errors**: 404 `group_not_found`
- **Privacy**: References are masked as `Ref ••••3456` (or `Ref ••••` for references of 4 characters or fewer). Status values: `pendingVerification`, `verified`, `rejected`.
- **Response 200**:
  ```json
  {
    "submissions": [
      {
        "id": "uuid",
        "periodMonth": "2026-11",
        "amountPaisa": 70000,
        "method": "esewa",
        "referenceMasked": "Ref ••••2345",
        "status": "pendingVerification",
        "submittedAt": "2026-11-04T05:00:00.000Z",
        "reviewedAt": null,
        "rejectionReason": null
      }
    ]
  }
  ```

#### `GET /v1/groups/:groupId/payments/pending` (IMPLEMENTED)
- **Replaces**: `PaymentsRepository.getPendingReviews`
- **Auth**: Treasurer | Non-treasurers receive 403 `forbidden`.
- **Errors**: 403 `forbidden`, 404 `group_not_found`
- **Privacy & Separation**: Full unmasked stored references; `isOwnSubmission: boolean` flagged for separation of duties.
- **Response 200**:
  ```json
  {
    "reviews": [
      {
        "submissionId": "uuid",
        "memberId": "uuid",
        "memberName": "Hari",
        "periodMonth": "2026-11",
        "amountPaisa": 70000,
        "method": "esewa",
        "reference": "KH778899",
        "note": "November contribution",
        "submittedAt": "2026-11-04T05:00:00.000Z",
        "isOwnSubmission": false
      }
    ]
  }
  ```

#### `POST /v1/groups/:groupId/payments/:submissionId/verify` (IMPLEMENTED)
- **Replaces**: `PaymentsRepository.verifyPayment`
- **Auth**: Treasurer | **Idempotent**: Group-scoped (`Idempotency-Key` required)
- **Errors**: 400 `idempotency_key_required`, 400 `invalid_idempotency_key`, 403 `forbidden`, 403 `cannot_review_own_payment`, 404 `group_not_found`, 404 `submission_not_found`, 409 `already_reviewed`, 409 `idempotency_conflict`
- **Separation of Duties**: A sole treasurer can verify their own submission; if 2+ active treasurers exist, self-verification returns 403 `cannot_review_own_payment`.
- **Post**: Atomically sets submission status to `verified`, posts exactly one immutable ledger entry (`postVerifiedEntry`), creates an audit log entry, and updates the unified activity feed.
- **Response 200**: `{ "submission": { ... }, "ledgerEntry": { ... } }`

#### `POST /v1/groups/:groupId/payments/:submissionId/reject` (IMPLEMENTED)
- **Replaces**: `PaymentsRepository.rejectPayment`
- **Auth**: Treasurer | **Idempotent**: Group-scoped (`Idempotency-Key` required)
- **Request**:
  ```json
  {
    "reason": "referenceNotFound",
    "note": "Reference could not be found in eSewa statement"
  }
  ```
- **Errors**: 400 `idempotency_key_required`, 400 `invalid_idempotency_key`, 400 `invalid_request`, 403 `forbidden`, 403 `cannot_review_own_payment`, 404 `group_not_found`, 404 `submission_not_found`, 409 `already_reviewed`, 409 `idempotency_conflict`
- **Post**: Atomically sets submission status to `rejected`, records rejection reason/note, creates audit log entry, and clears the pending obligation so member can resubmit.
- **Response 200**: `{ "submission": { ... } }`

---

### 2.4 Unified Activity & Transactions
#### `GET /v1/groups/:groupId/transactions` (IMPLEMENTED)
- **Replaces**: `TransactionsRepository.getTransactions`
- **Auth**: Active Member | **Derivation**: Unified Read Model (`v_activity_items`)
- **Query Params**: `?cursor=<opaque>&limit=20` (sorted `occurred_at DESC, id DESC`).
- **Errors**: 400 `invalid_cursor`, 404 `group_not_found`
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

#### `GET /v1/groups/:groupId/transactions/:transactionId` (IMPLEMENTED)
- **Replaces**: `TransactionsRepository.getTransaction`
- **Auth**: Active Member | **Derivation**: Read-only
- **Errors**: 404 `group_not_found`, 404 `transaction_not_found`
- **Lookup**: Accepts compound IDs only (`ledger:<uuid>` or `submission:<uuid>`). Bare UUIDs return 404 `transaction_not_found`.
- **Stale Submission Resolution**: A `submission:<uuid>` lookup for a payment submission that has been verified automatically resolves to and returns the resulting `ledger:<ledgerEntryId>` item.
- **Visibility**: Rejected submissions are visible only to the submitting member or group treasurer/owner. Other active members querying a rejected submission receive 404 `transaction_not_found`.
- **Response 200**: `{ "item": { ... } }`

#### `POST /v1/groups/:groupId/transactions` (IMPLEMENTED)
- **Replaces**: `TransactionsRepository.recordTransaction`
- **Auth**: Treasurer | **Idempotent**: Group-scoped (`Idempotency-Key` required)
- **Request**:
  ```json
  {
    "kind": "expense",
    "amountPaisa": 50000,
    "occurredAt": "2026-11-03T12:00:00.000Z",
    "title": "Group Dinner",
    "note": "Paid cash at restaurant",
    "method": "cash"
  }
  ```
- **Constraint**: Only `interest` and `expense` allowed directly. Withdrawals must use the multi-member Approvals lifecycle.
- **Errors**: 400 `idempotency_key_required`, 400 `invalid_idempotency_key`, 400 `invalid_request`, 403 `forbidden`, 404 `group_not_found`, 409 `insufficient_balance`, 409 `idempotency_conflict`
- **Response 201**: `{ "transaction": { ... } }`

#### `POST /v1/groups/:groupId/transactions/:transactionId/reverse` (IMPLEMENTED)
- **Replaces**: `TransactionsRepository.reverseTransaction`
- **Auth**: Treasurer | **Idempotent**: Group-scoped (`Idempotency-Key` required)
- **Request**: `{ "reason": "Incorrect billing amount" }`
- **Constraint**: Only verified `interest` and `expense` ledger entries can be reversed. Contributions must be handled via payment workflow, withdrawals via governance.
- **Errors**: 400 `idempotency_key_required`, 400 `invalid_idempotency_key`, 400 `invalid_request`, 400 `transaction_not_reversible`, 403 `forbidden`, 404 `group_not_found`, 404 `transaction_not_found`, 409 `insufficient_balance`, 409 `transaction_already_reversed`, 409 `idempotency_conflict`
- **Response 200**: `{ "transaction": { ... } }`

---

### 2.7 Approvals (IMPLEMENTED)

Multi-member approval governance workflow for expenses and withdrawals. Requires at least 2 active members on the roster.

#### `POST /v1/groups/:groupId/approvals` (IMPLEMENTED)
- **Replaces**: `ApprovalsRepository.createApproval`
- **Auth**: Active Member | **Idempotent**: Group-scoped (`Idempotency-Key` required)
- **Request**:
  ```json
  {
    "kind": "withdrawal",
    "amountPaisa": 100000,
    "title": "Trekking Tent",
    "payee": "Outdoor Gear Ltd",
    "description": "2-person tent for Himalayan expedition"
  }
  ```
- **Rules & Constraints**:
  - `kind`: `withdrawal` or `expense` only.
  - `amountPaisa`: Integer paisa (1 to 1,000,000,000). Must not exceed current verified group balance at request creation time (409 `insufficient_balance`).
  - `title`: 1..60 characters, trimmed, printable characters only.
  - `payee`: 1..60 characters, trimmed, printable characters only.
  - `description`: Optional, max 500 characters, trimmed.
  - Active roster must have at least 2 members (400 `not_enough_members`).
  - Snapshots eligible voters: all active members at creation time excluding the requester.
  - Quorum calculation: `votesNeeded = Math.ceil((activeMembers - 1) / 2)`.
  - Initial status: `open`. Expires automatically after 7 calendar days at 23:59:59.999 NPT.
- **Errors**: 400 `idempotency_key_required`, 400 `invalid_idempotency_key`, 400 `invalid_approval_input`, 400 `not_enough_members`, 404 `group_not_found`, 409 `insufficient_balance`, 409 `idempotency_conflict`
- **Response 201**: `{ "approval": { ... } }`

#### `GET /v1/groups/:groupId/approvals` (IMPLEMENTED)
- **Replaces**: `ApprovalsRepository.getApprovals`
- **Auth**: Active Member | **Derivation**: Read-only
- **Query Params**: `?status=open|approved|rejected|expired|cancelled|executed&kind=expense|withdrawal&cursor=<opaque>&limit=20` (sorted `createdAt DESC, id DESC`).
- **Errors**: 400 `invalid_cursor`, 404 `group_not_found`
- **Response 200**:
  ```json
  {
    "approvals": [
      {
        "id": "uuid",
        "groupId": "uuid",
        "kind": "withdrawal",
        "title": "Trekking Tent",
        "amountPaisa": 100000,
        "payee": "Outdoor Gear Ltd",
        "description": "2-person tent for Himalayan expedition",
        "status": "open",
        "createdAt": "2026-11-01T10:00:00.000Z",
        "expiresAt": "2026-11-08T18:14:59.999Z",
        "createdByMemberId": "uuid",
        "createdByName": "Member B",
        "createdByEmail": "b@example.com",
        "eligibleVoterCount": 5,
        "votesNeeded": 3,
        "approvedCount": 1,
        "rejectedCount": 0,
        "myVote": "approved",
        "executedAt": null,
        "executedByMemberId": null,
        "postedLedgerEntryId": null
      }
    ],
    "nextCursor": null,
    "hasMore": false
  }
  ```

#### `GET /v1/groups/:groupId/approvals/:requestId` (IMPLEMENTED)
- **Replaces**: `ApprovalsRepository.getApproval`
- **Auth**: Active Member | **Derivation**: Read-only
- **Errors**: 404 `group_not_found`, 404 `approval_not_found`
- **Response 200**:
  ```json
  {
    "approval": {
      "id": "uuid",
      "groupId": "uuid",
      "kind": "withdrawal",
      "title": "Trekking Tent",
      "amountPaisa": 100000,
      "payee": "Outdoor Gear Ltd",
      "description": "2-person tent for Himalayan expedition",
      "status": "open",
      "createdAt": "2026-11-01T10:00:00.000Z",
      "expiresAt": "2026-11-08T18:14:59.999Z",
      "createdByMemberId": "uuid",
      "createdByName": "Member B",
      "createdByEmail": "b@example.com",
      "eligibleVoterCount": 5,
      "votesNeeded": 3,
      "approvedCount": 1,
      "rejectedCount": 0,
      "myVote": "approved",
      "executedAt": null,
      "executedByMemberId": null,
      "postedLedgerEntryId": null,
      "voters": [
        {
          "memberId": "uuid",
          "memberName": "Ram",
          "memberEmail": "ram@example.com",
          "hasVoted": true,
          "approved": true,
          "votedAt": "2026-11-02T10:00:00.000Z"
        }
      ]
    }
  }
  ```

#### `POST /v1/groups/:groupId/approvals/:requestId/vote` (IMPLEMENTED)
- **Replaces**: `ApprovalsRepository.vote`
- **Auth**: Active Member in eligible voter snapshot
- **Request**: `{ "approve": true }`
- **Rules & Constraints**:
  - Requester cannot vote on their own request (403 `cannot_vote_on_own_request`).
  - Caller must be present in request's snapshotted eligible voter list (403 `not_eligible_to_vote`).
  - A member can vote at most once; votes cannot be changed (409 `already_voted`).
  - Request must be in `open` status (409 `approval_not_open`). Expired requests evaluate dynamically.
  - Strict majority threshold: status transitions to `approved` immediately when `approvedCount >= votesNeeded`.
  - Early rejection: status transitions to `rejected` immediately when `rejectedCount > eligibleVoterCount - votesNeeded`.
- **Errors**: 400 `invalid_approval_input`, 403 `forbidden`, 403 `cannot_vote_on_own_request`, 403 `not_eligible_to_vote`, 404 `group_not_found`, 404 `approval_not_found`, 409 `approval_not_open`, 409 `already_voted`
- **Response 200**: `{ "approval": { ... } }`

#### `POST /v1/groups/:groupId/approvals/:requestId/cancel` (IMPLEMENTED)
- **Replaces**: `ApprovalsRepository.cancelApproval`
- **Auth**: Request creator only (403 `forbidden` if attempted by any other member or treasurer)
- **Request**: `{}`
- **Rules & Constraints**:
  - Request must currently be `open` (409 `approval_not_open`).
  - Status transitions to `cancelled`. Audit log entry created.
- **Errors**: 403 `forbidden`, 404 `group_not_found`, 404 `approval_not_found`, 409 `approval_not_open`
- **Response 200**: `{ "approval": { ... } }`

#### `POST /v1/groups/:groupId/approvals/:requestId/execute` (IMPLEMENTED)
- **Replaces**: `ApprovalsRepository.executeApproval`
- **Auth**: Treasurer | **Idempotent**: Group-scoped (`Idempotency-Key` required)
- **Request**:
  ```json
  {
    "paymentMethod": "cash",
    "reference": null
  }
  ```
- **Separation of Duties**:
  - The request creator cannot execute their own approved request if another active treasurer exists on the group roster (403 `cannot_execute_own_request`).
  - A sole treasurer is permitted to execute their own request.
- **Execution Rules**:
  - Request must be in `approved` status (409 `approval_not_approved` if open/rejected/expired/cancelled; 409 `approval_already_executed` if already executed).
  - Current verified group balance must be >= `amountPaisa` (409 `insufficient_balance`).
  - All financial payload attributes (`amountPaisa`, `title`, `payee`, `kind`, `memberId`) are strictly populated from the stored approval request. The client provides only `paymentMethod` and optional `reference`.
  - Atomically: posts exactly 1 immutable ledger entry, updates approval request to `executed` with `postedLedgerEntryId` and `executedAt`, and writes audit log entries.
- **Errors**: 400 `idempotency_key_required`, 400 `invalid_idempotency_key`, 400 `invalid_approval_input`, 403 `forbidden`, 403 `cannot_execute_own_request`, 404 `group_not_found`, 404 `approval_not_found`, 409 `approval_not_approved`, 409 `approval_already_executed`, 409 `insufficient_balance`, 409 `idempotency_conflict`
- **Response 200**: `{ "approval": { ... }, "ledgerEntry": { ... } }`

---

### 2.8 Bank Reconciliation (IMPLEMENTED)

Provides formal monthly and periodic bank statement reconciliation against the immutable verified ledger.

#### `GET /v1/groups/:groupId/reconciliations` (IMPLEMENTED)
- **Replaces**: `ReconciliationRepository.getReconciliations`
- **Auth**: Active Member | **Derivation**: Read-only
- **Query Params**: `?cursor=<opaque>&limit=20` (sorted `statementDate DESC, id DESC`).
- **Errors**: 400 `invalid_cursor`, 404 `group_not_found`
- **Response 200**:
  ```json
  {
    "reconciliations": [
      {
        "id": "uuid",
        "groupId": "uuid",
        "statementDate": "2026-10-31",
        "bankBalancePaisa": 730000,
        "recordedBalancePaisa": 730000,
        "differencePaisa": 0,
        "note": "October bank statement reconciled",
        "reconciledByMemberId": "uuid",
        "reconciledByName": "Aarav Owner",
        "reconciledByEmail": "owner@example.com",
        "createdAt": "2026-11-01T04:00:00.000Z"
      }
    ],
    "nextCursor": null,
    "hasMore": false
  }
  ```

#### `GET /v1/groups/:groupId/reconciliations/recorded-balance` (IMPLEMENTED)
- **Replaces**: `ReconciliationRepository.getRecordedBalance`
- **Auth**: Active Member | **Derivation**: Read-only
- **Query Params**: `?date=YYYY-MM-DD` (Required, valid calendar date).
- **Rules & Constraints**:
  - `date`: Must be valid `YYYY-MM-DD` and cannot be in the future in NPT wall clock (400 `invalid_statement_date`).
  - Server evaluates cutoff at NPT statement date end-of-day: `statementDate 23:59:59.999 NPT` (converted to UTC timestamp boundary).
  - Derived balance equals the sum of `signedPaisa` of all verified ledger entries posted on or before the cutoff timestamp.
- **Errors**: 400 `invalid_statement_date`, 404 `group_not_found`
- **Response 200**:
  ```json
  {
    "statementDate": "2026-10-31",
    "recordedBalancePaisa": 730000
  }
  ```

#### `POST /v1/groups/:groupId/reconciliations` (IMPLEMENTED)
- **Replaces**: `ReconciliationRepository.recordReconciliation`
- **Auth**: Treasurer | **Idempotent**: Group-scoped (`Idempotency-Key` required)
- **Request**:
  ```json
  {
    "statementDate": "2026-10-31",
    "bankBalancePaisa": 730000,
    "note": "Statement matches passbook"
  }
  ```
- **Rules & Constraints**:
  - `statementDate`: `YYYY-MM-DD`, valid calendar date, NPT today or earlier (400 `invalid_statement_date`).
  - Only one reconciliation can be recorded per `statementDate` for each group (409 `reconciliation_already_recorded`).
  - `bankBalancePaisa`: Non-negative integer paisa (0 to 1,000,000,000).
  - `recordedBalancePaisa` and `differencePaisa` (`bankBalancePaisa - recordedBalancePaisa`) are strictly computed server-side. Any client-sent values for these fields are rejected.
  - Recording a reconciliation NEVER mutates, edits, or adjusts any ledger entries.
  - An append-only audit log entry (`reconciliation.recorded`) is written with statement date and difference.
- **Errors**: 400 `idempotency_key_required`, 400 `invalid_idempotency_key`, 400 `invalid_statement_date`, 400 `invalid_reconciliation_input`, 403 `forbidden`, 404 `group_not_found`, 409 `reconciliation_already_recorded`, 409 `idempotency_conflict`
- **Response 201**: `{ "reconciliation": { ... } }`

---

### 2.9 Dashboard, Reports & Updates (IMPLEMENTED)

Read-only derivations loaded in one `REPEATABLE READ` snapshot. Financial computations are purely functional (in `report-builders.ts`, `ledger-math.ts`, `obligation-status.ts`, and `due-dates.ts`); no financial logic in SQL or routes. All derived read endpoints set `Cache-Control: no-store`.

#### `GET /v1/groups/:groupId/dashboard` (IMPLEMENTED)
- **Replaces**: `DashboardRepository.getDashboardSummary`
- **Auth**: Active Member | **Derivation**: Read-only (`Cache-Control: no-store`)
- **Privacy Rules**:
  - `pendingAmountPaisa`: Group-wide pending total (one number, no names) is visible to ALL active members, matching the Flutter Home.
  - `needsYourVote`: True if caller is in `eligibleVoters` for an open approval and has not yet voted.
- **Errors**: 401 `unauthenticated`, 404 `group_not_found`
- **Response 200**:
  ```json
  {
    "verifiedBalancePaisa": 730000,
    "pendingAmountPaisa": 70000,
    "obligatedMemberCount": 4,
    "verifiedMemberCount": 3,
    "upcomingDeadline": {
      "date": "2026-11-05",
      "label": "5 Nov",
      "isOverdue": true
    },
    "recentActivity": [
      {
        "id": "e13",
        "source": "ledger",
        "rawId": "uuid",
        "kind": "contribution",
        "title": "Ram's contribution",
        "amountPaisa": 70000,
        "status": "verified",
        "occurredAt": "2026-11-03T04:00:00.000Z",
        "signedAmountPaisa": 70000
      }
    ],
    "openApprovalsCount": 1,
    "needsYourVote": true,
    "lastReconciliation": {
      "statementDate": "2026-10-31",
      "status": "matched",
      "differencePaisa": 0
    }
  }
  ```

#### `GET /v1/groups/:groupId/reports/months` (IMPLEMENTED)
- **Replaces**: `ReportsRepository.getSelectableMonths` / `getSelectableYears`
- **Auth**: Active Member | **Derivation**: Read-only (`Cache-Control: no-store`)
- **Rules**: Returns selectable months (`YYYY-MM`) and years (`YYYY`) from group creation month to current anchor month in chronological order.
- **Errors**: 401 `unauthenticated`, 404 `group_not_found`
- **Response 200**:
  ```json
  {
    "selectableMonths": ["2026-09", "2026-10", "2026-11"],
    "selectableYears": [2026]
  }
  ```

#### `GET /v1/groups/:groupId/reports/monthly` (IMPLEMENTED)
- **Replaces**: `ReportsRepository.getMonthlyReport`
- **Auth**: Active Member | **Derivation**: Read-only (`Cache-Control: no-store`)
- **Query Params**: `?month=YYYY-MM` (Required, within group history range).
- **Rules**: Contributions grouped by `effectivePeriodMonth`; interest, expenses, and withdrawals grouped by `occurredAt`. Reversals netted.
- **Errors**: 400 `invalid_request`, 400 `report_range_invalid`, 401 `unauthenticated`, 404 `group_not_found`
- **Response 200**:
  ```json
  {
    "month": "2026-11",
    "openingPaisa": 520000,
    "contributionsPaisa": 210000,
    "interestPaisa": 0,
    "expensesPaisa": 0,
    "withdrawalsPaisa": 0,
    "closingPaisa": 730000,
    "pendingPaisa": 70000,
    "obligatedCount": 4,
    "verifiedCount": 3,
    "expectedTotalPaisa": 280000,
    "outstandingPaisa": 70000
  }
  ```

#### `GET /v1/groups/:groupId/reports/members` (IMPLEMENTED)
- **Replaces**: `ReportsRepository.getMemberReport`
- **Auth**: Active Member | **Derivation**: Read-only (`Cache-Control: no-store`)
- **Query Params**: `?month=YYYY-MM` (Required, within group history range).
- **Privacy Rules**: In member rows, a viewer who is neither that member, nor a treasurer, nor the owner receives `null` for that member's `pendingPaisa` (never 0), while the member's status (for example `pendingVerification`) stays visible. Treasurers, owners, and the member themself receive the integer paisa amount. The totals row `pendingTotalPaisa` shows the viewer's own pending total for plain members, or the group pending total for treasurers and owners.
- **Errors**: 400 `invalid_request`, 400 `report_range_invalid`, 401 `unauthenticated`, 404 `group_not_found`
- **Response 200**:
  ```json
  {
    "month": "2026-11",
    "rows": [
      {
        "memberId": "uuid",
        "name": "Hari",
        "expectedPaisa": 70000,
        "verifiedPaisa": 0,
        "pendingPaisa": 70000,
        "outstandingPaisa": 70000,
        "status": "pendingVerification"
      }
    ],
    "expectedTotalPaisa": 280000,
    "verifiedTotalPaisa": 210000,
    "pendingTotalPaisa": 70000,
    "outstandingTotalPaisa": 70000
  }
  ```

#### `GET /v1/groups/:groupId/reports/annual` (IMPLEMENTED)
- **Replaces**: `ReportsRepository.getAnnualReport`
- **Auth**: Active Member | **Derivation**: Read-only (`Cache-Control: no-store`)
- **Query Params**: `?year=YYYY` (Required, integer).
- **Rules**: Sums monthly rows for the calendar year up to current anchor month.
- **Errors**: 400 `invalid_request`, 400 `report_range_invalid`, 401 `unauthenticated`, 404 `group_not_found`
- **Response 200**:
  ```json
  {
    "year": 2026,
    "months": [
      {
        "month": "2026-11",
        "contributionsPaisa": 210000,
        "interestPaisa": 0,
        "expensesPaisa": 0,
        "withdrawalsPaisa": 0,
        "netPaisa": 210000,
        "closingPaisa": 730000
      }
    ],
    "contributionsPaisa": 770000,
    "interestPaisa": 10000,
    "expensesPaisa": 50000,
    "withdrawalsPaisa": 0,
    "netPaisa": 730000,
    "closingPaisa": 730000
  }
  ```

#### `GET /v1/groups/:groupId/reports/expenses` and `GET /v1/groups/:groupId/reports/withdrawals` (IMPLEMENTED)
- **Replaces**: `ReportsRepository.getOutflowReport`
- **Auth**: Active Member | **Derivation**: Read-only (`Cache-Control: no-store`)
- **Query Params**: `?year=YYYY` (Required, integer).
- **Rules**: Outflow rows with `isReversed` and `isReversal` flags. Reversals netted in `totalPaisa` and `monthTotals`.
- **Errors**: 400 `invalid_request`, 400 `report_range_invalid`, 401 `unauthenticated`, 404 `group_not_found`
- **Response 200**:
  ```json
  {
    "year": 2026,
    "kind": "expense",
    "rows": [
      {
        "id": "e10",
        "title": "Group dinner",
        "date": "2026-10-30",
        "amountPaisa": 50000,
        "isReversed": false,
        "isReversal": false
      }
    ],
    "totalPaisa": 50000,
    "monthTotals": [
      {
        "month": "2026-10",
        "totalPaisa": 50000
      }
    ]
  }
  ```

#### `GET /v1/groups/:groupId/updates` (IMPLEMENTED)
- **Replaces**: `UpdatesRepository.getUpdates`
- **Auth**: Active Member | **Derivation**: Read-only (`Cache-Control: no-store`)
- **Rules**: Derived per viewer; references strictly omitted; unread status joined with `user_update_reads`. Up to 50 items.
- **Errors**: 401 `unauthenticated`, 404 `group_not_found`
- **Response 200**:
  ```json
  {
    "updates": [
      {
        "id": "pay-sub-1-verified",
        "kind": "paymentVerification",
        "title": "Payment verified",
        "body": "Your NPR 700 contribution for November 2026 was verified.",
        "createdAt": "2026-11-06T04:00:00.000Z",
        "isRead": false,
        "target": {
          "type": "payments"
        }
      }
    ]
  }
  ```

#### `POST /v1/groups/:groupId/updates/read` (IMPLEMENTED)
- **Replaces**: Client-only mark-read
- **Auth**: Active Member | **Idempotent**: Naturally idempotent via `user_update_reads`
- **Request**:
  ```json
  {
    "ids": ["pay-sub-1-verified"]
  }
  ```
- **Errors**: 400 `invalid_request`, 401 `unauthenticated`, 404 `group_not_found`
- **Response 200**: `{ "markedCount": 1 }`

#### `POST /v1/groups/:groupId/updates/read-all` (IMPLEMENTED)
- **Replaces**: Client-only mark-all-read
- **Auth**: Active Member | **Idempotent**: Naturally idempotent via `user_update_reads`
- **Errors**: 401 `unauthenticated`, 404 `group_not_found`
- **Response 200**: `{ "markedCount": 3 }`

#### `GET /v1/groups/:groupId/updates/unread-count` (IMPLEMENTED)
- **Replaces**: Client-only unread badge count
- **Auth**: Active Member | **Derivation**: Read-only (`Cache-Control: no-store`)
- **Errors**: 401 `unauthenticated`, 404 `group_not_found`
- **Response 200**: `{ "unreadCount": 0 }`

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
| `cannot_execute_own_request`| 403 | `lib/features/approvals/presentation/screens/approval_detail_screen.dart` | You cannot execute your own request when another treasurer exists |
| `invalid_statement_date` | 400 | `lib/features/reports/presentation/screens/reconciliation_screen.dart` | Statement date is invalid or in the future |
| `invalid_reconciliation_input`| 400 | `lib/features/reports/presentation/screens/reconciliation_screen.dart` | Please check the statement date and balance |
| `reconciliation_already_recorded`| 409 | `lib/features/reports/presentation/screens/reconciliation_screen.dart` | A reconciliation has already been recorded for this statement date |
