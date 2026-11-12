# Task 5.4 Implementation Evidence & Review Report

## 1. Decision Table

| Decision Area | Question / Rule | Flutter Reference | API Implementation | Error Code / Behavior |
|---|---|---|---|---|
| **(1) Periods: Range** | First period to anchor period | `mock_contributions_repository.dart:43-66` | `contributions-service.ts:112-142` | Contiguous months from earliest entry/creation month to current NPT month |
| **(1) Periods: Format** | Period identifier | `mock_contributions_repository.dart:68` (`_periodId`) | `contributions-service.ts:65` (`formatPeriodId`) | `YYYY-MM` (e.g. `2026-11`) |
| **(1) Periods: Obligations** | Obligated member criteria | `mock_contributions_repository.dart:102` | `contributions-service.ts:166-175` | Joined before month end and not left before month end |
| **(1) Periods: New Group** | Brand-new group / mid-year first entry | `mock_contributions_repository.dart:44` | `contributions-service.ts:118-132` | New group returns 1 period (`[anchor]`); mid-year returns months from first entry to anchor |
| **(2) Submission: Open** | Period open window | `mock_payments_repository.dart:313` | `payments-service.ts:303-308` | 400 `period_not_open` if outside earliest-to-anchor range |
| **(2) Submission: Obligation** | Obligated member check | `mock_payments_repository.dart:319` | `payments-service.ts:311-322` | 400 `not_obligated` if joined after or left before period end |
| **(2) Submission: Duplicate Sub** | Active submission blocks | `mock_payments_repository.dart:333` | `payments-service.ts:332-334` | 409 `already_submitted` for `verified` or `pendingVerification`; allows resubmit for `rejected` |
| **(2) Submission: Duplicate Ref** | Method-scoped unique reference | `mock_payments_repository.dart:348` | `payments-service.ts:368`, schema index | 409 `duplicate_reference` per `(group_id, payment_method, reference)` |
| **(2) Submission: Amount** | Amount source authority | `mock_payments_repository.dart:365` | `financial.ts:79`, `payments-service.ts:354` | Server-derived from group settings; client amounts rejected with 400 `invalid_payment_input` |
| **(2) Submission: Ref Req** | Reference required per method | `payment_reference.dart:16-36` | `src/domain/payment-reference.ts:24-44` | Cash optional; digital methods required (3-50 chars) -> 400 `invalid_payment_input` |
| **(2) Submission: Notes** | Note length limit | `payment_reference.dart:47-51` | `src/domain/payment-reference.ts:51-55` | Optional string <= 200 chars -> 400 `invalid_payment_input` |
| **(3) Visibility: MemberDetail** | Plain member vs Treasurer / Self | `mock_members_repository.dart:358-378` | `members-service.ts:230-295` | Non-treasurer viewing other member sees `pendingTotalPaisa: 0` & `paidPaisa: 0` on pending rows |
| **(3) Visibility: Transactions** | Another member's pending submission | `mock_transactions_repository.dart:28` | `activity-service.ts:55-95`, `financial.ts:144` | Exposes item with source `submission`, status `pendingVerification`, NO `reference` field |
| **(3) Visibility: My Payments** | Personal submissions list | `my_payments_screen.dart:85` | `payments-service.ts:400-435` | Returns `reference` masked as `'Ref ••••3456'` (or `'Ref ••••'`), status `pendingVerification` |
| **(4) Visibility: Rejected** | Other members' rejected payments | `mock_transactions_repository.dart:28` | `v_activity_items` view, `activity-service.ts` | Filtered out from public activity feeds; visible only to submitter in `/payments/my` |
| **(5) Ordering & Pagination** | Activity feed ordering & pagination | `mock_transactions_repository.dart:34` | `activity-service.ts:148-188` | Keyset pagination `occurred_at DESC, id DESC`, opaque base64url cursor `{ occurredAt, id }` |
| **(6) Reversals: Rules** | Kinds, permissions & balance guard | `mock_transactions_repository.dart:184` | `transactions-service.ts:140-240` | Only verified `expense` and `interest`; Treasurer only; 409 `insufficient_balance` on interest reversal |
| **(7) Direct Transactions** | Direct ledger recording | `mock_transactions_repository.dart:73` | `transactions-service.ts:92-120` | Only `expense` and `interest`; Treasurer only; 366-day NPT window; 1..1B paisa |

### Exact JSON Keys by Role
- **Member Detail (`GET /members/:memberId`)**:
  - Plain member viewing another member: `{ member: { id, displayName, roles, joinedAt, isCurrentUser: false, currentPeriodStatus }, verifiedTotalPaisa, pendingTotalPaisa: 0, verifiedMonthCount, history: [{ month, expectedPaisa, paidPaisa: 0, status, recordedAt }] }`
  - Treasurer / Self viewing Member Detail: Same keys, but `pendingTotalPaisa` is real pending sum and pending history row shows real `paidPaisa`. Reference is omitted in both.
- **Another Member's Pending Payment in `/transactions`**: `{ id: "submission:<uuid>", source: "submission", rawId, kind: "contribution", title, amountPaisa, status: "pendingVerification", occurredAt, memberId, memberName, paymentMethod, note, reversesTransactionId: null, reversedByTransactionId: null, signedAmountPaisa }`. No reference key.
- **`/payments/my`**: Array of `{ id, periodMonth, amountPaisa, paymentMethod, reference: "Ref ••••...", note, status, submittedAt, rejectionReason, rejectionNote }`.

---

## 2. Doc-vs-Flutter Disagreements

| Topic | `docs/api-contract.md` | Flutter Code | Implemented API | Side Followed & Rationale |
|---|---|---|---|---|
| **Short Ref Masking** | Stated `Ref ••••3456` | `my_payments_screen.dart:85` outputs `Ref ••••12` for `<= 4` chars | `reference-masking.ts:17` strictly outputs `Ref ••••` for `<= 4` chars | **Implemented Stricter**: Owner decision; leaking raw short IDs in masked fields violates privacy rules. |
| **Direct Withdrawals** | Withdrawals restricted to approvals | `mock_transactions_repository.dart:73` allowed direct withdrawals | `transactions-service.ts:92` rejects `withdrawal` with 400 | **Contract Followed**: Withdrawals represent group fund removal and require multi-member governance. |
| **Reversal Title Length** | Unspecified | `mock_transactions_repository.dart:184` prepended `Reversal: ` unbounded | `posting-service.ts:241` slices title `Reversal: ${title.slice(0, 50)}` | **Database Schema Followed**: Prevents exceeding `VARCHAR(60)` column limit while matching Flutter format. |
| **FIN-1 Mutation** | Kept submissions in separate table | Mutated `MockLedgerEntry.status` in-place in `group.entries` | `payment_submissions` table + append-only `ledger_entries` | **Contract Followed**: Preserves strict append-only financial accounting invariants. |

---

## 3. Transaction ID Handling in `GET /transactions/:transactionId`

`getActivityItem` in `src/application/activity-service.ts:203-323` resolves `:transactionId` as follows:
- **(a) `ledger:<uuid>`**: Strips prefix, validates UUID format via `UUID_REGEX`, queries `ledger_entries` where `id = rawId AND group_id = :groupId`. Returns single ledger item or 404 `transaction_not_found`.
- **(b) `submission:<uuid>`**: Strips prefix, validates UUID, queries `payment_submissions` where `id = rawId AND group_id = :groupId AND posted_ledger_entry_id IS NULL`. Returns pending submission item or 404 `transaction_not_found`.
- **(c) Bare `<uuid>`**: Validates UUID. Queries `ledger_entries` first. If found, returns ledger item. If not found in ledger, falls back to `payment_submissions` where `posted_ledger_entry_id IS NULL`.
  - *Conflict resolution*: If identical UUID existed in both, ledger entry takes precedence.
  - *Verified submission with bare UUID*: When a submission is verified, a new ledger entry is created with its own UUID. The submission has `posted_ledger_entry_id != null`. Therefore, looking up a bare submission UUID fails both queries and returns 404 `transaction_not_found`.
- **(d) Garbage string**: Non-UUID string without valid prefix fails format check and returns 404 `transaction_not_found`.
- *Assessment*: Matches `docs/api-contract.md`. In Phase 6, we recommend deprecating bare UUIDs and strictly requiring `ledger:<uuid>` or `submission:<uuid>` prefixes to eliminate lookup ambiguity.

---

## 4. Endpoint -> Test Table

| Implemented Endpoint | HTTP Method | Integration Test File | Test Name(s) |
|---|---|---|---|
| `/v1/groups/:id/contributions/periods` | GET | `test/integration/contributions.test.ts` | `GET .../periods returns summaries from earliest entry to current anchor` |
| `/v1/groups/:id/contributions/periods/:periodId` | GET | `test/integration/contributions.test.ts` | `GET .../periods/:periodId returns period detail and obligations`, `... returns 404 period_not_found...`, `excludes members joined after period...` |
| `/v1/groups/:id/payments` | POST | `test/integration/payments.test.ts` | `submits payment successfully...`, `rejects client-supplied amount...`, `rejects submission for period not open...`, `rejects submission for non-obligated...`, `rejects duplicate submission...`, `rejects duplicate reference...` |
| `/v1/groups/:id/payments/my` | GET | `test/integration/payments.test.ts` | `GET /payments/my masks references correctly for varying lengths` |
| `/v1/groups/:id/payments/pending` | GET | `test/integration/payments.test.ts` | `GET /payments/pending exposes unmasked reference and marks isOwnSubmission` |
| `/v1/groups/:id/payments/:subId/verify` | POST | `test/integration/payment-reviews.test.ts` | `verify submission atomically updates status, posts 1 ledger entry...`, `separation of duties...`, `double review returns 409 already_reviewed`, `concurrent review race condition...` |
| `/v1/groups/:id/payments/:subId/reject` | POST | `test/integration/payment-reviews.test.ts` | `reject submission updates status, records reason & note, and writes audit log` |
| `/v1/groups/:id/transactions` | GET | `test/integration/activity.test.ts` | `paginates activity items deterministically across 3 pages using keyset pagination`, `rejects tampered or invalid cursor with 400 invalid_cursor` |
| `/v1/groups/:id/transactions/:txId` | GET | `test/integration/activity.test.ts` | `GET .../:transactionId returns single item for both ledger and submission sources` |
| `/v1/groups/:id/transactions` | POST | `test/integration/transactions.test.ts` | `records expense and interest entries correctly...`, `rejects recording withdrawal directly...`, `enforces balance guard...`, `enforces 366-day date window...` |
| `/v1/groups/:id/transactions/:txId/reverse` | POST | `test/integration/transactions.test.ts` | `reverses an expense successfully...`, `rejects reversal of non-expense/non-interest...`, `enforces balance guard when reversing interest credit` |
| `/v1/groups/:id/members/:memberId` | GET | `test/integration/member-detail.test.ts` | `returns member profile, verified total, pending total...`, `privacy filter: non-treasurer viewing another member...`, `returns 404 member_not_found for removed...` |

*Endpoints with NO direct test*: **None** (all 12 endpoints have direct, dedicated integration tests).

---

## 5. Security & Verification Checks

1. **Raw Reference Grep in Response Schemas & Mappers**:
   - `Select-String -Path src/http/schemas/*.ts -Pattern "reference"` proves raw reference appears in schemas only for:
     - `submitPaymentResponseSchema`: Echoes created submission back to submitter (`POST /payments`).
     - `pendingReviewItemSchema`: Unmasked reference for treasurers (`GET /payments/pending`).
     - `myPaymentItemSchema`: Masked reference string (`GET /payments/my`).
   - `activityItemSchema` (`/transactions`) and `memberDetailResponseSchema` contain **zero** reference fields.
2. **Leak Detection & Cross-User Isolation**:
   - `test/integration/idempotency.test.ts:113` proves two users using identical keys have zero cache leakage.
   - `test/unit/errors.test.ts:122` proves 500 errors never leak database internals or stack traces.
   - `test/integration/member-detail.test.ts:112` proves non-treasurers receive `pendingTotal = 0` and `paidPaisa = 0` on other members' pending rows.
3. **Non-Member / Cross-Group 404 Uniformity**:
   - `test/integration/groups.test.ts:179` proves non-members and unknown UUIDs receive byte-identical 404 `group_not_found` envelopes.
   - All 5.4 routes mount under `groupsRouter.use('/:groupId', requireGroupMembership, ...)` ensuring identical 404 protection before any handler executes.
4. **No Route Logs Request Bodies**:
   - Inspected `src/http/errors.ts:358` and `src/http/app.ts:46`: `pinoHttp` logs HTTP metadata; error logger logs `{ err, requestId, path, method }`. Zero handlers log `req.body`, tokens, or references.
5. **No Double / Floating-Point Types for Money**:
   - Command: `Select-String -Path src/**/*.ts -Pattern "double|Math\.round|parseFloat"` returned **0 occurrences**.

---

## 6. Parity Scenarios

| Parity Test in `parity.test.ts` | Mirrored Dart Test File & Name | Concrete Assertions on Both Sides | Unmirrored Assertions & Reason |
|---|---|---|---|
| **Story 1: Submission & Masking** | `test/app/payment_submission_e2e_test.dart`<br>`'members submit payments, duplicate references are method-scoped, and balances reconcile'` | Expected 70,000 paisa; 3 verified = 210,000 paisa; 1 pending = 70,000 paisa; Member B submits 70,000 paisa; `/payments/my` masks as `Ref ••••8899`; `/payments/pending` exposes unmasked `KH778899`. | Flutter widget UI tree assertions (`tester.tap`, dialogs, SnackBar) omitted; backend verifies HTTP responses and DB rows. |
| **Story 2: Verification & Rejection** | `test/app/payment_verification_e2e_test.dart`<br>`'payment verification covers rejection, approvals, and treasurer separation'` | Submits 70,000 paisa; rejects with `referenceNotFound` and note `"No matching transfer"`; resubmits; dual verification creates exactly 2 verified ledger entries (140,000 paisa); pending queue reaches 0. | Withdrawal and approval voting steps in Dart test deferred to Task 5.5 (governance task). |
| **Story 3: Membership Boundaries** | `test/app/contributions_e2e_test.dart`<br>`'contribution periods reflect membership changes without changing ledger totals'` | Member 1 joins Sept 2026; pays 70,000 in Sept & Oct; total balance = 140,000 paisa; leaves Nov 2026; post-removal balance remains 140,000 paisa; Nov obligations exclude Member 1; Sept obligations include Member 1 as verified (70,000 paisa). | None; all financial and obligation assertions mirrored with 100% parity. |

---

## 7. Open Questions for the Owner

1. **Bare UUID Resolution for Verified Submissions**:
   - *Options*: (A) Current: Return 404 for bare UUID of verified submissions; (B) Auto-resolve bare submission UUID to its posted ledger entry; (C) Disallow bare UUIDs in Phase 6 and mandate `ledger:<uuid>` or `submission:<uuid>`.
   - *Recommendation*: **Option C**. Prefixes remove all ambiguity between submission IDs and posted ledger entry IDs.
2. **Masked Reference Format for Short Strings (`<= 4` chars)**:
   - *Options*: (A) Strict masking to `'Ref ••••'` (current backend); (B) Prepend `'Ref ••••'` and keep all chars (e.g. `'Ref ••••12'` in legacy Flutter UI).
   - *Recommendation*: **Option A**. Keep backend privacy strict; update Flutter client UI in Phase 6 to match.
3. **Pagination Cursor Tamper Resistance**:
   - *Options*: (A) Current base64url JSON `{ occurredAt, id }` validated with Zod; (B) HMAC-signed cursor.
   - *Recommendation*: **Option A**. Sufficient for Phase 5; the endpoint validates data types and returns 400 `invalid_cursor` on malformed inputs.

---

## 8. Verification Results (Fresh Run from Deleted `node_modules`)

- `npm ci`: Added 537 packages; postinstall generated Prisma Client v7.10.1 in 648ms.
- `npm run lint`: **0 errors, 0 warnings**.
- `npm run format:check`: **All matched files use Prettier code style**.
- `npm run typecheck`: **Clean (`tsc --noEmit` exited 0)**.
- `npm run build`: **Clean (`tsc -p tsconfig.build.json` built `dist/` cleanly)**.
- `npm run test:unit`: **18 passed (18 files), 226 passed, 1 skipped (227 total)**.
- `npm run test:integration`: **21 passed (21 files), 78 passed (78 total)**.
- Sibling Flutter repo (`..\broke_travelers`): **Untouched on branch `phase-4-vectors`, working tree clean**.
