/*
  会议消息增加类型。

  之前「会议即将开始」是实时推算出来的，展示的时间是「开会时间 - 20 分钟」，
  并非用户实际收到消息的时间，看起来像假时间。
  现在改为：到期时落库一条 kind = 'reminder' 的消息，记录真实发送时刻。

  用部分唯一索引保证「同一会议对同一人只产生一条提醒」，
  不影响 update 类型（可以有多条变更消息）。
*/

ALTER TABLE "meeting_notices"
  ADD COLUMN "kind" VARCHAR(20) NOT NULL DEFAULT 'update';

CREATE UNIQUE INDEX "meeting_notices_reminder_key"
  ON "meeting_notices"("user_id", "meeting_id")
  WHERE "kind" = 'reminder';
