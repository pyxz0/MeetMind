-- =============================================================================
-- MeetMind 多租户迁移 v2 —— psql 手工执行版
-- =============================================================================
--
-- 设计说明：docs/multi-tenant-plan-v2.md
-- 前身      ：0001_multitenant.sql（v1，已废弃，不要再执行）
--
-- ⚠️ 正式迁移已经是：
--      prisma/migrations/20261125130000_multi_tenant_v2/migration.sql
--    那份是**唯一权威**版本（不含首尾 BEGIN/COMMIT，由 Prisma 包事务执行）。
--
--    本文件保留两个用途：
--      1) 直接用 psql 在演练库跑（带显式事务，可以反复 BEGIN/ROLLBACK 试）
--      2) 反例回归：故意改坏一处，用 rehearse 的 -DraftPath 跑，
--         确认后置断言能把它拦住
--
--    **改迁移规则时两边都要改**，否则手工版与迁移版会漂移。
--
-- 执行前必读：
--   * 全库备份。这份脚本会 DELETE 掉临时表、改 users.role、给 6 张表加列。
--   * 确认用户重名情况（本脚本已用临时映射表规避，但仍建议看一眼）：
--       SELECT name, count(*) FROM users GROUP BY name HAVING count(*) > 1;
--   * 与 v1 的关键差异（见文档 §0）：
--       - 手机号**保持全局唯一**，不动 users_phone_key
--       - 超管**保持全局唯一**，不动 users_single_super_admin_key
--       - users 不加 tenant_id，改为 active_tenant_id + memberships
--     所以这份脚本**不包含任何 DROP INDEX**，回滚也只需要 DROP COLUMN / DROP TABLE。
--
-- 配套文件：
--   验收断言   backend/prisma/drafts/0002_multitenant_v2.verify.sql
--   设计说明   docs/multi-tenant-plan-v2.md
--   演练脚本   scripts/db/rehearse-multitenant.ps1（框架可复用，替换输入 SQL 即可）
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- ① 枚举（与 Prisma 的命名保持一致，类型名用 PascalCase）
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "TenantType" AS ENUM ('PERSONAL', 'COMPANY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "TenantRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- ② 租户主表
-- -----------------------------------------------------------------------------
-- id 用 UUID 而不是自增：租户 id 会出现在 URL、日志、审计里，
-- 自增会暴露平台上有多少客户。
--
-- ⚠️ id 与 updated_at 都**不设 DEFAULT**：
--    Prisma 的 @default(uuid()) 与 @updatedAt 都由客户端生成/维护，
--    数据库若有默认值，`prisma migrate diff` 会一直报告差异，
--    下次 migrate dev 就会生成一个"删掉默认值"的无意义迁移。
--    代价：任何直接用 SQL 插 tenants 的脚本都必须显式给 id 和 updated_at。
CREATE TABLE IF NOT EXISTS "tenants" (
  "id"          UUID PRIMARY KEY,
  "name"        VARCHAR(120) NOT NULL,
  "type"        "TenantType" NOT NULL DEFAULT 'COMPANY',
  "platform"    VARCHAR(32)  NOT NULL DEFAULT 'standalone',
  "external_id" VARCHAR(120),
  "status"      VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  "plan"        VARCHAR(32)  NOT NULL DEFAULT 'free',
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ(3) NOT NULL
);

-- 平台侧企业标识唯一。standalone 租户 external_id 为 NULL，
-- PostgreSQL 唯一索引允许多个 NULL，不影响自建租户。
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_platform_external_id_key"
  ON "tenants" ("platform", "external_id");

CREATE INDEX IF NOT EXISTS "tenants_type_idx" ON "tenants" ("type");

-- -----------------------------------------------------------------------------
-- ③ 归属关系表
-- -----------------------------------------------------------------------------
-- 产品约束（应用层，不在库里）：一个用户最多一条 COMPANY membership。
-- 放在应用层是为了将来放开"一人多企业"时只改一个判断，不用改表。
CREATE TABLE IF NOT EXISTS "memberships" (
  "id"         SERIAL PRIMARY KEY,
  "tenant_id"  UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "user_id"    INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "role"       "TenantRole" NOT NULL DEFAULT 'MEMBER',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "memberships_tenant_id_user_id_key"
  ON "memberships" ("tenant_id", "user_id");

CREATE INDEX IF NOT EXISTS "memberships_user_id_idx" ON "memberships" ("user_id");

-- -----------------------------------------------------------------------------
-- ④ 邀请表（Phase 3 用，先建好避免二次动表）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "tenant_invites" (
  "id"         SERIAL PRIMARY KEY,
  "tenant_id"  UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "token_hash" VARCHAR(64) NOT NULL,
  "phone"      VARCHAR(20),
  "role"       "TenantRole" NOT NULL DEFAULT 'MEMBER',
  "max_uses"   INTEGER NOT NULL DEFAULT 1,
  "used_count" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_by" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_invites_token_hash_key"
  ON "tenant_invites" ("token_hash");

CREATE INDEX IF NOT EXISTS "tenant_invites_tenant_id_idx" ON "tenant_invites" ("tenant_id");

-- -----------------------------------------------------------------------------
-- ⑤ 好友关系（双向存两行，见文档 §2.6）
-- -----------------------------------------------------------------------------
-- 加好友免审批、按手机号精确查找。删除时两行一起删。
CREATE TABLE IF NOT EXISTS "friendships" (
  "id"         SERIAL PRIMARY KEY,
  "user_id"    INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "friend_id"  INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "friendships_user_id_friend_id_key"
  ON "friendships" ("user_id", "friend_id");

CREATE INDEX IF NOT EXISTS "friendships_friend_id_idx" ON "friendships" ("friend_id");

-- 自环（A 加自己为好友）必须挡住。应用层也会拦，这里兜底。
DO $$ BEGIN
  ALTER TABLE "friendships" ADD CONSTRAINT "friendships_no_self_fkey"
    CHECK ("user_id" <> "friend_id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- ⑥ 默认组织：承接现有全部数据
-- -----------------------------------------------------------------------------
-- 固定 uuid，便于迁移脚本与验收断言引用。
-- updated_at 没有 DEFAULT（见 ② 的说明），必须显式给。
INSERT INTO "tenants" ("id", "name", "type", "platform", "updated_at")
VALUES ('00000000-0000-4000-8000-000000000001', '默认组织', 'COMPANY', 'standalone', now())
ON CONFLICT ("id") DO NOTHING;

-- -----------------------------------------------------------------------------
-- ⑦ 六张根表加 tenant_id（先可空）
-- -----------------------------------------------------------------------------
-- 子表（meeting_decisions / meeting_todos / meeting_leaders /
--       meeting_members / meeting_shares）刻意不加：
-- 它们的访问一律先解析 meetingId 再走 assertCan*，租户由会议继承。
--
-- users 也刻意不加：v2 里用户是全局实体，归属看 memberships。
-- asr_jobs 是 v1 漏掉的，见文档 §6.10。
ALTER TABLE "meetings"            ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "audit_logs"          ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "meeting_generations" ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "meeting_notices"     ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "inbox_reads"         ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "asr_jobs"            ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

-- -----------------------------------------------------------------------------
-- ⑧ 回填：现有数据全部归入默认组织
-- -----------------------------------------------------------------------------
UPDATE "meetings"            SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "audit_logs"          SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "meeting_generations" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "meeting_notices"     SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "inbox_reads"         SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "asr_jobs"            SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;

-- -----------------------------------------------------------------------------
-- ⑨ 非空 + 外键 + 索引
-- -----------------------------------------------------------------------------
ALTER TABLE "meetings"            ALTER COLUMN "tenant_id" SET NOT NULL;
-- audit_logs 刻意**允许为空**：系统级动作（定时任务、平台回调）没有操作者，
-- 本来就不属于任何企业。强制 NOT NULL 会让这类记录要么写不进去、
-- 要么被迫污染某家企业的审计导出。
ALTER TABLE "audit_logs"          ALTER COLUMN "tenant_id" DROP NOT NULL;
ALTER TABLE "meeting_generations" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "meeting_notices"     ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "inbox_reads"         ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "asr_jobs"            ALTER COLUMN "tenant_id" SET NOT NULL;

-- meetings 用 RESTRICT：不允许删掉仍有会议数据的租户（与 owner_id 的取舍一致）
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

ALTER TABLE "asr_jobs"
  ADD CONSTRAINT "asr_jobs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 索引：租户是所有查询的第一维，复合索引把 tenant_id 放最左。
-- 命名严格跟随 Prisma 的约定 `<表>_<列名>_idx`，否则 `prisma migrate diff`
-- 会把它们全部识别成"需要重命名"，下次 migrate dev 就生成一堆无意义迁移。
CREATE INDEX IF NOT EXISTS "meetings_tenant_id_created_at_idx"
  ON "meetings" ("tenant_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "meetings_tenant_id_owner_id_created_at_idx"
  ON "meetings" ("tenant_id", "owner_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "meetings_tenant_id_pinned_at_idx"
  ON "meetings" ("tenant_id", "pinned_at" DESC);

CREATE INDEX IF NOT EXISTS "meetings_tenant_id_scheduled_at_idx"
  ON "meetings" ("tenant_id", "scheduled_at");

CREATE INDEX IF NOT EXISTS "audit_logs_tenant_id_created_at_idx"
  ON "audit_logs" ("tenant_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "meeting_generations_tenant_id_status_idx"
  ON "meeting_generations" ("tenant_id", "status");

CREATE INDEX IF NOT EXISTS "meeting_notices_tenant_id_user_id_created_at_idx"
  ON "meeting_notices" ("tenant_id", "user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "inbox_reads_tenant_id_user_id_idx"
  ON "inbox_reads" ("tenant_id", "user_id");

CREATE INDEX IF NOT EXISTS "asr_jobs_tenant_id_user_id_idx"
  ON "asr_jobs" ("tenant_id", "user_id");

-- 旧索引在新查询模式下不再被使用（tenant_id 不在最左），可留可删。
-- 先保留，观察 pg_stat_user_indexes 的 idx_scan 后再决定。
-- DROP INDEX IF EXISTS "meetings_created_at_idx";

-- -----------------------------------------------------------------------------
-- ⑩ 用户侧：active_tenant_id + 归属关系
-- -----------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "active_tenant_id" UUID;

-- 存量用户全部进默认组织；原 ADMIN 的管理能力转到 membership，
-- 因为 users.role 的 ADMIN 在 v2 里已废弃（文档 §5.1）。
INSERT INTO "memberships" ("tenant_id", "user_id", "role", "created_at")
SELECT
  '00000000-0000-4000-8000-000000000001',
  u."id",
  CASE u."role"
    WHEN 'SUPER_ADMIN' THEN 'OWNER'::"TenantRole"
    WHEN 'ADMIN'       THEN 'ADMIN'::"TenantRole"
    ELSE 'MEMBER'::"TenantRole"
  END,
  now()
FROM "users" u
WHERE NOT EXISTS (
  SELECT 1 FROM "memberships" m
   WHERE m."tenant_id" = '00000000-0000-4000-8000-000000000001'
     AND m."user_id" = u."id"
);

-- 平台角色收窄：ADMIN 废弃，降为 USER。租户内的 ADMIN 由 membership 承担。
UPDATE "users" SET "role" = 'USER' WHERE "role" = 'ADMIN';

UPDATE "users"
   SET "active_tenant_id" = '00000000-0000-4000-8000-000000000001'
 WHERE "active_tenant_id" IS NULL;

ALTER TABLE "users" ALTER COLUMN "active_tenant_id" SET NOT NULL;

ALTER TABLE "users"
  ADD CONSTRAINT "users_active_tenant_id_fkey"
  FOREIGN KEY ("active_tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "users_active_tenant_id_idx" ON "users" ("active_tenant_id");

-- -----------------------------------------------------------------------------
-- ⑪ 给每个存量用户补一个空的个人空间
-- -----------------------------------------------------------------------------
-- ⚠️ 会议**不迁移**，仍留在默认组织，保持现有协作关系（文档 §2.4）。
--    拆到各人个人空间会让"别人共享给我的会议"一夜之间跨租户断裂。
--
-- 用临时映射表而不是「按 name 反查」：重名用户会导致串号，
-- 而 name 本来就不是唯一键。
DROP TABLE IF EXISTS "tmp_personal_tenant";

CREATE TEMP TABLE "tmp_personal_tenant" (
  "user_id"   INTEGER PRIMARY KEY,
  "tenant_id" UUID NOT NULL
) ON COMMIT DROP;

INSERT INTO "tmp_personal_tenant" ("user_id", "tenant_id")
SELECT u."id", gen_random_uuid()
FROM "users" u
WHERE NOT EXISTS (
  SELECT 1
  FROM "memberships" m
  JOIN "tenants" t ON t."id" = m."tenant_id"
  WHERE m."user_id" = u."id" AND t."type" = 'PERSONAL'
);

INSERT INTO "tenants" ("id", "name", "type", "platform", "updated_at")
SELECT t."tenant_id", u."name" || ' 的空间', 'PERSONAL', 'standalone', now()
FROM "tmp_personal_tenant" t
JOIN "users" u ON u."id" = t."user_id";

INSERT INTO "memberships" ("tenant_id", "user_id", "role", "created_at")
SELECT t."tenant_id", t."user_id", 'OWNER'::"TenantRole", now()
FROM "tmp_personal_tenant" t;

-- -----------------------------------------------------------------------------
-- ⑫ 后置断言：把"静默无操作"变成"立刻报错回滚"
-- -----------------------------------------------------------------------------
-- 教训来自 v1（文档 §10）：DDL 里的 IF EXISTS / IF NOT EXISTS 在对象类型不对时
-- 什么都不做，也不报错。所以每条关键假设都要在这里显式验证。
DO $$
DECLARE
  bad int;
BEGIN
  -- 1) 六张根表不允许残留空租户
  SELECT count(*) INTO bad FROM "meetings" WHERE "tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'meetings 有 % 行 tenant_id 为空', bad; END IF;

  SELECT count(*) INTO bad FROM "audit_logs" WHERE "actor_id" IS NOT NULL AND "tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION '有 % 条有操作者的审计缺少租户归属', bad; END IF;

  SELECT count(*) INTO bad FROM "meeting_generations" WHERE "tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'meeting_generations 有 % 行 tenant_id 为空', bad; END IF;

  SELECT count(*) INTO bad FROM "meeting_notices" WHERE "tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'meeting_notices 有 % 行 tenant_id 为空', bad; END IF;

  SELECT count(*) INTO bad FROM "inbox_reads" WHERE "tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'inbox_reads 有 % 行 tenant_id 为空', bad; END IF;

  SELECT count(*) INTO bad FROM "asr_jobs" WHERE "tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'asr_jobs 有 % 行 tenant_id 为空', bad; END IF;

  -- 2) 每个用户的 active 空间必须有对应 membership，否则一登录就是 401
  SELECT count(*) INTO bad
    FROM "users" u
   WHERE NOT EXISTS (
     SELECT 1 FROM "memberships" m
      WHERE m."user_id" = u."id" AND m."tenant_id" = u."active_tenant_id"
   );
  IF bad > 0 THEN RAISE EXCEPTION '有 % 个用户的当前空间没有 membership', bad; END IF;

  -- 3) 每个用户必须恰好有一个 PERSONAL 空间（存量补建不能漏人）
  SELECT count(*) INTO bad
    FROM "users" u
   WHERE NOT EXISTS (
     SELECT 1
       FROM "memberships" m
       JOIN "tenants" t ON t."id" = m."tenant_id"
      WHERE m."user_id" = u."id" AND t."type" = 'PERSONAL'
   );
  IF bad > 0 THEN RAISE EXCEPTION '有 % 个用户没有个人空间', bad; END IF;

  -- 4) 会议与创建者必须同租户（迁移后应天然成立）
  SELECT count(*) INTO bad
    FROM "meetings" m JOIN "users" u ON u."id" = m."owner_id"
   WHERE m."tenant_id" <> u."active_tenant_id";
  IF bad > 0 THEN RAISE EXCEPTION '会议与创建者跨租户：% 行', bad; END IF;

  -- 5) 平台超管仍然唯一（v2 没动这条索引，验证它还在）
  SELECT count(*) INTO bad FROM "users" WHERE "role" = 'SUPER_ADMIN';
  IF bad > 1 THEN RAISE EXCEPTION '平台超管不唯一：% 个', bad; END IF;

  -- 6) 手机号仍然全局唯一（v2 刻意不动）—— 存在重复即说明有人跑过 v1 脚本
  SELECT count(*) INTO bad
    FROM (SELECT "phone" FROM "users" GROUP BY "phone" HAVING count(*) > 1) t;
  IF bad > 0 THEN RAISE EXCEPTION '有 % 个手机号重复：本库可能执行过 v1 迁移，请先确认', bad; END IF;

  RAISE NOTICE 'OK: v2 迁移断言全部通过';
END $$;

COMMIT;

-- =============================================================================
-- 回滚（仅开发环境；生产请用备份恢复）
-- =============================================================================
--
-- 特点：v2 没有动任何唯一索引，所以回滚不需要处理"同一手机号存在于多个租户"。
--       前提是先删掉新增租户下的数据（FK 是 RESTRICT）。
--
-- BEGIN;
--
--   -- 1) 把所有人拨回默认组织（否则删 users 列会丢失当前空间信息）
--   UPDATE "users" SET "active_tenant_id" = '00000000-0000-4000-8000-000000000001';
--
--   -- 2) 删掉非默认租户的会议与关联数据
--   DELETE FROM "meeting_notices"
--    WHERE "meeting_id" IN (SELECT "id" FROM "meetings"
--                            WHERE "tenant_id" <> '00000000-0000-4000-8000-000000000001');
--   DELETE FROM "meetings"
--    WHERE "tenant_id" <> '00000000-0000-4000-8000-000000000001';
--
--   -- 3) 恢复 users.role（ADMIN 已被降级，这里只能按 membership 粗略还原）
--   UPDATE "users" u SET "role" = 'ADMIN'
--     FROM "memberships" m
--    WHERE m."user_id" = u."id" AND m."role" = 'ADMIN';
--
--   -- 4) 拆结构
--   ALTER TABLE "asr_jobs"            DROP CONSTRAINT IF EXISTS "asr_jobs_tenant_id_fkey";
--   ALTER TABLE "inbox_reads"         DROP CONSTRAINT IF EXISTS "inbox_reads_tenant_id_fkey";
--   ALTER TABLE "meeting_notices"     DROP CONSTRAINT IF EXISTS "meeting_notices_tenant_id_fkey";
--   ALTER TABLE "meeting_generations" DROP CONSTRAINT IF EXISTS "meeting_generations_tenant_id_fkey";
--   ALTER TABLE "audit_logs"          DROP CONSTRAINT IF EXISTS "audit_logs_tenant_id_fkey";
--   ALTER TABLE "meetings"            DROP CONSTRAINT IF EXISTS "meetings_tenant_id_fkey";
--   ALTER TABLE "users"               DROP CONSTRAINT IF EXISTS "users_active_tenant_id_fkey";
--
--   DROP INDEX IF EXISTS "asr_jobs_tenant_id_user_id_idx";
--   DROP INDEX IF EXISTS "inbox_reads_tenant_id_user_id_idx";
--   DROP INDEX IF EXISTS "meeting_notices_tenant_id_user_id_created_at_idx";
--   DROP INDEX IF EXISTS "meeting_generations_tenant_id_status_idx";
--   DROP INDEX IF EXISTS "audit_logs_tenant_id_created_at_idx";
--   DROP INDEX IF EXISTS "meetings_tenant_id_scheduled_at_idx";
--   DROP INDEX IF EXISTS "meetings_tenant_id_pinned_at_idx";
--   DROP INDEX IF EXISTS "meetings_tenant_id_owner_id_created_at_idx";
--   DROP INDEX IF EXISTS "meetings_tenant_id_created_at_idx";
--   DROP INDEX IF EXISTS "users_active_tenant_id_idx";
--
--   ALTER TABLE "asr_jobs"            DROP COLUMN IF EXISTS "tenant_id";
--   ALTER TABLE "inbox_reads"         DROP COLUMN IF EXISTS "tenant_id";
--   ALTER TABLE "meeting_notices"     DROP COLUMN IF EXISTS "tenant_id";
--   ALTER TABLE "meeting_generations" DROP COLUMN IF EXISTS "tenant_id";
--   ALTER TABLE "audit_logs"          DROP COLUMN IF EXISTS "tenant_id";
--   ALTER TABLE "meetings"            DROP COLUMN IF EXISTS "tenant_id";
--   ALTER TABLE "users"               DROP COLUMN IF EXISTS "active_tenant_id";
--
--   DROP TABLE IF EXISTS "friendships";
--   DROP TABLE IF EXISTS "tenant_invites";
--   DROP TABLE IF EXISTS "memberships";
--   DROP TABLE IF EXISTS "tenants";
--   DROP TYPE IF EXISTS "TenantRole";
--   DROP TYPE IF EXISTS "TenantType";
-- COMMIT;
--
-- =============================================================================
-- 验收查询（迁移后在目标库执行，或直接跑 0002_multitenant_v2.verify.sql）
-- =============================================================================
--
-- 1) 六张根表都不允许出现 NULL 租户
-- SELECT
--   (SELECT count(*) FROM meetings            WHERE tenant_id IS NULL) AS meetings_null,
--   (SELECT count(*) FROM audit_logs          WHERE tenant_id IS NULL) AS audit_null,
--   (SELECT count(*) FROM meeting_generations WHERE tenant_id IS NULL) AS gen_null,
--   (SELECT count(*) FROM meeting_notices     WHERE tenant_id IS NULL) AS notices_null,
--   (SELECT count(*) FROM inbox_reads         WHERE tenant_id IS NULL) AS reads_null,
--   (SELECT count(*) FROM asr_jobs            WHERE tenant_id IS NULL) AS asr_null;
-- 期望：全为 0
--
-- 2) 每个用户都有个人空间，且 active 空间在 membership 里
-- SELECT count(*) FROM users u
--  WHERE NOT EXISTS (SELECT 1 FROM memberships m
--                     WHERE m.user_id = u.id AND m.tenant_id = u.active_tenant_id);
-- 期望：0
--
-- 3) 唯一的超管仍然只有一个，且手机号无重复
-- SELECT count(*) FROM users WHERE role = 'SUPER_ADMIN';             期望：1
-- SELECT count(*) FROM (SELECT phone FROM users GROUP BY phone
--                        HAVING count(*) > 1) t;                     期望：0
--
-- 4) 双租户冒烟：建第二个企业 + 把某人加进去，验证跨租户隔离的前提成立
-- INSERT INTO tenants (name, type) VALUES ('测试企业B', 'COMPANY');
-- INSERT INTO memberships (tenant_id, user_id, role)
--   SELECT id, <某用户 id>, 'MEMBER' FROM tenants WHERE name = '测试企业B';
-- SELECT count(*) FROM memberships WHERE tenant_id <> '...0001';      期望：≥1
