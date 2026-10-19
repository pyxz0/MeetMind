/*
  负责人改为可多位：meetings.leader_id（单值） -> meeting_leaders 关联表。

  迁移顺序：
    1. 建表
    2. 把现有 leader_id 搬进关联表（保证每场会议都保留原来的负责人）
    3. 删除旧列（外键与索引随列一并删除）

  这样不会出现「迁移后某场会议没有负责人」的中间状态。
*/

CREATE TABLE "meeting_leaders" (
    "id" SERIAL NOT NULL,
    "meeting_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_leaders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meeting_leaders_meeting_id_user_id_key"
  ON "meeting_leaders"("meeting_id", "user_id");

CREATE INDEX "meeting_leaders_user_id_idx" ON "meeting_leaders"("user_id");

-- 存量数据搬迁
INSERT INTO "meeting_leaders" ("meeting_id", "user_id")
SELECT "id", "leader_id"
FROM "meetings"
WHERE "leader_id" IS NOT NULL;

-- 删除旧的单值负责人列
ALTER TABLE "meetings" DROP COLUMN "leader_id";

ALTER TABLE "meeting_leaders" ADD CONSTRAINT "meeting_leaders_meeting_id_fkey"
  FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meeting_leaders" ADD CONSTRAINT "meeting_leaders_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
