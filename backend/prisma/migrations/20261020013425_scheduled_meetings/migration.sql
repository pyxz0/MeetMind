/*
  正式会议：新增开会时间。

  为空表示临时会议（点开始立即进入纪要流程）；
  有值表示预约的正式会议，距离开会不足 20 分钟时提醒参会人员。
*/

ALTER TABLE "meetings" ADD COLUMN "scheduled_at" TIMESTAMPTZ(3);

CREATE INDEX "meetings_scheduled_at_idx" ON "meetings"("scheduled_at");
