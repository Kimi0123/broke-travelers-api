-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "firebase_uid" VARCHAR(128) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "expected_paisa" BIGINT NOT NULL,
    "due_day" SMALLINT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_memberships" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "is_owner" BOOLEAN NOT NULL DEFAULT false,
    "is_treasurer" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "code" VARCHAR(8) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_by_member_id" UUID NOT NULL,
    "accepted_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_submissions" (
    "id" UUID NOT NULL,
    "seq" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    "group_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "period_month" DATE NOT NULL,
    "amount_paisa" BIGINT NOT NULL,
    "payment_method" VARCHAR(20) NOT NULL,
    "reference" VARCHAR(100),
    "note" VARCHAR(200),
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "submitted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_member_id" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "rejection_reason" VARCHAR(30),
    "rejection_note" VARCHAR(200),
    "posted_ledger_entry_id" UUID,

    CONSTRAINT "payment_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "seq" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    "group_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "title" VARCHAR(60) NOT NULL,
    "magnitude_paisa" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "posted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "member_id" UUID,
    "period_month" DATE,
    "payment_method" VARCHAR(20),
    "note" VARCHAR(200),
    "reverses_entry_id" UUID,
    "actor_member_id" UUID NOT NULL,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "requester_member_id" UUID NOT NULL,
    "title" VARCHAR(60) NOT NULL,
    "payee" VARCHAR(60) NOT NULL,
    "description" VARCHAR(200),
    "amount_paisa" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "closed_at" TIMESTAMPTZ,
    "executed_entry_id" UUID,
    "executed_by_member_id" UUID,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_eligible_voters" (
    "request_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,

    CONSTRAINT "approval_eligible_voters_pkey" PRIMARY KEY ("request_id","member_id")
);

-- CreateTable
CREATE TABLE "approval_votes" (
    "request_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "approve" BOOLEAN NOT NULL,
    "voted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_votes_pkey" PRIMARY KEY ("request_id","member_id")
);

-- CreateTable
CREATE TABLE "bank_reconciliations" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "statement_date" DATE NOT NULL,
    "bank_balance_paisa" BIGINT NOT NULL,
    "recorded_balance_paisa" BIGINT NOT NULL,
    "difference_paisa" BIGINT NOT NULL,
    "note" VARCHAR(200),
    "recorded_by_member_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "field" VARCHAR(100) NOT NULL,
    "before_value" TEXT,
    "after_value" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "group_id" UUID,
    "actor_user_id" UUID NOT NULL,
    "operation" VARCHAR(50) NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_update_reads" (
    "user_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "feed_item_id" VARCHAR(100) NOT NULL,
    "read_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_update_reads_pkey" PRIMARY KEY ("user_id","group_id","feed_item_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_firebase_uid_key" ON "users"("firebase_uid");

-- CreateIndex
CREATE INDEX "group_memberships_group_id_left_at_idx" ON "group_memberships"("group_id", "left_at");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_code_key" ON "invitations"("code");

-- CreateIndex
CREATE UNIQUE INDEX "payment_submissions_posted_ledger_entry_id_key" ON "payment_submissions"("posted_ledger_entry_id");

-- CreateIndex
CREATE INDEX "payment_submissions_group_id_member_id_period_month_submitt_idx" ON "payment_submissions"("group_id", "member_id", "period_month", "submitted_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_reverses_entry_id_key" ON "ledger_entries"("reverses_entry_id");

-- CreateIndex
CREATE INDEX "ledger_entries_group_id_occurred_at_idx" ON "ledger_entries"("group_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_executed_entry_id_key" ON "approval_requests"("executed_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_reconciliations_group_id_statement_date_key" ON "bank_reconciliations"("group_id", "statement_date");

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_member_id_fkey" FOREIGN KEY ("created_by_member_id") REFERENCES "group_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "group_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_reviewed_by_member_id_fkey" FOREIGN KEY ("reviewed_by_member_id") REFERENCES "group_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_posted_ledger_entry_id_fkey" FOREIGN KEY ("posted_ledger_entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "group_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_actor_member_id_fkey" FOREIGN KEY ("actor_member_id") REFERENCES "group_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reverses_entry_id_fkey" FOREIGN KEY ("reverses_entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requester_member_id_fkey" FOREIGN KEY ("requester_member_id") REFERENCES "group_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_executed_by_member_id_fkey" FOREIGN KEY ("executed_by_member_id") REFERENCES "group_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_executed_entry_id_fkey" FOREIGN KEY ("executed_entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_eligible_voters" ADD CONSTRAINT "approval_eligible_voters_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_eligible_voters" ADD CONSTRAINT "approval_eligible_voters_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "group_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_votes" ADD CONSTRAINT "approval_votes_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_votes" ADD CONSTRAINT "approval_votes_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "group_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_recorded_by_member_id_fkey" FOREIGN KEY ("recorded_by_member_id") REFERENCES "group_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_update_reads" ADD CONSTRAINT "user_update_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_update_reads" ADD CONSTRAINT "user_update_reads_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Section A: CHECK Constraints from docs/schema.md
-- ============================================================================

-- Groups constraints
ALTER TABLE "groups"
    ADD CONSTRAINT "chk_groups_expected_paisa" CHECK ("expected_paisa" > 0),
    ADD CONSTRAINT "chk_groups_due_day" CHECK ("due_day" BETWEEN 1 AND 28),
    ADD CONSTRAINT "chk_groups_name_length" CHECK (char_length(trim("name")) >= 2);

-- Invitations status list
ALTER TABLE "invitations"
    ADD CONSTRAINT "chk_invitations_status" CHECK ("status" IN ('pending', 'accepted', 'revoked', 'expired'));

-- Payment Submissions constraints
ALTER TABLE "payment_submissions"
    ADD CONSTRAINT "chk_payment_submissions_amount_paisa" CHECK ("amount_paisa" > 0),
    ADD CONSTRAINT "chk_payment_submissions_payment_method" CHECK ("payment_method" IN ('esewa', 'khalti', 'bankTransfer', 'cash')),
    ADD CONSTRAINT "chk_payment_submissions_status" CHECK ("status" IN ('pending', 'verified', 'rejected')),
    ADD CONSTRAINT "chk_payment_submissions_rejection_reason" CHECK ("rejection_reason" IS NULL OR "rejection_reason" IN ('notReceived', 'wrongAmount', 'referenceNotFound', 'other'));

-- Ledger Entries constraints
ALTER TABLE "ledger_entries"
    ADD CONSTRAINT "chk_ledger_entries_magnitude_paisa" CHECK ("magnitude_paisa" > 0),
    ADD CONSTRAINT "chk_ledger_entries_kind" CHECK ("kind" IN ('contribution', 'interest', 'expense', 'withdrawal')),
    ADD CONSTRAINT "chk_ledger_entries_reversal_kind" CHECK ("reverses_entry_id" IS NULL OR "kind" IN ('expense', 'interest')),
    ADD CONSTRAINT "chk_ledger_entries_contribution_fields" CHECK (
        ("kind" = 'contribution' AND "member_id" IS NOT NULL AND "period_month" IS NOT NULL)
        OR ("kind" <> 'contribution' AND "period_month" IS NULL)
    );

-- Approval Requests constraints
ALTER TABLE "approval_requests"
    ADD CONSTRAINT "chk_approval_requests_kind" CHECK ("kind" IN ('expense', 'withdrawal')),
    ADD CONSTRAINT "chk_approval_requests_amount_paisa" CHECK ("amount_paisa" > 0),
    ADD CONSTRAINT "chk_approval_requests_status" CHECK ("status" IN ('open', 'approved', 'rejected', 'cancelled', 'executed'));

-- Bank Reconciliations non-negative balances
ALTER TABLE "bank_reconciliations"
    ADD CONSTRAINT "chk_bank_reconciliations_bank_balance_paisa" CHECK ("bank_balance_paisa" >= 0),
    ADD CONSTRAINT "chk_bank_reconciliations_recorded_balance_paisa" CHECK ("recorded_balance_paisa" >= 0);

-- ============================================================================
-- Section B: Partial Unique Indexes from docs/schema.md
-- ============================================================================

-- Active membership partial unique index (at most one active membership per user per group)
CREATE UNIQUE INDEX "idx_group_memberships_active_user"
    ON "group_memberships" ("group_id", "user_id")
    WHERE "left_at" IS NULL;

-- Payment submissions method-scoped active reference uniqueness
CREATE UNIQUE INDEX "idx_payment_submissions_active_reference"
    ON "payment_submissions" ("group_id", "payment_method", "reference")
    WHERE "status" IN ('pending', 'verified') AND "reference" IS NOT NULL;

-- Idempotency keys partial unique indexes (group-scoped vs user-scoped)
CREATE UNIQUE INDEX "idx_idempotency_group_scoped"
    ON "idempotency_keys" ("group_id", "actor_user_id", "operation", "idempotency_key")
    WHERE "group_id" IS NOT NULL;

CREATE UNIQUE INDEX "idx_idempotency_user_scoped"
    ON "idempotency_keys" ("actor_user_id", "operation", "idempotency_key")
    WHERE "group_id" IS NULL;

-- ============================================================================
-- Section C: Append-Only Triggers for ledger_entries and audit_log
-- ============================================================================

CREATE OR REPLACE FUNCTION prevent_modification_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'append_only_violation: % table is strictly append-only and rejects UPDATE, DELETE, or TRUNCATE', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_entries_append_only
    BEFORE UPDATE OR DELETE ON "ledger_entries"
    FOR EACH ROW
    EXECUTE FUNCTION prevent_modification_append_only();

CREATE TRIGGER trg_ledger_entries_truncate_guard
    BEFORE TRUNCATE ON "ledger_entries"
    FOR EACH STATEMENT
    EXECUTE FUNCTION prevent_modification_append_only();

CREATE TRIGGER trg_audit_log_append_only
    BEFORE UPDATE OR DELETE ON "audit_log"
    FOR EACH ROW
    EXECUTE FUNCTION prevent_modification_append_only();

CREATE TRIGGER trg_audit_log_truncate_guard
    BEFORE TRUNCATE ON "audit_log"
    FOR EACH STATEMENT
    EXECUTE FUNCTION prevent_modification_append_only();

-- ============================================================================
-- Section D: Activity Feed View (v_activity_items)
-- ============================================================================

-- Unified read model showing verified ledger entries and unverified submissions.
-- Sorted by (occurred_at DESC, id DESC).
CREATE OR REPLACE VIEW v_activity_items AS
SELECT
    'ledger:' || le.id::text AS id,
    'ledger' AS source,
    le.id AS raw_id,
    le.group_id,
    le.kind,
    le.title,
    le.magnitude_paisa AS amount_paisa,
    'verified' AS status,
    le.occurred_at,
    le.member_id,
    le.payment_method,
    le.note,
    le.reverses_entry_id
FROM ledger_entries le
UNION ALL
SELECT
    'submission:' || ps.id::text AS id,
    'submission' AS source,
    ps.id AS raw_id,
    ps.group_id,
    'contribution' AS kind,
    u.display_name || '''s contribution' AS title,
    ps.amount_paisa,
    ps.status,
    ps.submitted_at AS occurred_at,
    ps.member_id,
    ps.payment_method,
    ps.note,
    NULL::uuid AS reverses_entry_id
FROM payment_submissions ps
JOIN group_memberships gm ON gm.id = ps.member_id
JOIN users u ON u.id = gm.user_id
WHERE ps.posted_ledger_entry_id IS NULL;

-- ============================================================================
-- Section E: Runtime Role Privileges for api_user
-- ============================================================================

GRANT USAGE ON SCHEMA public TO api_user;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO api_user;
GRANT SELECT ON v_activity_items TO api_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "ledger_entries", "audit_log" FROM api_user, PUBLIC;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api_user;

