-- AlterTable
ALTER TABLE "meetings" ADD COLUMN     "pinned_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "meetings_pinned_at_idx" ON "meetings"("pinned_at" DESC);
