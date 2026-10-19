/*
  收件箱单条已读。

  原有 users.inbox_seen_at 只能表达「某时间点之前都读了」，
  无法在点击单独一条通知后只把它标为已读。
  这里增加按 item_key 的已读记录，两者结合判断：
  命中已读记录，或 createdAt <= inbox_seen_at，都算已读。
*/

CREATE TABLE "inbox_reads" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "item_key" VARCHAR(120) NOT NULL,
    "read_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_reads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inbox_reads_user_id_item_key_key"
  ON "inbox_reads"("user_id", "item_key");

CREATE INDEX "inbox_reads_user_id_idx" ON "inbox_reads"("user_id");

ALTER TABLE "inbox_reads" ADD CONSTRAINT "inbox_reads_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
