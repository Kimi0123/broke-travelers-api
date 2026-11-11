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
5. **Invitation Joining**: Users join via single-use 8-character invitation codes (`[2-9A-HJ-NP-Z]`). Joining assigns `GroupRole.member`. Code expires in 7 days.
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
1. **Calendar Periods**: Periods align to calendar months (`YYYY-MM`). Period start is midnight on the 1st day of the month.
   - *Source*: `lib/core/mock/month_math.dart: monthStart`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
2. **Due Date Clamping**: The payment due date is constructed from `group.dueDay` clamped to the last valid day of the month (e.g. 28/29 in Feb, 30 in Apr), preventing date rollover into the next month.
   - *Source*: `lib/shared/utils/calendar_date_utils.dart: dueDateFor:46`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
3. **Obligation Derivation**: A member's period obligation status is derived by inspecting all contribution submissions for that period sorted by `occurredAt` descending (latest submission wins):
   - Latest submission `verified` -> `PaymentStatus.verified`.
   - Latest submission `pendingVerification` -> `PaymentStatus.pendingVerification`.
   - Latest submission `rejected` -> `PaymentStatus.rejected`.
   - No submission: if `periodStart < anchorPeriodStart` -> `PaymentStatus.overdue`, else `PaymentStatus.notSubmitted`.
   - *Source*: `lib/core/mock/obligation_status.dart: deriveObligationStatus:14`.
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
6. **Masked References**: Unprivileged viewers (and the submitter in payment lists) only see masked references (e.g. `Ref ••••3456`). Full references are visible only to Treasurers in pending review queues. Updates/notifications never expose references.
   - *Source*: `lib/features/payments/presentation/screens/my_payments_screen.dart:85`, `mock_updates_repository_test.dart:265`.
   - *Status*: `ENFORCED_IN_APP_ONLY` (masking) & `ENFORCED_IN_MOCK_REPOSITORY` (updates privacy).

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
5. **Reversals**: Reversals are supported exclusively for verified `expense` and `interest` entries. A reversal creates a separate linked entry (`reversesEntryId: original.id`) with inverted sign. Reversals cannot be reversed; an entry cannot be reversed twice. Original entries are never altered.
   - *Source*: `lib/features/transactions/data/repositories/mock_transactions_repository.dart: reverseTransaction:235`.
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
1. **Eligible Voter Snapshot**: Voters are snapshotted at creation time from active roster members, strictly excluding the requester. Requires at least 2 active members.
   - *Source*: `lib/features/approvals/data/repositories/mock_approvals_repository.dart: createApproval:242, 268`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
2. **Approval Kinds**: Approvals apply only to `expense` and `withdrawal`. Initial amount cannot exceed verified balance at submission.
   - *Source*: `lib/features/approvals/data/repositories/mock_approvals_repository.dart: createApproval:234, 248`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
3. **Strict Majority Rule & Early Rejection**: Threshold is `eligible ~/ 2 + 1`. If approvals reach threshold -> `approved`. If remaining potential votes cannot reach threshold (`eligible - rejections < threshold`), request transitions immediately to `rejected`.
   - *Source*: `lib/features/approvals/domain/approval_rules.dart: resolveOpenStatus:5`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
4. **Expiry and Cancellation**: Open requests expire after 7 days. Requester may cancel an open request at any time.
   - *Source*: `lib/features/approvals/data/repositories/mock_approvals_repository.dart: _status:82`, `cancelApproval:352`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
5. **Approval is Not Execution**: An approved request does not move money or post to ledger. Only a Treasurer executes an approved request. The Treasurer cannot alter amount, payee, or title. Execution performs a live balance re-check before posting to the ledger.
   - *Source*: `lib/features/approvals/data/repositories/mock_approvals_repository.dart: executeApproval:380-438`, `AGENTS.md:30`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.

---

## 7. Bank Reconciliation
1. **Statement Date Constraints**: Statement date must be past or today (`<= now()`); future dates are rejected (`invalidInput`).
   - *Source*: `lib/features/reports/data/repositories/mock_reconciliation_repository.dart: recordReconciliation:118`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
2. **Date Uniqueness**: Exactly one reconciliation record per group per statement date.
   - *Source*: `lib/features/reports/data/repositories/mock_reconciliation_repository.dart: recordReconciliation:123`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
3. **Recorded Balance As Of**: Recorded balance is computed as verified balance at end of statement day (`23:59:59.999999`).
   - *Source*: `lib/core/mock/ledger_math.dart: verifiedBalancePaisa(asOf: date)`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
4. **Difference Semantics**: `difference = bankBalance - recordedBalance`. If positive, bank is higher; if negative, bank is lower.
   - *Source*: `mock_reconciliation_repository.dart:141`, `mock_updates_repository.dart:349`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
5. **No Automatic Adjustments**: Reconciliations are purely informational records; they never alter ledger entries or balances.
   - *Source*: `README.md:99`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.

---

## 8. Reports and Dashboard Derivations
1. **Dynamic Derivations**: All balances and report figures are derived from verified ledger entries and roster membership, not statically stored summary counters.
   - *Source*: `lib/features/reports/domain/report_builders.dart`, `lib/features/dashboard/data/repositories/mock_dashboard_repository.dart`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
2. **Monthly Report Alignment**: Contributions are grouped by `effectivePeriodMonth`; interest, expenses, and withdrawals are grouped by `occurredAt`. Opening and closing balances reflect cumulative verified entries as of month boundaries.
   - *Source*: `lib/features/reports/domain/report_builders.dart: buildMonthlyReport:66`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
3. **Range Validation**: Reports cannot request periods before group creation or future months (`ReportRangeException`).
   - *Source*: `lib/features/reports/data/repositories/mock_reports_repository.dart: _checkMonth:71`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.

---

## 9. Updates and Notifications Feed
1. **Per-Viewer Dynamic Derivation**: Feed items are synthesized on read per viewer, never broadcast statically.
   - *Source*: `lib/features/notifications/data/repositories/mock_updates_repository.dart: getUpdates:108`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
2. **Viewer Scope**: Items include viewer's payment status, contribution due reminders for unpaid obligated members, approval voting/lifecycle alerts, reconciliation notices, and Treasurer action queues.
   - *Source*: `mock_updates_repository.dart:129-424`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.
3. **Privacy Guarantees**: Other members' pending payment amounts, personal identifiers, and payment references (full or masked) must NEVER appear in update titles or bodies.
   - *Source*: `test/features/notifications/mock_updates_repository_test.dart:265`.
   - *Status*: `ENFORCED_IN_MOCK_REPOSITORY`.

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
| `GroupAccessException` | `lib/core/error/group_access_exception.dart` | 403 / 404 | `group_access_denied` | Group not found or access denied |
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
| `InvitationException(tooManyAttempts)` | `lib/features/group/domain/repositories/invitations_repository.dart` | 429 | `too_many_attempts` | Too many attempts. Please try again later. |
| `PaymentSubmissionException(notObligated)` | `lib/features/payments/domain/payment_submission_exception.dart` | 400 | `not_obligated` | You are not obligated for this contribution period |
| `PaymentSubmissionException(periodNotOpen)` | `lib/features/payments/domain/payment_submission_exception.dart` | 400 | `period_not_open` | This contribution period is not open |
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
| `ApprovalException(notEnoughMembers)` | `lib/features/approvals/domain/approval_exception.dart` | 400 | `not_enough_members` | At least two active members are required for an approval request |
| `ApprovalException(notFound)` | `lib/features/approvals/domain/approval_exception.dart` | 404 | `approval_not_found` | Approval request not found |
| `ApprovalException(notOpen)` | `lib/features/approvals/domain/approval_exception.dart` | 409 | `approval_not_open` | Approval request is closed or expired |
| `ApprovalException(notApproved)` | `lib/features/approvals/domain/approval_exception.dart` | 409 | `approval_not_approved` | Request has not reached approval threshold |
| `ApprovalException(alreadyVoted)` | `lib/features/approvals/domain/approval_exception.dart` | 409 | `already_voted` | You have already voted on this request |
| `ApprovalException(notEligible)` | `lib/features/approvals/domain/approval_exception.dart` | 403 | `not_eligible_to_vote` | You are not eligible to vote on this request |
| `ApprovalException(ownRequest)` | `lib/features/approvals/domain/approval_exception.dart` | 403 | `cannot_vote_on_own_request` | You cannot vote on your own request |
| `ApprovalException(alreadyExecuted)` | `lib/features/approvals/domain/approval_exception.dart` | 409 | `approval_already_executed` | This approval request has already been recorded |
| `ReconciliationException(invalidInput)` | `lib/features/reports/domain/reconciliation.dart` | 400 | `invalid_reconciliation_input` | Statement date, balance, or note is invalid |
| `ReconciliationException(alreadyRecorded)` | `lib/features/reports/domain/reconciliation.dart` | 409 | `reconciliation_already_recorded` | A reconciliation has already been recorded for this statement date |

---

## Gaps and Ambiguities
1. **FIN-1 (Ledger Status Mutation)**: The Flutter mock mutates `MockLedgerEntry.status` in-place on payment review and stores pending submissions in `group.entries`. The backend resolves this by maintaining a separate `payment_submissions` table; verified reviews insert an immutable ledger entry in the same transaction.
2. **FIN-2 (Obligation Status Derivation Divergence)**: Audit found `report_builders.dart` had previously diverged from `deriveObligationStatus`. The backend standardizes on a single canonical SQL/domain query ordering submissions by `occurredAt DESC`.
3. **FIN-3 (Idempotency Key Scope and Expiry)**: Mock repositories lack idempotency keys. The backend enforces `Idempotency-Key` headers on all financial POSTs, keyed by `(group_id, actor_user_id, operation, idempotency_key)` with a 48-hour retention window.
4. **FIN-4 (Cumulative Balance Summation Loops)**: Mock repositories duplicate balance summation loops in 4 places. In the backend, balance calculation is unified in a single database function/query.
5. **FIN-5 (Audit Timestamp Backdating)**: Mock `postVerifiedEntry` previously logged client `occurredAt` as audit time. Backend audit logs strictly record the server database timestamp (`NOW()`).
6. **FIN-6 (Due Day Month Overflow)**: `dueDay > 28` is clamped to the last day of each month in `dueDateFor`. The backend enforces this identical clamping logic when computing period due dates.
7. **FIN-7 & Timezone Normalization (FIN-8)**: Nepal Standard Time is UTC+05:45 without Daylight Saving Time. The server stores all timestamps in UTC ISO-8601, but interprets calendar day boundaries (`asOf` end-of-day, period months, and due dates) in NPT (+05:45).
8. **Multi-Group Membership vs Single-Group Mock**: Mock `MockGroupStore` maps one group per user (`membershipByUserId`). In PostgreSQL, a user may belong to multiple groups; every request must supply `groupId` in the URL path.
9. **Re-Invited Members and Identity**: If a removed member rejoins with an invitation, a new membership record is created. Their previous contributions retain the original member record linkage.
10. **Masked Reference Format**: When a reference is shorter than 4 characters, mock formatting falls back to masking all characters; the backend emits standard last-4 masking `••••1234` or `••••` if <= 4 chars.
