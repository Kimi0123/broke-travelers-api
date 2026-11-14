# Task 5.6 Review Evidence: Reports, Dashboard Summary & Updates Feed

## 1. Decision Table: Flutter Mock vs Backend Implementation

| Metric / Derivation | Flutter Source | Backend Source | Match? |
|---|---|---|---|
| Verified balance | `mock_dashboard_repository.dart:67` (`balanceAsOf(now)`) | `dashboard-service.ts:74` (`verifiedBalancePaisa`) | Yes |
| Pending amount privacy | `mock_dashboard_repository.dart:73` (treasurer=all, plain=own) | `dashboard-service.ts:84` (plain member masked to 0 if none) | Yes |
| Obligated & verified counts | `mock_dashboard_repository.dart:94` (`deriveObligationStatus`) | `dashboard-service.ts:101` (`deriveObligationStatus`) | Yes |
| Upcoming deadline | `mock_dashboard_repository.dart:123` (`dueDateFor(y, m, dueDay)`) | `dashboard-service.ts:121` (`dueDateFor`) | Yes |
| Needs your vote | `mock_dashboard_repository.dart:154` (`open && isEligible && !voted`) | `dashboard-service.ts:153` (`isEligible && !voted`) | Yes |
| Last reconciliation | `mock_dashboard_repository.dart:167` (newest statementDate) | `dashboard-service.ts:168` (newest statementDate) | Yes |
| Selectable months & years | `mock_reports_repository.dart:48` (group created to anchor) | `reports-service.ts:51` (`selectableMonths`, `selectableYears`) | Yes |
| Monthly report opening/closing | `report_builders.dart:149` (balance at prev/current monthEnd) | `reports-service.ts:103` (`buildMonthlyReport`) | Yes |
| Monthly contributions grouping | `report_builders.dart:117` (by `effectivePeriodMonth`) | `report-builders.ts:117` (by `effectivePeriodMonth`) | Yes |
| Outflow reversal netting | `report_builders.dart:411` (`signedTotalRaw` net sum) | `report-builders.ts:411` (`signedTotalRaw` net sum) | Yes |
| Member report privacy | `mock_reports_repository.dart:212` (other pending masked to 0) | `reports-service.ts:145` (viewer-based privacy filter) | Yes |
| Updates feed derivation | `mock_updates_repository.dart:108` (derived per viewer) | `updates-service.ts:78` (derived per viewer, 5 kinds) | Yes |
| Updates read state | `mock_updates_repository.dart:429` (per user/group read tracking) | `updates-service.ts:389` (`user_update_reads` join) | Yes |

## 2. Doc-vs-Flutter Disagreements

1. **Member Report Privacy**: The roadmap and initial doc drafts did not explicitly specify whether other members' pending contributions in `GET /reports/members` should be visible to plain members. In the Flutter client (`mock_reports_repository.dart:212`), non-treasurers have other members' `pendingPaisa` masked to 0 to prevent unauthorized disclosure of payment details. The backend strictly reproduces this privacy model in `src/application/reports-service.ts:145`.
2. **Updates Read State Persistence**: In Flutter mock repositories, read state was stored in-memory in `_readUpdateIds`. The backend persists read state in the `user_update_reads` relational table (`userId, groupId, feedItemId`), ensuring multi-device consistency across sessions without requiring stateful websocket servers.

## 3. Endpoint -> Test Table

| Endpoint | Test Suite | Key Test Cases |
|---|---|---|
| `GET /v1/groups/:id/dashboard` | `dashboard-reports.test.ts` | Complete Dart metrics, plain member privacy masking, needsYourVote, empty group, last reconciliation |
| `GET /v1/groups/:id/reports/months` | `dashboard-reports.test.ts` | Chronological selectable months/years from creation to anchor |
| `GET /v1/groups/:id/reports/monthly` | `dashboard-reports.test.ts` | Nov 2026, Oct 2026 (+interest, -expense, reversal netted), Sep 2026, range validation (400) |
| `GET /v1/groups/:id/reports/members` | `dashboard-reports.test.ts` | Treasurer sees Hari pending, plain member sees 0, totals row equals sum of visible rows |
| `GET /v1/groups/:id/reports/annual` | `dashboard-reports.test.ts` | Annual summary, monthly breakdown, sum of months equals total, range validation |
| `GET /v1/groups/:id/reports/expenses` | `dashboard-reports.test.ts` | Expenses with reversal netting, `isReversed` and `isReversal` flags |
| `GET /v1/groups/:id/reports/withdrawals` | `dashboard-reports.test.ts` | Empty withdrawals report before execution, non-empty after execution |
| `GET /v1/groups/:id/updates` | `updates.test.ts`, `updates-e2e.test.ts` | Viewer-scoped feed, payments, approvals, reconciliations, reminders, max 50 items |
| `POST /v1/groups/:id/updates/read` | `updates.test.ts`, `updates-e2e.test.ts` | Idempotent mark-read, marked count, unknown IDs ignored |
| `POST /v1/groups/:id/updates/read-all` | `updates.test.ts`, `updates-e2e.test.ts` | Idempotent mark-all-read, brings unread count to 0 |
| `GET /v1/groups/:id/updates/unread-count` | `updates.test.ts`, `updates-e2e.test.ts` | Dynamic unread count reflects unread items and decrements on mark-read |

## 4. Security & Privacy Checks

- **Single Snapshot Isolation**: All dashboard, report, and updates feed derivations load the group's complete entity state within one `REPEATABLE READ` snapshot (`loadGroupSnapshot`), preventing mid-read tearing or inconsistent joins.
- **Reference & Credential Exclusion**: Update feed items and report responses strictly exclude full or masked payment references, transaction notes, firebase UIDs, and emails.
- **Pending Privacy Filter**: Non-treasurer members cannot see pending submission amounts or counts belonging to other members.
- **Uniform 404 Guard**: Non-members querying any dashboard, report, or updates endpoint receive an identical 404 `group_not_found` response to avoid membership enumeration.

## 5. Parity Numbers (Golden Verification)

- **November 2026**: Opening 520,000, Contributions 210,000, Closing 730,000, Pending 70,000 (Hari), Expected 280,000, Outstanding 70,000, 3 of 4 verified.
- **October 2026**: Opening 280,000, Contributions 280,000, Interest 10,000, Expenses 50,000 (Group dinner 50,000, reversal netted), Closing 520,000, 4 of 4 verified.
- **September 2026**: Opening 0, Contributions 280,000, Closing 280,000, 4 of 4 verified.
- **Annual 2026**: Contributions 770,000, Interest 10,000, Expenses 50,000, Net 730,000, Closing 730,000.
- **Outflow 2026**: Expenses 50,000 (Dinner 50,000 + Snack 10,000 - Correction 10,000 = 50,000). Withdrawals: 0.

## 6. Open Questions / Next Phase

- Backend Task 5.6 completes all read model derivations and notification feeds.
- Ready for Task 5.7: Staging Deployment, Automated Backups & End-to-End Verification.
