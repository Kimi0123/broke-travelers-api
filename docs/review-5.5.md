# Task 5.5 Review Evidence: 5.4 Cleanup, Governance Approvals & Bank Reconciliation

## 1. Decision Table: Flutter Mock vs Backend Implementation

| Feature / Rule | Flutter Source | Backend Source | Match? |
|---|---|---|---|
| Approvals roster threshold | `mock_approvals_repository.dart:242` (`members.length >= 2`) | `approvals-service.ts:80` (throws 400 `not_enough_members`) | Yes |
| Creation balance guard | `mock_approvals_repository.dart:248` (`amount <= balance`) | `approvals-service.ts:89` (throws 409 `insufficient_balance`) | Yes |
| Eligible voter snapshot | `mock_approvals_repository.dart:268` (active members excl. requester) | `approvals-service.ts:101` (active members excl. requester) | Yes |
| Quorum threshold | `approval_rules.dart:21` (`votesNeeded = ceil((n - 1) / 2)`) | `src/domain/approval-rules.ts:10` (`votesNeeded`) | Yes |
| Early rejection | `approval_rules.dart:7` (`rejected > eligible - votesNeeded`) | `src/domain/approval-rules.ts:18` (`resolveOpenStatus`) | Yes |
| Expiry window | `mock_approvals_repository.dart:82` (7 days at 23:59:59 NPT) | `approvals-service.ts:34` (`evalApprovalStatus`, 7 days NPT) | Yes |
| Cancellation | `mock_approvals_repository.dart:352` (requester only, while open) | `approvals-service.ts:251` (requester only, while open) | Yes |
| Separation of duties | `mock_approvals_repository.dart:397` (requester != executor if multi-treasurer) | `approvals-service.ts:316` (403 `cannot_execute_own_request`) | Yes |
| Execution parameters | `mock_approvals_repository.dart:408` (amount/title/payee from request) | `approvals-service.ts:343` (stored request attributes only) | Yes |
| Statement date validation | `mock_reconciliation_repository.dart:118` (past/today only) | `reconciliation-service.ts:31` (NPT today or past; 400) | Yes |
| Balance as-of cutoff | `mock_reconciliation_repository.dart:129` (`date 23:59:59.999 NPT`) | `reconciliation-service.ts:46` (NPT end-of-day boundary) | Yes |
| Difference calculation | `mock_reconciliation_repository.dart:141` (`bank - recorded`) | `reconciliation-service.ts:168` (`bank - recorded`) | Yes |
| Statement date uniqueness | `mock_reconciliation_repository.dart:123` (1 per date) | `reconciliation-service.ts:153` (409 `reconciliation_already_recorded`) | Yes |

## 2. Doc-vs-Flutter Disagreements

No semantic disagreements between Flutter code and backend implementation. The informal error names in roadmap drafts (`voting_closed`, `requester_cannot_vote`, `not_approved`, `request_not_open`, `reconciliation_already_exists`) were harmonized to Flutter's concrete domain exceptions (`approval_not_open`, `cannot_vote_on_own_request`, `approval_not_approved`, `reconciliation_already_recorded`) and documented in `docs/api-contract.md`.

## 3. Direct Withdrawal Question

**Answer**: In the Flutter mock repository (`mock_transactions_repository.dart:192`), recording calls `isRecordableKind(kind)` (`lib/features/transactions/domain/transaction_validators.dart:32`), which returns `true` **strictly** for `expense` and `interest`. Withdrawals can NEVER be recorded directly by treasurers. All withdrawals must proceed through the multi-member Approvals lifecycle. The backend implementation in `src/domain/transaction-validators.ts:34` and `src/application/transactions-service.ts:107` enforces the exact same rule (direct withdrawal returns 400 `invalid_transaction_input`).

## 4. Endpoint -> Test Table

| Endpoint | Test File | Test Cases |
|---|---|---|
| `POST /v1/groups/:id/approvals` | `test/integration/approvals.test.ts` | exact keys leak check, create validations, Parity Scenarios (a), (b), (c) |
| `GET /v1/groups/:id/approvals` | `test/integration/approvals.test.ts` | exact keys, status/kind filters, keyset pagination, Parity Scenarios (a), (b), (c) |
| `GET /v1/groups/:id/approvals/:reqId`| `test/integration/approvals.test.ts` | exact keys, voter details, dynamic status derivation, Parity Scenarios (a), (b), (c) |
| `POST /v1/groups/:id/approvals/:reqId/vote` | `test/integration/approvals.test.ts` | voter eligibility, duplicate vote rejection, early rejection, Parity Scenarios (a), (b), (c) |
| `POST /v1/groups/:id/approvals/:reqId/cancel`| `test/integration/approvals.test.ts` | requester gate (403 for non-requester), dynamic open guard (409), status transition |
| `POST /v1/groups/:id/approvals/:reqId/execute`| `test/integration/approvals.test.ts` | treasurer role gate, separation of duties, live balance guard, Parity Scenarios (a), (c) |
| `GET /v1/groups/:id/reconciliations` | `test/integration/reconciliations.test.ts`| exact keys, non-treasurer read allowed, ordering by date DESC |
| `GET /v1/groups/:id/reconciliations/recorded-balance` | `test/integration/reconciliations.test.ts`| NPT end-of-day boundary calculation, future date rejection |
| `POST /v1/groups/:id/reconciliations` | `test/integration/reconciliations.test.ts`| non-treasurer rejection (403), duplicate date rejection (409), server-only difference calc |

## 5. Security Checks

- **Raw Reference Grep**: Verified response schemas strictly omit raw payment references. The only endpoint emitting raw references is `GET /v1/groups/:groupId/payments/pending` for treasurers. All public and member endpoints return `maskPaymentReference` (`ESW-***-12345` or `Ref ••••3456`).
- **404 Uniformity**: Non-members and unknown groups querying `/approvals` or `/reconciliations` receive byte-identical HTTP 404 `group_not_found` responses (`test/integration/approvals.test.ts:167`).
- **No Request Body Logging**: Pino HTTP logger configuration excludes `req.body`, authorization tokens, and payment references (`src/http/app.ts:24`).
- **Integer-Only Money**: Verified by zero matches for floating point arithmetic in domain and persistence logic (`signedPaisa`, `Paisa` type enforces integer paisa).

## 6. Parity Scenarios

- **Scenario (a) `approvals_e2e_test.dart`**: 6-member group with NPR 7,300 balance; Member B requests NPR 2,000 withdrawal; 3 approvals reach threshold; Ram is rejected with 409; Owner executes with Cash; verified balance drops to NPR 5,300 (`approvals.test.ts:210`).
- **Scenario (b) `approvals_e2e_test.dart`**: Rejection path; Sita requests NPR 500 expense; Ram and Hari reject -> early rejection triggers `rejected` status; execution is impossible (`approvals.test.ts:276`).
- **Scenario (c) `approvals_e2e_test.dart`**: Separation of duties; B made treasurer; B requests NPR 100 withdrawal; B cannot execute own request while Owner is treasurer (403 `cannot_execute_own_request`); Owner executes successfully (`approvals.test.ts:318`).
- **Scenario (d) Expiry & Cancellation**: Open request expires after 7 days; requester can cancel while open; cancelled/expired requests reject further votes (`approvals.test.ts:412`).
- **Scenario (e) `reports_e2e_test.dart`**: Bank reconciliation at October 31 statement date derives NPR 7,300 recorded balance; difference is 0; second reconciliation at October 26 records NPR -200 difference; ledger remains immutable (`reconciliations.test.ts:300`).

## 7. Open Questions / Deferred Items

- Dashboard summary (`GET /v1/groups/:groupId/dashboard` / `summary`), aggregated reports (`GET /v1/groups/:groupId/reports/*`), and per-viewer updates feed (`GET /v1/groups/:groupId/updates`) are deferred to Task 5.6.
