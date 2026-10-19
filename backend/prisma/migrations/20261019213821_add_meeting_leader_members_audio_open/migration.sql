/*
  会议负责人 / 成员 / 录音开放开关。

  新增内容：
    1. meetings.leader_id      负责人（必填）
    2. meetings.audio_open     录音是否对非负责人开放（默认 true）
    3. meeting_members 表      会议成员

  存量数据回填：负责人默认取 meetings.owner_id（创建者即负责人），
  这样「每场会议必须有负责人」的约束可以立刻收紧为非空，
  且不会给已有会议留下无主状态。

  leader_id 外键使用 ON DELETE RESTRICT：
  负责人被删除时不能静默丢会议，应用层会在删除用户前把负责人转给创建者
  （见 UsersService.remove 中的 updateMany）。
*/

-- 1. 录音开放开关：默认开启，保持存量会议行为不变
ALTER TABLE "meetings" ADD COLUMN "audio_open" BOOLEAN NOT NULL DEFAULT true;

-- 2. 负责人：先加可空列，回填为创建者，再收紧非空
ALTER TABLE "meetings" ADD COLUMN "leader_id" INTEGER;

UPDATE "meetings" SET "leader_id" = "owner_id" WHERE "leader_id" IS NULL;

ALTER TABLE "meetings" ALTER COLUMN "leader_id" SET NOT NULL;

ALTER TABLE "meetings" ADD CONSTRAINT "meetings_leader_id_fkey"
  FOREIGN KEY ("leader_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "meetings_leader_id_created_at_idx"
  ON "meetings"("leader_id", "created_at" DESC);

-- 3. 会议成员
CREATE TABLE "meeting_members" (
    "id" SERIAL NOT NULL,
    "meeting_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meeting_members_meeting_id_user_id_key"
  ON "meeting_members"("meeting_id", "user_id");

CREATE INDEX "meeting_members_user_id_idx" ON "meeting_members"("user_id");

ALTER TABLE "meeting_members" ADD CONSTRAINT "meeting_members_meeting_id_fkey"
  FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meeting_members" ADD CONSTRAINT "meeting_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
