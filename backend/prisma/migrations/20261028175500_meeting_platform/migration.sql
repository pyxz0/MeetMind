-- 会议来源平台（腾讯会议等）与回调事件表

ALTER TABLE "meetings" ADD COLUMN     "external_code" VARCHAR(32),
ADD COLUMN     "external_id" VARCHAR(64),
ADD COLUMN     "external_join_url" VARCHAR(512),
ADD COLUMN     "source_platform" VARCHAR(20);

-- CreateTable
CREATE TABLE "platform_events" (
    "id" SERIAL NOT NULL,
    "platform" VARCHAR(20) NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "external_event_id" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "meeting_id" INTEGER,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "platform_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_events_status_received_at_idx" ON "platform_events"("status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_events_platform_external_event_id_key" ON "platform_events"("platform", "external_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "meetings_source_platform_external_id_key" ON "meetings"("source_platform", "external_id");
