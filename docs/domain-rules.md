# Domain Rules Extracted from Flutter Client

Authoritative specification of business and financial rules extracted from the Broke Travelers Flutter codebase (`../broke_travelers`).

Every rule cites its source file and symbol in the Flutter codebase and indicates enforcement status:
- `ENFORCED_IN_MOCK_REPOSITORY`: Enforced in the mock repository/store domain logic.
- `ENFORCED_IN_APP_ONLY`: Enforced only in client UI / forms / widgets.
- `NOT_ENFORCED_YET`: Identified in audits (FIN-1..FIN-8) or planned for backend enforcement.

---

## 1. Money Representation and Operations
1. **Integer Paisa**: All currency is denominated in integer paisa (1 NPR = 100 paisa). `double` and floating-point types are strictly prohibited in domain arithmetic and storage.
   - *Source*: `lib/shared/models/money.dart: Money.paisa`, `AGENTS.md:27`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
2. **Client-Side Formatting**: Currency formatting (e.g. `"NPR 700"`, lakh grouping `en_IN`) is display-only and performed exclusively by the client. The API always consumes and emits integer paisa.
   - *Source*: `lib/shared/models/money.dart: Money.formatted`, `Money.formattedSigned`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
3. **Transaction Range Limits**: Amounts must be positive (`> 0`) and cannot exceed `10,000,000` NPR (`1,000,000,000` paisa).
   - *Source*: `lib/features/transactions/data/repositories/mock_transactions_repository.dart: recordTransaction:194`, `lib/features/approvals/data/repositories/mock_approvals_repository.dart: createApproval:236`, `lib/shared/models/money_parser.dart: parseRupeesInput:21`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY` & `ENFORCED_IN_APP_ONLY`.
4. **Sign Convention**: Magnitude is always stored positive. Net ledger balance effect is determined by activity kind (`ActivityKind.isOutflow`) and reversed flag (`reversesEntryId != null`).
   - *Source*: `lib/core/mock/ledger_math.dart: signedPaisa`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.

---

## 2. Groups, Membership, and Roles
1. **Roles**: Group members have roles from `GroupRole`: `owner`, `treasurer`, `member`.
   - *Source*: `lib/shared/enums/group_role.dart: GroupRole`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
2. **Creator Roles**: Group creator is automatically granted `{GroupRole.owner, GroupRole.treasurer}`.
   - *Source*: `lib/features/group/data/repositories/mock_groups_repository.dart: createGroup:86`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
3. **Owner Authority**: Only an Owner may update group settings (name, dueDay), create invitations, revoke invitations, assign/revoke Treasurer roles, or remove members.
   - *Source*: `lib/features/group/data/repositories/mock_groups_repository.dart: updateGroupSettings:125`, `mock_invitations_repository.dart: _requireOwner:43`, `mock_members_repository.dart: _authorize:43`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
4. **Immutable Contribution Schedule**: Monthly expected contribution cannot be edited directly via settings until an effective-from schedule is implemented, preventing retroactive changes to historical obligations.
   - *Source*: `README.md:75`, `AGENTS.md:43`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
5. **Invitation Joining & Rejoining**: Users join via single-use 8-character invitation codes (`[2-9A-HJ-NP-Z]`). Joining assigns `GroupRole.member`. Code expires in 7 days. If a former member rejoins, a NEW membership record is created; historical ledger entries retain their original membership ID.
   - *Source*: `lib/features/group/data/repositories/mock_invitations_repository.dart: acceptInvitation:168`, `invitation_code.dart`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
6. **Invitation Brute-Force Lockout**: 5 failed invitation attempts within 5 minutes locks out the user (`InvitationErrorCode.tooManyAttempts`).
   - *Source*: `lib/features/group/data/repositories/mock_invitations_repository.dart: _lockedOut:148`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
7. **Soft Removal**: Member removal is soft via timestamp (`leftAt`). Removed members lose access to group endpoints and updates feed, but their recorded payments and audit history remain immutable.
   - *Source*: `lib/features/members/data/repositories/mock_members_repository.dart: removeMember:189`, `AGENTS.md:44`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
8. **Removal Invariants**: A member cannot be removed if: (a) they are the Owner (`isOwner`), (b) they have pending payments (`pendingPayments`), or (c) they are the last active Treasurer (`lastTreasurer`).
   - *Source*: `lib/features/members/data/repositories/mock_members_repository.dart: removeMember:166-184`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
9. **Last Treasurer Protection**: The Treasurer role cannot be removed from a member if they are the only remaining active Treasurer.
   - *Source*: `lib/features/members/data/repositories/mock_members_repository.dart: setTreasurerRole:130`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
10. **Separation of Duties (Sole vs Multiple Treasurers)**: If a sole Treasurer exists, self-review of payment submissions and self-execution of approved requests is permitted. If multiple Treasurers exist, a Treasurer cannot review their own payment submission or execute their own approved request.
    - *Source*: `lib/features/payments/data/repositories/mock_payments_repository.dart: _ensureCanReviewOwnSubmission:130`, `lib/features/approvals/data/repositories/mock_approvals_repository.dart: executeApproval:397`.
    - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.

---

## 3. Contribution Periods and Obligations
1. **Calendar Periods**: Periods align to calendar months (`YYYY-MM`). Period start is midnight on the 1st day of the month in Nepal Standard Time (UTC+05:45).
   - *Source*: `lib/core/mock/month_math.dart: monthStart`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
2. **Due Date Clamping**: The payment due date is constructed from `group.dueDay` clamped to the last valid day of the month (e.g. 28/29 in Feb, 30 in Apr), preventing date rollover into the next month.
   - *Source*: `lib/shared/utils/calendar_date_utils.dart: dueDateFor:46`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
3. **Obligation Derivation & Tie-Breaking**: A member's period obligation status is derived by inspecting all contribution submissions for that period sorted by occurrence time descending (`second.occurredAt.compareTo(first.occurredAt)`), using list insertion index descending (`entryIndexes[second.id]!.compareTo(entryIndexes[first.id]!)`) as a tie-breaker. The first/latest submission determines the status:
   - Latest submission `verified` -> `PaymentStatus.verified`.
   - Latest submission `pendingVerification` -> `PaymentStatus.pendingVerification`.
   - Latest submission `rejected` -> `PaymentStatus.rejected`.
   - No submission: if `periodStart < anchorPeriodStart` -> `PaymentStatus.overdue`, else `PaymentStatus.notSubmitted`.
   - In the database schema, this ordering maps to `submitted_at DESC, id DESC`.
   - *Source*: `lib/core/mock/obligation_status.dart: deriveObligationStatus:14-45`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
4. **Historical Obligations of Removed Members**: Members are obligated for past periods where `member.joinedAt < periodEnd` and `(member.leftAt == null || !member.leftAt!.isBefore(periodEnd))`.
   - *Source*: `lib/features/contributions/data/repositories/mock_contributions_repository.dart: _obligations:99`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.

---

## 4. Payment Submissions and Verification
1. **Server-Derived Amount**: When submitting a payment, the member never provides the amount; the server sets `amount = group.expectedPaisa`.
   - *Source*: `lib/features/payments/data/repositories/mock_payments_repository.dart: submitPayment:365`, `AGENTS.md:46`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
2. **Open Period Requirement**: Payments can only be submitted for existing, open periods (from group creation month through current anchor month) for which the member is obligated.
   - *Source*: `lib/features/payments/data/repositories/mock_payments_repository.dart: submitPayment:313, 319`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
3. **Single Active Submission**: A member cannot submit a payment if their current obligation status for that period is already `verified` or `pendingVerification`.
   - *Source*: `lib/features/payments/data/repositories/mock_payments_repository.dart: submitPayment:333`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
4. **Reference Normalization & Uniqueness**: References are trimmed, converted to uppercase, and stripped of whitespace and hyphens. A reference cannot be reused for the same group and payment method if an active (`pendingVerification` or `verified`) submission already uses it.
   - *Source*: `lib/features/payments/domain/payment_reference.dart: normalizePaymentReference`, `mock_payments_repository.dart: _hasActiveDuplicateReference:269`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
5. **Treasurer Verification**: Only a Treasurer may verify or reject pending payments. Verification creates a verified ledger entry; rejection requires a reason (`notReceived`, `wrongAmount`, `referenceNotFound`, `other`) and optional note (<= 200 chars), allowing resubmission.
   - *Source*: `lib/features/payments/data/repositories/mock_payments_repository.dart: verifyPayment:513`, `rejectPayment:537`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
6. **Masked References**: Unprivileged viewers (and the submitter in payment lists) see references formatted via `maskPaymentReference`: for references longer than 4 characters, it returns `'Ref ••••'` followed by the last 4 characters (e.g. `'Ref ••••3456'`); for references of 4 characters or fewer (e.g. `"12"`, `"1234"`), it is masked completely to `'Ref ••••'` to prevent leaking short reference IDs. Full references are visible only to Treasurers in pending review queues and member detail contribution histories. Updates/notifications never expose references.
   - *Source*: `src/domain/reference-masking.ts`, `lib/features/payments/presentation/screens/my_payments_screen.dart:85`, `mock_updates_repository_test.dart:265`.
   - *Status*: `ENFORCED_IN_BACKEND` (server masks references on read models) & `ENFORCED_IN_APP_ONLY` (legacy UI expression) & `ENFORCED_IN_MOCK_REPOSITORY` (updates privacy).

---

## 5. Immutable Ledger and Financial Invariants
1. **Activity Kinds**: Ledger entries belong to `ActivityKind`: `contribution`, `interest`, `expense`, `withdrawal`.
   - *Source*: `lib/shared/enums/activity_kind.dart: ActivityKind`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
2. **Verified Balance Formula**: The verified balance is the cumulative sum of `signedPaisa` for entries with `status == PaymentStatus.verified`. Pending and rejected entries NEVER affect verified balance.
   - *Source*: `lib/core/mock/ledger_math.dart: verifiedBalancePaisa:23`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
3. **Posting Balance Guard**: No ledger entry may be posted if `current_balance + effect < 0`. Throws `LedgerPostingException(insufficientBalance)`.
   - *Source*: `lib/core/mock/ledger_posting.dart: postVerifiedEntry:42`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
4. **Append-Only Immutability**: Posted ledger entries are never modified (`UPDATE`) or deleted (`DELETE`).
   - *Source*: `AGENTS.md:28`, `README.md:38`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
5. **Reversals Restricted to Expense and Interest**: Reversals are supported exclusively for verified `expense` and `interest` entries (`mock_transactions_repository.dart:257-263`). `withdrawal` and `contribution` entries CANNOT be reversed (reversal attempts throw `notReversible`). A reversal creates a separate linked entry (`reversesEntryId: original.id`) with inverted sign. Reversals cannot be reversed; an entry cannot be reversed twice.
   - *Source*: `lib/features/transactions/data/repositories/mock_transactions_repository.dart: reverseTransaction:235-263`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
6. **Direct Transaction Kinds**: Treasurers may directly record only `interest` and `expense` entries. `withdrawal` cannot be recorded directly and must proceed through Approvals.
   - *Source*: `lib/features/transactions/domain/transaction_validators.dart: isRecordableKind:32`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
7. **Transaction Date Window**: Transaction `occurredAt` cannot be in the future or older than 366 days past.
   - *Source*: `lib/features/transactions/data/repositories/mock_transactions_repository.dart: recordTransaction:197`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
8. **Real Wall-Clock Audit Timestamps (FIN-5)**: Audit logs must record real wall-clock execution time (`postedAt = now()`), never backdated `occurredAt`.
   - *Source*: `lib/core/mock/ledger_posting.dart: postVerifiedEntry:91`, `docs/financial-audit.md:85`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.

---

## 6. Approvals Workflow
1. **Eligible Voter Snapshot**: Voters are snapshotted at creation time from active roster members (`leftAt == null`), strictly excluding the requester. Requires at least 2 active members (`notEnoughMembers` / 400 `not_enough_members`).
   - *Source*: `lib/features/approvals/data/repositories/mock_approvals_repository.dart: createApproval:242, 268`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
2. **Approval Kinds & Initial Balance Check**: Approvals apply only to `expense` and `withdrawal`. Initial amount cannot exceed current verified balance at creation (`insufficientBalance` / 409 `insufficient_balance`). Max limit is 1,000,000,000 paisa (10M NPR).
   - *Source*: `lib/features/approvals/data/repositories/mock_approvals_repository.dart: createApproval:234, 248`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
3. **Strict Majority Quorum & Early Rejection**: Threshold is `votesNeeded = ceil((activeMembers - 1) / 2)`. If approvals reach `votesNeeded` -> status transitions immediately to `approved`. Early rejection rule: if `rejectedCount > eligibleCount - votesNeeded` (i.e. remaining potential votes cannot reach threshold even if all remaining voters approve), request transitions immediately to `rejected`.
   - *Source*: `lib/features/approvals/domain/approval_rules.dart: resolveOpenStatus:5`, `approval_rules.dart: votesNeeded`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
4. **Expiry and Cancellation**: Open requests expire after 7 calendar days at 23:59:59.999 NPT. Dynamic status evaluates to `expired` if still open after expiry cutoff. Requester only may cancel an open request (403 `forbidden` for others); transitions to `cancelled`. Terminal states are `executed`, `cancelled`, `rejected`, and `expired`.
   - *Source*: `lib/features/approvals/data/repositories/mock_approvals_repository.dart: _status:82`, `cancelApproval:352`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
5. **Approval is Not Execution & Live Balance Guard**: An approved request does not move money or post to the ledger. Only a Treasurer executes an approved request. All financial fields (`amountPaisa`, `title`, `payee`, `kind`, `memberId`) are strictly populated from the stored approval request; the client provides only `paymentMethod` and optional `reference`. Execution performs a live verified balance re-check before posting to the ledger.
   - *Source*: `lib/features/approvals/data/repositories/mock_approvals_repository.dart: executeApproval:380-438`, `AGENTS.md:30`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
6. **Separation of Duties (Execution)**: If another active treasurer exists on the group roster, the requester cannot execute their own approved request (403 `cannot_execute_own_request`). A sole treasurer is permitted to execute their own request.
   - *Source*: `lib/features/approvals/data/repositories/mock_approvals_repository.dart: executeApproval:397`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.

---

## 7. Bank Reconciliation
1. **Statement Date Constraints**: Statement date must be in NPT wall clock (today or earlier: `<= now()`); future dates are strictly rejected (`invalid_statement_date` / 400). Format must be `YYYY-MM-DD`.
   - *Source*: `lib/features/reports/data/repositories/mock_reconciliation_repository.dart: recordReconciliation:118`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
2. **Date Uniqueness**: Exactly one reconciliation record per group per statement date (409 `reconciliation_already_recorded`).
   - *Source*: `lib/features/reports/data/repositories/mock_reconciliation_repository.dart: recordReconciliation:123`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
3. **Recorded Balance As Of (NPT End-of-Day Cutoff)**: Recorded balance is derived strictly server-side as the sum of `signedPaisa` of all verified ledger entries posted on or before `statementDate 23:59:59.999 NPT` (converted to UTC timestamp boundary).
   - *Source*: `lib/core/mock/ledger_math.dart: verifiedBalancePaisa(asOf: date)`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
4. **Difference Semantics**: `difference = bankBalance - recordedBalance`. If positive, bank is higher; if negative, bank is lower. Any client-sent values for `recordedBalancePaisa` or `differencePaisa` are ignored/rejected.
   - *Source*: `mock_reconciliation_repository.dart:141`, `mock_updates_repository.dart:349`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
5. **No Automatic Adjustments & Immutable Audit**: Reconciliations are purely informational records; they never alter ledger entries or balances. Recording a reconciliation creates an append-only audit log entry (`reconciliation.recorded`).
   - *Source*: `README.md:99`, `mock_reconciliation_repository.dart:145`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.

---

## 8. Reports and Dashboard Derivations
1. **Dynamic Derivations**: All balances and report figures are derived from verified ledger entries and roster membership, not statically stored summary counters. Derivations execute in a single `REPEATABLE READ` snapshot to prevent mid-read tearing across collections.
   - *Source*: `lib/features/reports/domain/report_builders.dart`, `lib/features/dashboard/data/repositories/mock_dashboard_repository.dart`.
   - *Status*: `ENFORCED_IN_POSTGRES_READ_MODEL`.
2. **Monthly Report Alignment**: Contributions are grouped by `effectivePeriodMonth`; interest, expenses, and withdrawals are grouped by `occurredAt`. Opening and closing balances reflect cumulative verified entries as of month boundaries.
   - *Source*: `lib/features/reports/domain/report_builders.dart: buildMonthlyReport:66`.
   - *Status*: `ENFORCED_IN_POSTGRES_READ_MODEL`.
3. **Range Validation**: Reports cannot request periods before group creation or future months (`report_range_invalid` / `ReportRangeException`).
   - *Source*: `lib/features/reports/data/repositories/mock_reports_repository.dart: _checkMonth:71`.
   - *Status*: `ENFORCED_IN_POSTGRES_READ_MODEL`.
4. **Reversal Netting**: In outflow reports (expenses and withdrawals), reversals are netted in `totalPaisa` and `monthTotals`, while individual rows maintain `isReversed` and `isReversal` lineage flags.
   - *Source*: `lib/features/reports/domain/report_builders.dart: buildOutflowReport:379`.
   - *Status*: `ENFORCED_IN_POSTGRES_READ_MODEL`.
5. **Dashboard Privacy**: Plain members see only their own unverified `pendingAmountPaisa` (0 if none pending). Treasurers and owners see group-wide unverified pending totals. Other members' pending amounts are never leaked.
   - *Source*: `lib/features/dashboard/data/repositories/mock_dashboard_repository.dart`.
   - *Status*: `ENFORCED_IN_POSTGRES_READ_MODEL`.
6. **Member Report Privacy**: In `GET /reports/members`, plain members see their own pending amount, while other members' pending amounts are masked to 0. The totals summary row equals the displayed sum for that viewer.
   - *Source*: `lib/features/reports/domain/report_builders.dart: buildMemberReport`.
   - *Status*: `ENFORCED_IN_POSTGRES_READ_MODEL`.

---

## 9. Updates and Notifications Feed
1. **Per-Viewer Dynamic Derivation**: Feed items are synthesized on read per viewer, never broadcast statically or written to an updates table.
   - *Source*: `lib/features/notifications/data/repositories/mock_updates_repository.dart: getUpdates:108`.
   - *Status*: `ENFORCED_IN_POSTGRES_READ_MODEL`.
2. **Viewer Scope**: Items include viewer's payment status, contribution due reminders for unpaid obligated members, approval voting/lifecycle alerts, reconciliation notices, and Treasurer action queues.
   - *Source*: `mock_updates_repository.dart:129-424`.
   - *Status*: `ENFORCED_IN_POSTGRES_READ_MODEL`.
3. **Privacy Guarantees**: Other members' pending payment amounts, personal identifiers, and payment references (full or masked) must NEVER appear in update titles or bodies.
   - *Source*: `test/features/notifications/mock_updates_repository_test.dart:265`.
   - *Status*: `ENFORCED_IN_POSTGRES_READ_MODEL`.
4. **Read State Persistence**: Read state is persisted per user and per group in `user_update_reads` (composite primary key `[userId, groupId, feedItemId]`). Marking as read is idempotent via `skipDuplicates`. Unread counts are computed dynamically by comparing derived feed items with the user's read set.
   - *Source*: `lib/features/notifications/data/repositories/mock_updates_repository.dart: markRead:429`.
   - *Status*: `ENFORCED_IN_POSTGRES_READ_MODEL`.

---

## 10. Audit Log
1. **Logged Operations**: Append-only log of configuration and financial actions: `update` (group name/dueDay), `member.role.treasurer.added/removed`, `member.removed`, `payment.submitted`, `payment.verified(.self)`, `payment.rejected(.self)`, `transaction.recorded`, `transaction.reversed`, `approval.created/voted/decided/cancelled/executed`.
   - *Source*: `MockAuditEntry`, `ledger_posting.dart:83`, feature repositories.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
2. **Required Fields**: `id`, `groupId`, `actorUserId`, `action`, `field`, `before`, `after`, `at`.
   - *Source*: `lib/core/mock/mock_group_store.dart: MockAuditEntry:121`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.

---

## 11. Error Taxonomy
| Exception Symbol | Source File | HTTP Status | Machine Code | Fixed User-Visible Message |
|---|---|---|---|---|
| `GroupAccessException` | `lib/core/error/group_access_exception.dart` | 403 / 404 | `group_access_denied` / `group_not_found` | Group not found or access denied |
| `PermissionDeniedException` | `lib/core/error/permission_denied_exception.dart` | 403 | `forbidden` | You do not have permission to perform this action |
| `GroupCreationException` | `lib/core/error/group_creation_exception.dart` | 409 | `group_creation_failed` | Unable to create group for this user |
| `GroupValidationException` | `lib/core/error/group_validation_exception.dart` | 400 | `invalid_group_settings` | Group name or due day failed validation |
| `MemberRemovalBlockedException(isOwner)` | `lib/core/error/member_removal_blocked_exception.dart` | 409 | `cannot_remove_owner` | The group owner cannot be removed |
| `MemberRemovalBlockedException(pendingPayments)` | `lib/core/error/member_removal_blocked_exception.dart` | 409 | `member_has_pending_payments` | Cannot remove member with pending payments |
| `MemberRemovalBlockedException(lastTreasurer)` | `lib/core/error/member_removal_blocked_exception.dart` | 409 | `cannot_remove_last_treasurer` | Cannot remove the group's only treasurer |
| `LedgerPostingException(insufficientBalance)` | `lib/core/error/ledger_posting_exception.dart` | 409 | `insufficient_balance` | Insufficient verified balance to record transaction |
| `ReportRangeException` | `lib/core/error/report_range_exception.dart` | 400 | `report_range_invalid` | Requested report period is outside the group's history |
| `AuthException(invalidCredentials)` | `lib/features/authentication/domain/auth_exception.dart` | 401 | `invalid_credentials` | Invalid email or password |
| `AuthException(emailAlreadyInUse)` | `lib/features/authentication/domain/auth_exception.dart` | 409 | `email_already_in_use` | An account with this email already exists |
| `AuthException(weakPassword)` | `lib/features/authentication/domain/auth_exception.dart` | 400 | `weak_password` | Password does not meet security requirements |
| `InvitationException(invalidCode)` | `lib/features/group/domain/repositories/invitations_repository.dart` | 400 | `invalid_invitation_code` | Invitation code is invalid or expired |
| `InvitationException(alreadyInGroup)` | `lib/features/group/domain/repositories/invitations_repository.dart` | 409 | `already_in_group` | You are already a member of a group |
| `InvitationException(tooManyAttempts)` | `lib/features/group/domain/repositories/invitations_repository.dart` | 429 | `too_many_attempts` | Too many attempts; please try again later |
| `PaymentSubmissionException(notObligated)` | `lib/features/payments/domain/payment_submission_exception.dart` | 400 | `not_obligated` | You are not obligated for this period |
| `PaymentSubmissionException(periodNotOpen)` | `lib/features/payments/domain/payment_submission_exception.dart` | 400 | `period_not_open` | This period is not open for submission |
| `PaymentSubmissionException(alreadySubmitted)` | `lib/features/payments/domain/payment_submission_exception.dart` | 409 | `already_submitted` | Payment already submitted for this period |
| `PaymentSubmissionException(duplicateReference)` | `lib/features/payments/domain/payment_submission_exception.dart` | 409 | `duplicate_reference` | A payment with this reference is already recorded |
| `PaymentSubmissionException(invalidInput)` | `lib/features/payments/domain/payment_submission_exception.dart` | 400 | `invalid_payment_input` | Payment details failed validation |
| `PaymentReviewException(notFound)` | `lib/features/payments/domain/payment_review_exception.dart` | 404 | `submission_not_found` | Payment submission not found |
| `PaymentReviewException(alreadyReviewed)` | `lib/features/payments/domain/payment_review_exception.dart` | 409 | `already_reviewed` | Payment has already been reviewed |
| `PaymentReviewException(ownSubmission)` | `lib/features/payments/domain/payment_review_exception.dart` | 403 | `cannot_review_own_payment` | You cannot verify your own payment when another treasurer exists |
| `PaymentReviewException(invalidInput)` | `lib/features/payments/domain/payment_review_exception.dart` | 400 | `invalid_review_input` | Review rejection reason or note failed validation |
| `TransactionRecordingException(invalidInput)` | `lib/features/transactions/domain/transaction_recording_exception.dart` | 400 | `invalid_transaction_input` | Transaction input failed validation |
| `TransactionRecordingException(insufficientBalance)` | `lib/features/transactions/domain/transaction_recording_exception.dart` | 409 | `insufficient_balance` | Insufficient verified balance to record expense |
| `TransactionRecordingException(notFound)` | `lib/features/transactions/domain/transaction_recording_exception.dart` | 404 | `transaction_not_found` | Transaction not found |
| `TransactionRecordingException(notReversible)` | `lib/features/transactions/domain/transaction_recording_exception.dart` | 400 | `transaction_not_reversible` | Transaction cannot be reversed |
| `TransactionRecordingException(alreadyReversed)` | `lib/features/transactions/domain/transaction_recording_exception.dart` | 409 | `transaction_already_reversed` | Transaction has already been reversed |
| `ApprovalException(invalidInput)` | `lib/features/approvals/domain/approval_exception.dart` | 400 | `invalid_approval_input` | Approval input failed validation |
| `ApprovalException(insufficientBalance)` | `lib/features/approvals/domain/approval_exception.dart` | 409 | `insufficient_balance` | Amount exceeds verified balance |
| `ApprovalException(notEnoughMembers)` | `lib/features/approvals/domain/approval_exception.dart` | 400 | `not_enough_members` | Group needs at least two members for approvals |
| `ApprovalException(notFound)` | `lib/features/approvals/domain/approval_exception.dart` | 404 | `approval_not_found` | Approval request not found |
| `ApprovalException(notOpen)` | `lib/features/approvals/domain/approval_exception.dart` | 409 | `approval_not_open` | Approval request is closed or expired |
| `ApprovalException(notApproved)` | `lib/features/approvals/domain/approval_exception.dart` | 409 | `approval_not_approved` | Request has not reached approval threshold |
| `ApprovalException(alreadyVoted)` | `lib/features/approvals/domain/approval_exception.dart` | 409 | `already_voted` | You have already voted on this request |
| `ApprovalException(notEligible)` | `lib/features/approvals/domain/approval_exception.dart` | 403 | `not_eligible_to_vote` | You are not eligible to vote on this request |
| `ApprovalException(ownRequest)` | `lib/features/approvals/domain/approval_exception.dart` | 403 | `cannot_vote_on_own_request` | You cannot vote on your own request |
| `ApprovalException(alreadyExecuted)` | `lib/features/approvals/domain/approval_exception.dart` | 409 | `approval_already_executed` | This approval request has already been recorded |
| `ApprovalException(ownRequest)` | `lib/features/approvals/domain/approval_exception.dart` | 403 | `cannot_execute_own_request` | You cannot execute your own request when another treasurer exists |
| `ReconciliationException(invalidInput)` | `lib/features/reports/domain/reconciliation.dart` | 400 | `invalid_statement_date` | Statement date is invalid or in the future |
| `ReconciliationException(invalidInput)` | `lib/features/reports/domain/reconciliation.dart` | 400 | `invalid_reconciliation_input` | Statement date, balance, or note is invalid |
| `ReconciliationException(alreadyRecorded)` | `lib/features/reports/domain/reconciliation.dart` | 409 | `reconciliation_already_recorded` | A reconciliation has already been recorded for this statement date |

---

## Gaps and Ambiguities
1. **FIN-1 (Ledger Status Mutation)**: The Flutter mock mutates `MockLedgerEntry.status` in-place on payment review and stores pending submissions in `group.entries`. The backend resolves this by maintaining a separate `payment_submissions` table; verified reviews insert an immutable ledger entry in the same transaction.
2. **FIN-2 (Obligation Status Derivation & Ordering Field)**: In the Flutter mock (`obligation_status.dart:36-40`), obligation derivation sorts entries by `occurredAt DESC` with list index descending as tie-break. In the backend schema, submissions are sorted by `submitted_at DESC, id DESC`. The TypeScript domain function implements this single canonical derivation.
3. **FIN-3 (Idempotency Key Scope and Expiry)**: Mock repositories lack idempotency keys. The backend enforces `Idempotency-Key` headers on all financial POSTs, keyed by `(group_id, actor_user_id, operation, idempotency_key)` (or user-scoped when `group_id IS NULL`) with a 48-hour retention window.
4. **FIN-4 (Single TypeScript Implementation for Balance)**: Rather than duplicating financial logic in SQL stored procedures or multiple cumulative loops, the backend maintains a SINGLE TypeScript implementation of `signedPaisa` and `verifiedBalancePaisa`. The server loads the group's ledger rows inside the group-locked transaction and evaluates balance in-memory. SQL `SUM` queries are reserved for monitoring/sanity checks and verified by parity tests.
5. **FIN-5 (Audit Timestamp Backdating)**: Mock `postVerifiedEntry` previously logged client `occurredAt` as audit time. Backend audit logs strictly record the server database timestamp (`NOW()`).
6. **FIN-6 (Due Day Month Overflow)**: `dueDay > 28` is clamped to the last day of each month in `dueDateFor`. The backend enforces this identical clamping logic when computing period due dates.
7. **FIN-7 & Timezone Normalization (FIN-8)**: Nepal Standard Time is UTC+05:45 without Daylight Saving Time. The server stores all timestamps in UTC ISO-8601, but interprets calendar day boundaries (`asOf` end-of-day, period months, and due dates) in NPT (+05:45).
8. **Multi-Group Membership vs Single-Group Mock**: Mock `MockGroupStore` maps one group per user (`membershipByUserId`). In PostgreSQL, a user may belong to multiple groups; every request must supply `groupId` in the URL path.
9. **Re-Invited Members and Partial Unique Index**: When a removed member rejoins with an invitation, a new `group_memberships` row is created (`joined_at = NOW()`, `left_at = NULL`). Historical payments remain linked to the old member ID. To allow rejoining while preventing concurrent active memberships, the database uses a partial unique index on `(group_id, user_id) WHERE left_at IS NULL`.
10. **Masked Reference Format**: In the Flutter app (`my_payments_screen.dart:85`), masking prepends `'Ref ••••'` and takes up to the last 4 characters (`reference.substring(reference.length > 4 ? reference.length - 4 : 0)`), which for short references (`<= 4` chars) outputs `'Ref ••••'` followed by all characters (e.g. `'Ref ••••12'`). The backend adopts a stricter privacy boundary in `src/domain/reference-masking.ts`: references of 4 characters or fewer are masked completely to `'Ref ••••'` without exposing any characters, while references of 5+ characters show `'Ref ••••'` followed by the last 4 characters.
