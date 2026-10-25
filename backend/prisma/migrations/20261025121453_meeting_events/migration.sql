-- CreateTable
CREATE TABLE "meeting_events" (
    "id" SERIAL NOT NULL,
    "meeting_id" INTEGER NOT NULL,
    "actor_id" INTEGER,
    "type" VARCHAR(32) NOT NULL,
    "from_status" VARCHAR(24),
    "to_status" VARCHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meeting_events_meeting_id_created_at_idx" ON "meeting_events"("meeting_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "meeting_events" ADD CONSTRAINT "meeting_events_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_events" ADD CONSTRAINT "meeting_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
