-- AlterTable
ALTER TABLE "meeting_todos" ADD COLUMN     "overdue_notified_at" TIMESTAMPTZ(3),
ADD COLUMN     "overdue_notify_count" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "meeting_todos_status_deadline_at_idx" ON "meeting_todos"("status", "deadline_at");
