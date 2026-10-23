-- =============================================================================
-- MeetMind 多租户迁移草稿（手写，未纳入 prisma/migrations/）
-- =============================================================================
--
-- 为什么放在 drafts/ 而不是 migrations/：
--   放在 migrations/ 下会被 `prisma migrate deploy` 自动执行，
--   而这份脚本必须先由人确认约束名、先备份、再按 §5 的两阶段发布流程执行。
--   确认无误后，正式落地的方式是：
--     1) 修改 schema.prisma
--     2) npx prisma migrate dev --create-only --name add_multitenant
--     3) 用本文件的内容替换生成的空迁移（保留 Prisma 生成的时间戳目录名）
--     4) 在 CI 的真库上跑一遍 migrate deploy 验证
--
-- 执行前必读：
--   * 先在目标库确认索引/约束的实际形态（本项目历史上改过登录标识）：
--         SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'users';
--     注意 users_phone_key 是**索引**不是约束，必须用 DROP INDEX。
--   * 全库备份。这个脚本会 DROP 索引。
--   * 生产环境请分两次发布：第一次只执行 ①②③（加列 + 回填，代码不读列），
--     等新代码上线后再执行 ④⑤⑥（NOT NULL + 唯一键切换）。
--     直接一次性跑完会导致滚动发布期间老实例插入的行违反非空约束。
--
-- 配套文件：
--   验收断言      backend/prisma/drafts/0001_multitenant.verify.sql
--   一键演练      scripts/db/rehearse-multitenant.ps1
--                 （起一次性容器 → 迁移 → 种子 → 执行本文件 → 验收 → 删容器）
--   设计说明      docs/multi-tenant-plan.md
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- ① 租户主表
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "tenants" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"        VARCHAR(120) NOT NULL,
  "platform"    VARCHAR(32)  NOT NULL DEFAULT 'standalone',
  "external_id" VARCHAR(120),
  "status"      VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  "plan"        VARCHAR(32)  NOT NULL DEFAULT 'free',
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

-- 平台侧企业标识唯一。standalone 租户 external_id 为空，
-- PostgreSQL 的唯一索引允许多个 NULL，因此不影响单租户部署。
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_platform_external_id_key"
  ON "tenants" ("platform", "external_id");

-- 现有全部数据归入"默认组织"，升级后行为与单租户完全一致
INSERT INTO "tenants" ("id", "name", "platform", "external_id")
VALUES ('00000000-0000-0000-0000-000000000001', '默认组织', 'standalone', NULL)
ON CONFLICT ("id") DO NOTHING;

-- -----------------------------------------------------------------------------
-- ② 六张根表加 tenant_id（先可空）
-- -----------------------------------------------------------------------------
-- 子表（meeting_decisions / meeting_todos / meeting_leaders /
--       meeting_members / meeting_shares）刻意不加：
-- 它们的访问一律先解析 meetingId 再走 assertCan*，租户由会议继承。
ALTER TABLE "users"               ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "meetings"            ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "audit_logs"          ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "meeting_generations" ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "meeting_notices"     ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "inbox_reads"         ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

-- -----------------------------------------------------------------------------
-- ③ 回填
-- -----------------------------------------------------------------------------
UPDATE "users"
   SET "tenant_id" = '00000000-0000-0000-0000-000000000001'
 WHERE "tenant_id" IS NULL;

UPDATE "meetings"
   SET "tenant_id" = '00000000-0000-0000-0000-000000000001'
 WHERE "tenant_id" IS NULL;

-- 审计：优先跟随操作者，无操作者（系统动作）归默认组织
UPDATE "audit_logs" a
   SET "tenant_id" = u."tenant_id"
  FROM "users" u
 WHERE u."id" = a."actor_id"
   AND a."tenant_id" IS NULL;

UPDATE "audit_logs"
   SET "tenant_id" = '00000000-0000-0000-0000-000000000001'
 WHERE "tenant_id" IS NULL;

-- 生成任务：优先跟随会议，会议为空（任务刚建、会议还没建）时跟随发起人
UPDATE "meeting_generations" g
   SET "tenant_id" = m."tenant_id"
  FROM "meetings" m
 WHERE m."id" = g."meeting_id"
   AND g."tenant_id" IS NULL;

UPDATE "meeting_generations" g
   SET "tenant_id" = u."tenant_id"
  FROM "users" u
 WHERE u."id" = g."user_id"
   AND g."tenant_id" IS NULL;

UPDATE "meeting_notices" n
   SET "tenant_id" = m."tenant_id"
  FROM "meetings" m
 WHERE m."id" = n."meeting_id"
   AND n."tenant_id" IS NULL;

UPDATE "inbox_reads" r
   SET "tenant_id" = u."tenant_id"
  FROM "users" u
 WHERE u."id" = r."user_id"
   AND r."tenant_id" IS NULL;

-- 兜底：任何仍未回填的行都归默认组织（正常情况下面不该有输出）
UPDATE "audit_logs"          SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "meeting_generations" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "meeting_notices"     SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "inbox_reads"         SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;

-- -----------------------------------------------------------------------------
-- ④ 非空 + 外键 + 索引
-- -----------------------------------------------------------------------------
ALTER TABLE "users"               ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "meetings"            ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "audit_logs"          ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "meeting_generations" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "meeting_notices"     ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "inbox_reads"         ALTER COLUMN "tenant_id" SET NOT NULL;

-- ON DELETE RESTRICT：不允许删掉仍有数据的租户（与 meetings.owner_id 的取舍一致）
ALTER TABLE "users"
  ADD CONSTRAINT "users_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "meetings"
  ADD CONSTRAINT "meetings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "meeting_generations"
  ADD CONSTRAINT "meeting_generations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meeting_notices"
  ADD CONSTRAINT "meeting_notices_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inbox_reads"
  ADD CONSTRAINT "inbox_reads_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 索引：租户是所有查询的第一维，复合索引把 tenant_id 放最左
CREATE INDEX IF NOT EXISTS "users_tenant_id_idx"
  ON "users" ("tenant_id");

CREATE INDEX IF NOT EXISTS "meetings_tenant_created_idx"
  ON "meetings" ("tenant_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "meetings_tenant_owner_created_idx"
  ON "meetings" ("tenant_id", "owner_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "meetings_tenant_pinned_idx"
  ON "meetings" ("tenant_id", "pinned_at" DESC);

CREATE INDEX IF NOT EXISTS "meetings_tenant_scheduled_idx"
  ON "meetings" ("tenant_id", "scheduled_at");

CREATE INDEX IF NOT EXISTS "audit_logs_tenant_created_idx"
  ON "audit_logs" ("tenant_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "meeting_generations_tenant_status_idx"
  ON "meeting_generations" ("tenant_id", "status");

CREATE INDEX IF NOT EXISTS "meeting_notices_tenant_user_created_idx"
  ON "meeting_notices" ("tenant_id", "user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "inbox_reads_tenant_user_idx"
  ON "inbox_reads" ("tenant_id", "user_id");

-- 旧索引在新查询模式下不再被使用（tenant_id 不在最左），可留可删。
-- 先保留，观察 pg_stat_user_indexes 的 idx_scan 后再决定。
-- DROP INDEX IF EXISTS "meetings_created_at_idx";

-- -----------------------------------------------------------------------------
-- ⑤ 手机号唯一性：全局 → 租户内
-- -----------------------------------------------------------------------------
-- ⚠️ 注意：users_phone_key 是**唯一索引**（CREATE UNIQUE INDEX），不是表约束，
--    所以必须用 DROP INDEX。用 ALTER TABLE ... DROP CONSTRAINT 会静默什么都不做，
--    随后 CREATE UNIQUE INDEX 也不会报错，结果就是"全局唯一"和"租户内唯一"两个索引
--    同时存在 —— 第二个企业装不进来，而且看不出原因。
--    依据：migrations/20261018181520_switch_email_to_phone/migration.sql:38
DROP INDEX IF EXISTS "users_phone_key";

-- 索引名沿用 Prisma 对 @@unique([tenantId, phone]) 的命名约定，
-- 避免以后 prisma migrate dev 认为它"名字不对"而再生成一次重命名迁移。
CREATE UNIQUE INDEX IF NOT EXISTS "users_tenant_id_phone_key"
  ON "users" ("tenant_id", "phone");

-- -----------------------------------------------------------------------------
-- ⑥ 超管唯一性：全局一个 → 每租户一个
-- -----------------------------------------------------------------------------
-- 防御性收尾：如果某环境下同一租户已存在多个超管，保留 id 最小的一个
UPDATE "users" u
   SET "role" = 'ADMIN'
 WHERE u."role" = 'SUPER_ADMIN'
   AND u."id" <> (
     SELECT min(u2."id")
       FROM "users" u2
      WHERE u2."role" = 'SUPER_ADMIN'
        AND u2."tenant_id" = u."tenant_id"
   );

DROP INDEX IF EXISTS "users_single_super_admin_key";

CREATE UNIQUE INDEX "users_single_super_admin_key"
  ON "users" ("tenant_id", "role")
  WHERE "role" = 'SUPER_ADMIN';

-- -----------------------------------------------------------------------------
-- ⑦ 后置断言：把"静默无操作"变成"立刻报错回滚"
-- -----------------------------------------------------------------------------
-- 为什么必须有这一段：
--   DDL 里的 DROP ... IF EXISTS 与 CREATE ... IF NOT EXISTS 组合有一个致命特性——
--   当对象不是你想的那个类型（索引 vs 约束）、或者名字拼错时，它们什么都不做，
--   而且**不报错**。迁移看起来"成功"，实际是错的，直到第二个企业装不进来才暴露。
--
--   所以真正的修复不是把 DROP CONSTRAINT 改成 DROP INDEX，而是让这类错误
--   在事务内立刻中断。下面任何一条不满足，整个迁移整体回滚，一行数据都不会留下。
--
--   已做反例回归：把 ⑤ 的 DROP INDEX 故意改回 DROP CONSTRAINT，本段会抛
--   "users_phone_key 仍然存在" 并回滚（而不是像以前那样只留一条 NOTICE 就全绿）。
DO $$
DECLARE
  remaining_phone_idx int;
  tenant_phone_idx    int;
  super_idx_ok        int;
  null_users          int;
  null_meetings       int;
BEGIN
  -- 1) 全局手机号唯一必须消失
  SELECT count(*) INTO remaining_phone_idx
    FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'users_phone_key';

  IF remaining_phone_idx > 0 THEN
    RAISE EXCEPTION
      'users_phone_key 仍然存在：DROP INDEX 没生效。全局手机号唯一会让第二个企业装不进来';
  END IF;

  -- 2) 租户内手机号唯一必须存在
  SELECT count(*) INTO tenant_phone_idx
    FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'users_tenant_id_phone_key';

  IF tenant_phone_idx = 0 THEN
    RAISE EXCEPTION 'users_tenant_id_phone_key 不存在：租户内手机号唯一未建立';
  END IF;

  -- 3) 超管索引必须是按租户的唯一索引
  SELECT count(*) INTO super_idx_ok
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname = 'users_single_super_admin_key'
     AND indexdef LIKE '%tenant_id%';

  IF super_idx_ok = 0 THEN
    RAISE EXCEPTION 'users_single_super_admin_key 未改造成按租户唯一';
  END IF;

  -- 4) 六张根表都不允许残留空租户（否则后续 NOT NULL 之外还会漏数据）
  SELECT count(*) INTO null_users FROM "users" WHERE "tenant_id" IS NULL;
  SELECT count(*) INTO null_meetings FROM "meetings" WHERE "tenant_id" IS NULL;

  IF null_users > 0 OR null_meetings > 0 THEN
    RAISE EXCEPTION '回填不完整：users=% meetings=% 行 tenant_id 为空', null_users, null_meetings;
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- 第二阶段（选做）：行级安全
-- =============================================================================
--
-- ⚠️ 不要直接复制执行。用 pg 连接池时 `SET app.tenant_id` 是会话级的，
--    连接复用会把租户泄漏到下一个请求。正确方式是在每个请求的
--    $transaction 内 `SET LOCAL app.tenant_id = '<uuid>'`。
--    详见 docs/multi-tenant-plan.md §6。
--
-- ALTER TABLE "meetings"            ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE "users"               ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE "audit_logs"          ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE "meeting_generations" ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE "meeting_notices"     ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE "inbox_reads"         ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY tenant_isolation ON "meetings" USING (
--   "tenant_id" = current_setting('app.tenant_id', true)::uuid
-- );
--
-- -- 子表没有 tenant_id，通过所属会议判定
-- ALTER TABLE "meeting_todos" ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY tenant_isolation ON "meeting_todos" USING (
--   EXISTS (
--     SELECT 1 FROM "meetings" m
--      WHERE m."id" = "meeting_todos"."meeting_id"
--        AND m."tenant_id" = current_setting('app.tenant_id', true)::uuid
--   )
-- );
--
-- =============================================================================
-- 验收查询（迁移后在目标库执行，每条都有明确的预期结果）
-- =============================================================================
--
-- 1) 全局手机号唯一索引必须消失，租户内唯一索引必须存在
-- SELECT indexname FROM pg_indexes
--  WHERE tablename = 'users' AND indexname LIKE '%phone%';
-- 期望：只有 users_tenant_id_phone_key
--
-- 2) 超管索引必须是 (tenant_id, role) 且带 WHERE role='SUPER_ADMIN'
-- SELECT indexdef FROM pg_indexes WHERE indexname = 'users_single_super_admin_key';
--
-- 3) 六张根表都不允许出现 NULL 租户
-- SELECT
--   (SELECT count(*) FROM users               WHERE tenant_id IS NULL) AS users_null,
--   (SELECT count(*) FROM meetings            WHERE tenant_id IS NULL) AS meetings_null,
--   (SELECT count(*) FROM audit_logs          WHERE tenant_id IS NULL) AS audit_null,
--   (SELECT count(*) FROM meeting_generations WHERE tenant_id IS NULL) AS gen_null,
--   (SELECT count(*) FROM meeting_notices     WHERE tenant_id IS NULL) AS notice_null,
--   (SELECT count(*) FROM inbox_reads         WHERE tenant_id IS NULL) AS reads_null;
-- 期望：六个数字全为 0
--
-- 4) 每个租户至多一个超管
-- SELECT tenant_id, count(*) FROM users WHERE role = 'SUPER_ADMIN'
--  GROUP BY tenant_id HAVING count(*) > 1;
-- 期望：0 行
--
-- 5) 跨租户脏数据（会议与创建者、审计与操作者必须同租户）
-- SELECT count(*) FROM meetings m JOIN users u ON u.id = m.owner_id
--  WHERE m.tenant_id <> u.tenant_id;
-- SELECT count(*) FROM audit_logs a JOIN users u ON u.id = a.actor_id
--  WHERE a.tenant_id <> u.tenant_id;
-- 期望：全为 0
--
-- 6) 双租户冒烟：同一手机号可在两个租户分别注册（验证第 ⑤ 步真的生效）
-- INSERT INTO tenants (id, name, platform) VALUES
--   ('00000000-0000-0000-0000-0000000000aa', '租户A', 'standalone'),
--   ('00000000-0000-0000-0000-0000000000bb', '租户B', 'standalone');
-- INSERT INTO users (tenant_id, phone, password_hash, name, role, updated_at)
--   VALUES ('...aa', '13900000000', 'x', 'A', 'USER', now()),
--          ('...bb', '13900000000', 'x', 'B', 'USER', now());
-- 期望：两条都成功（若报唯一键冲突，说明 ⑤ 没生效）

-- =============================================================================
-- 回滚（仅开发环境；生产请用备份恢复）
-- =============================================================================
--
-- ⚠️ 已演练验证（PostgreSQL 16，见 docs/multi-tenant-plan.md §10）。
--    有一个前提：如果已经出现了"同一手机号存在于多个租户"，必须先删掉多出来的那些用户，
--    否则重建全局唯一索引 users_phone_key 会失败。
--
-- BEGIN;
--   DELETE FROM users WHERE tenant_id IN ('<第二个租户的 id>', ...);
--   DELETE FROM tenants WHERE id IN ('<第二个租户的 id>', ...);
--
--   DROP INDEX IF EXISTS "users_single_super_admin_key";
--   CREATE UNIQUE INDEX "users_single_super_admin_key"
--     ON "users" ("role") WHERE "role" = 'SUPER_ADMIN';
--   DROP INDEX IF EXISTS "users_tenant_id_phone_key";
--   CREATE UNIQUE INDEX "users_phone_key" ON "users" ("phone");
--   ALTER TABLE "users"               DROP COLUMN IF EXISTS "tenant_id";
--   ALTER TABLE "meetings"            DROP COLUMN IF EXISTS "tenant_id";
--   ALTER TABLE "audit_logs"          DROP COLUMN IF EXISTS "tenant_id";
--   ALTER TABLE "meeting_generations" DROP COLUMN IF EXISTS "tenant_id";
--   ALTER TABLE "meeting_notices"     DROP COLUMN IF EXISTS "tenant_id";
--   ALTER TABLE "inbox_reads"         DROP COLUMN IF EXISTS "tenant_id";
--   DROP TABLE IF EXISTS "tenants";
-- COMMIT;
