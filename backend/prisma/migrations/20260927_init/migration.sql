-- 初始化 PostgreSQL 公共 schema，并创建 MeetMind 会议数据表。
CREATE SCHEMA IF NOT EXISTS "public";

-- 会议处理状态，标识会议从草稿到生成完成的阶段。
CREATE TYPE "MeetingStatus" AS ENUM ('DRAFT', 'PROCESSING', 'READY', 'FAILED');

-- 待办状态，为行动项后续跟踪预留状态流转。
CREATE TYPE "TodoStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- 会议主表保存原文、AI 摘要、处理状态和创建时间。
CREATE TABLE "meetings" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(200) NOT NULL DEFAULT '未命名会议',
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "status" "MeetingStatus" NOT NULL DEFAULT 'READY',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- 决策明细表：通过 meeting_id 关联会议，并保存稳定的显示顺序。
CREATE TABLE "meeting_decisions" (
    "id" SERIAL NOT NULL,
    "meeting_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "meeting_decisions_pkey" PRIMARY KEY ("id")
);

-- 待办明细表：保留任务、负责人、原始截止时间表达和跟踪状态。
CREATE TABLE "meeting_todos" (
    "id" SERIAL NOT NULL,
    "meeting_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "assignee" VARCHAR(120),
    "deadline" VARCHAR(120),
    "status" "TodoStatus" NOT NULL DEFAULT 'OPEN',
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "meeting_todos_pkey" PRIMARY KEY ("id")
);

-- 历史列表和状态筛选常用的组合索引。
CREATE INDEX "meetings_created_at_idx" ON "meetings"("created_at" DESC);

-- 会议状态筛选与历史排序使用的联合索引。
CREATE INDEX "meetings_status_created_at_idx" ON "meetings"("status", "created_at" DESC);

-- 会议决策按所属会议和排序字段读取。
CREATE INDEX "meeting_decisions_meeting_id_sort_order_idx" ON "meeting_decisions"("meeting_id", "sort_order");

-- 会议待办按所属会议排序，并支持按状态筛选。
CREATE INDEX "meeting_todos_meeting_id_sort_order_idx" ON "meeting_todos"("meeting_id", "sort_order");

-- 按待办状态过滤或统计行动项时使用。
CREATE INDEX "meeting_todos_status_idx" ON "meeting_todos"("status");

-- 删除会议时自动清理对应决策和待办，避免留下孤立数据。
ALTER TABLE "meeting_decisions" ADD CONSTRAINT "meeting_decisions_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 删除会议时级联删除对应的待办。
ALTER TABLE "meeting_todos" ADD CONSTRAINT "meeting_todos_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
