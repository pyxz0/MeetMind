-- AlterTable
ALTER TABLE "meeting_notices" ADD COLUMN     "emailed_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "notify_email" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "meeting_notices_emailed_at_created_at_idx" ON "meeting_notices"("emailed_at", "created_at");
