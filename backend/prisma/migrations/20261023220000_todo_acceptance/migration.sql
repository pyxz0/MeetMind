-- 待办交付与验收：结构化归属 + 提交记录 + 事件流水
--
-- 关键取舍：
-- 1) SUBMITTED 是「已提交、待验收」，不是完成。会议完成判定仍只认
--    COMPLETED / CANCELLED，因此本迁移不需要改动任何会议状态逻辑。
-- 2) 提交记录独立成表：一条待办可以被打回后多次提交，返工次数与验收时长
--    只有在这里才记得下来。
-- 3) 附件落 uploads 卷，下载走鉴权接口，不做静态直出。

-- 新增待验收状态（PG 12+ 支持在事务内新增枚举值，只要不在同一事务里使用它）
ALTER TYPE "TodoStatus" ADD VALUE IF NOT EXISTS 'SUBMITTED';

CREATE TYPE "SubmissionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');

-- 一、待办结构化字段
ALTER TABLE "meeting_todos" ADD COLUMN "assignee_user_id" INTEGER;
ALTER TABLE "meeting_todos" ADD COLUMN "reviewer_id" INTEGER;
ALTER TABLE "meeting_todos" ADD COLUMN "deadline_at" TIMESTAMPTZ(3);

ALTER TABLE "meeting_todos"
  ADD CONSTRAINT "meeting_todos_assignee_user_id_fkey"
  FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "meeting_todos"
  ADD CONSTRAINT "meeting_todos_reviewer_id_fkey"
  FOREIGN KEY ("reviewer_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "meeting_todos_assignee_user_id_status_idx"
  ON "meeting_todos"("assignee_user_id", "status");

CREATE INDEX "meeting_todos_reviewer_id_status_idx"
  ON "meeting_todos"("reviewer_id", "status");

-- 二、提交记录
CREATE TABLE "todo_submissions" (
  "id"            SERIAL NOT NULL,
  "todo_id"       INTEGER NOT NULL,
  "submitter_id"  INTEGER NOT NULL,
  "reviewer_id"   INTEGER,
  "note"          TEXT,
  "status"        "SubmissionStatus" NOT NULL DEFAULT 'PENDING',
  "attempt_no"    INTEGER NOT NULL DEFAULT 1,
  "reject_reason" TEXT,
  "reviewed_at"   TIMESTAMPTZ(3),
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "todo_submissions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "todo_submissions_todo_id_created_at_idx"
  ON "todo_submissions"("todo_id", "created_at" DESC);

CREATE INDEX "todo_submissions_status_idx" ON "todo_submissions"("status");

-- 同一条待办同时最多一条待验收记录：并发重复提交在数据库层被挡住
CREATE UNIQUE INDEX "todo_submissions_one_pending"
  ON "todo_submissions"("todo_id")
  WHERE "status" = 'PENDING';

ALTER TABLE "todo_submissions"
  ADD CONSTRAINT "todo_submissions_todo_id_fkey"
  FOREIGN KEY ("todo_id") REFERENCES "meeting_todos"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "todo_submissions"
  ADD CONSTRAINT "todo_submissions_submitter_id_fkey"
  FOREIGN KEY ("submitter_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "todo_submissions"
  ADD CONSTRAINT "todo_submissions_reviewer_id_fkey"
  FOREIGN KEY ("reviewer_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 三、交付物附件
CREATE TABLE "todo_attachments" (
  "id"            SERIAL NOT NULL,
  "submission_id" INTEGER NOT NULL,
  "file_name"     VARCHAR(255) NOT NULL,
  "mime_type"     VARCHAR(128) NOT NULL,
  "size_bytes"    INTEGER NOT NULL,
  "stored_path"   VARCHAR(255) NOT NULL,
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "todo_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "todo_attachments_submission_id_idx"
  ON "todo_attachments"("submission_id");

ALTER TABLE "todo_attachments"
  ADD CONSTRAINT "todo_attachments_submission_id_fkey"
  FOREIGN KEY ("submission_id") REFERENCES "todo_submissions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 四、流转流水
CREATE TABLE "todo_events" (
  "id"            SERIAL NOT NULL,
  "todo_id"       INTEGER NOT NULL,
  "actor_id"      INTEGER,
  "type"          VARCHAR(32) NOT NULL,
  "from_status"   "TodoStatus",
  "to_status"     "TodoStatus",
  "submission_id" INTEGER,
  "metadata"      JSONB,
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "todo_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "todo_events_todo_id_created_at_idx"
  ON "todo_events"("todo_id", "created_at");

ALTER TABLE "todo_events"
  ADD CONSTRAINT "todo_events_todo_id_fkey"
  FOREIGN KEY ("todo_id") REFERENCES "meeting_todos"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "todo_events"
  ADD CONSTRAINT "todo_events_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
