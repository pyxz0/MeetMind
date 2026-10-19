/*
  收件箱已读标记。

  只加一列记录「最后一次已读时间」，
  早于该时间的通知算已读 —— 避免为未读状态额外建一张表。
*/

ALTER TABLE "users" ADD COLUMN "inbox_seen_at" TIMESTAMPTZ(3);
