-- CreateTable
CREATE TABLE "invitation_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "attempted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "succeeded" BOOLEAN NOT NULL,

    CONSTRAINT "invitation_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_invitation_attempts_user_window" ON "invitation_attempts"("user_id", "attempted_at" DESC);

-- AddForeignKey
ALTER TABLE "invitation_attempts" ADD CONSTRAINT "invitation_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Permissions: Grant SELECT, INSERT, DELETE ON "invitation_attempts" TO api_user
-- (DELETE is granted exclusively on this table for opportunistic 1-day retention cleanup)
GRANT SELECT, INSERT, DELETE ON "invitation_attempts" TO api_user;
