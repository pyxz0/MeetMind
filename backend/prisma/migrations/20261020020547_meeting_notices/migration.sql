/*
  会议变更消息。

  用于「未开始会议改动预约信息后通知参会人员」这类一次性事件 ——
  这类事件无法从关系和当前状态推导，必须落库。
*/

CREATE TABLE "meeting_notices" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "meeting_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_notices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "meeting_notices_user_id_created_at_idx"
  ON "meeting_notices"("user_id", "created_at" DESC);

ALTER TABLE "meeting_notices" ADD CONSTRAINT "meeting_notices_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meeting_notices" ADD CONSTRAINT "meeting_notices_meeting_id_fkey"
  FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
