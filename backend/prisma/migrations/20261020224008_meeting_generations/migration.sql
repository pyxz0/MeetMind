/*
  AI 生成任务表。

  把原本的同步长请求改成「先建任务，后台执行，前端轮询」：
  - PENDING / RUNNING 供前端展示进度
  - SUCCEEDED 记录最终会议 id
  - FAILED 保留错误信息，便于排查与重试
  - content_hash 用于识别重复提交（同用户同内容复用在跑的任务）
*/

CREATE TYPE "GenerationStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "meeting_generations" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "meeting_id" INTEGER,
    "content_hash" VARCHAR(64) NOT NULL,
    "status" "GenerationStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_generations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "meeting_generations_user_id_status_idx"
  ON "meeting_generations"("user_id", "status");

CREATE INDEX "meeting_generations_meeting_id_idx"
  ON "meeting_generations"("meeting_id");

ALTER TABLE "meeting_generations" ADD CONSTRAINT "meeting_generations_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meeting_generations" ADD CONSTRAINT "meeting_generations_meeting_id_fkey"
  FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;