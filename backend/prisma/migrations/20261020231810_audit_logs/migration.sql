/*
  审计日志。

  记录删除会议、修改角色、代登、共享等敏感操作。
  actor_id 使用 ON DELETE SET NULL：账号被删后记录仍保留，
  否则"谁删的"这条最关键的信息会随账号一起消失。
*/

CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "actor_id" INTEGER,
    "impersonated_by" INTEGER,
    "action" VARCHAR(64) NOT NULL,
    "resource_type" VARCHAR(32) NOT NULL,
    "resource_id" VARCHAR(64),
    "metadata" JSONB,
    "ip" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" DESC);
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");
CREATE INDEX "audit_logs_resource_type_resource_id_idx"
  ON "audit_logs"("resource_type", "resource_id");

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;