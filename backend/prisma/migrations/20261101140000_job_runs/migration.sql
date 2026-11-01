-- 后台任务执行记录
--
-- 只记「有动作」或「失败」的执行：每分钟一条心跳会让表迅速膨胀，
-- 真正需要回溯的是「发了什么」和「什么时候挂的」。

CREATE TABLE "job_runs" (
    "id" SERIAL NOT NULL,
    "job" VARCHAR(40) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "affected" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "ran_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- 按任务 + 时间查最近记录
CREATE INDEX "job_runs_job_ran_at_idx" ON "job_runs"("job", "ran_at");
