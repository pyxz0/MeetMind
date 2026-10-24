-- 待验收 24 小时催办
--
-- 用时间戳而不是布尔值：能看出催办发生的时刻，也方便将来做「再催一次 / 升级给负责人」。
-- 幂等靠 updateMany(where: reminder_sent_at IS NULL) 保证，不需要额外唯一索引。

ALTER TABLE "todo_submissions"
  ADD COLUMN "reminder_sent_at" TIMESTAMPTZ(3);
