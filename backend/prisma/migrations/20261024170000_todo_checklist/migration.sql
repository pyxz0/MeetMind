-- 待办验收要点（验收清单）
--
-- 只是「怎样算通过」的提示与勾选记录，不参与待办状态机：
-- 未勾完也允许验收，避免清单变成卡流程的工具。
-- 删除待办 / 会议时随外键级联清理。

CREATE TABLE "todo_check_items" (
  "id"         SERIAL NOT NULL,
  "todo_id"    INTEGER NOT NULL,
  "content"    VARCHAR(200) NOT NULL,
  "done"       BOOLEAN NOT NULL DEFAULT false,
  "done_by_id" INTEGER,
  "done_at"    TIMESTAMPTZ(3),
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "todo_check_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "todo_check_items_todo_id_sort_order_idx"
  ON "todo_check_items"("todo_id", "sort_order");

ALTER TABLE "todo_check_items"
  ADD CONSTRAINT "todo_check_items_todo_id_fkey"
  FOREIGN KEY ("todo_id") REFERENCES "meeting_todos"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "todo_check_items"
  ADD CONSTRAINT "todo_check_items_done_by_id_fkey"
  FOREIGN KEY ("done_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
