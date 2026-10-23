-- 服务端转写任务表。
--
-- 独立于 meetings：转写发生在会议创建之前，失败的任务不应出现在会议列表里。
-- 删除账号时级联删除任务记录；磁盘文件由服务层负责清理（DB 管不到文件系统）。

CREATE TABLE "asr_jobs" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "stored_path" VARCHAR(255) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "transcript" TEXT,
    "duration_sec" INTEGER,
    "provider_task_id" VARCHAR(120),
    "provider" VARCHAR(32) NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "asr_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "asr_jobs_user_id_created_at_idx" ON "asr_jobs"("user_id", "created_at");

ALTER TABLE "asr_jobs"
  ADD CONSTRAINT "asr_jobs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
