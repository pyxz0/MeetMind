-- =============================================================================
-- 多租户迁移 v2 的验收脚本（配合 0002_multitenant_v2.sql）
-- =============================================================================
--
-- 用法：在**已经执行过** 0002_multitenant_v2.sql 的库上跑
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0002_multitenant_v2.verify.sql
--
-- 特点（沿用 v1 的设计，因为那套断言确实抓到过真问题）：
--   * 每条断言不满足就 RAISE EXCEPTION，靠退出码判断成败，不用人肉看输出
--   * 负例用 BEGIN ... EXCEPTION 包住，**期望它失败**；成功了反而报错
--   * 可重复执行（开头先清理自己的测试数据）
--   * 回滚往返在事务里做，结尾 ROLLBACK，不会把库改坏
--
-- 与 v1 verify 的关键差异：
--   v1 断言"全局手机号唯一索引已消失"，v2 断言"它仍然存在"（刻意不动）。
--   这两条是互斥的，别把两个脚本都跑。
-- =============================================================================

\set ON_ERROR_STOP on

\echo '--- 0) 清理上次运行的测试数据 ---'

-- 先删好友（无级联到 users 之外，但顺序上先清更稳）
DELETE FROM "friendships"
 WHERE "user_id" IN (SELECT id FROM "users" WHERE phone LIKE '199000000%')
    OR "friend_id" IN (SELECT id FROM "users" WHERE phone LIKE '199000000%');

DELETE FROM "memberships"
 WHERE "user_id" IN (SELECT id FROM "users" WHERE phone LIKE '199000000%')
    OR "tenant_id" IN (SELECT id FROM "tenants" WHERE name LIKE 'VERIFY-%');

DELETE FROM "users"   WHERE phone LIKE '199000000%';
DELETE FROM "tenants" WHERE name LIKE 'VERIFY-%';

-- =============================================================================
-- 1) 结构断言：表、列、枚举、索引
-- =============================================================================
\echo '--- 1) 结构断言 ---'

DO $$
DECLARE
  n int;
BEGIN
  -- 1.1 四张新表都在
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN ('tenants', 'memberships', 'tenant_invites', 'friendships');
  IF n <> 4 THEN
    RAISE EXCEPTION '新表不完整：期望 4 张，实际 % 张', n;
  END IF;

  -- 1.2 五张根表的 tenant_id 必须是 NOT NULL
  --     （audit_logs 除外，见 1.2b）
  SELECT count(*) INTO n
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND column_name = 'tenant_id'
     AND table_name IN ('meetings','meeting_generations',
                        'meeting_notices','inbox_reads','asr_jobs')
     AND is_nullable = 'NO';
  IF n <> 5 THEN
    RAISE EXCEPTION 'tenant_id 非空约束不完整：期望 5 张表，实际 % 张', n;
  END IF;

  -- 1.2b audit_logs 必须**允许为空**：系统动作没有归属企业
  SELECT count(*) INTO n
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'audit_logs'
     AND column_name = 'tenant_id'
     AND is_nullable = 'YES';
  IF n <> 1 THEN
    RAISE EXCEPTION 'audit_logs.tenant_id 应为可空（系统动作不属于任何企业）';
  END IF;

  -- 1.3 users 表**不允许**有 tenant_id（有就说明跑过 v1 脚本）
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'tenant_id';
  IF n > 0 THEN
    RAISE EXCEPTION 'users 存在 tenant_id 列：本库执行过 v1 迁移，v2 不能直接叠加';
  END IF;

  -- 1.4 users.active_tenant_id 必须存在且非空
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users'
     AND column_name = 'active_tenant_id' AND is_nullable = 'NO';
  IF n <> 1 THEN
    RAISE EXCEPTION 'users.active_tenant_id 缺失或允许为空';
  END IF;

  -- 1.5 两个枚举类型
  SELECT count(*) INTO n FROM pg_type
   WHERE typname IN ('TenantType', 'TenantRole');
  IF n <> 2 THEN
    RAISE EXCEPTION '枚举类型不完整：期望 TenantType/TenantRole，实际 % 个', n;
  END IF;

  -- 1.5b 枚举值必须齐全（只断言类型存在会漏掉"建了类型但值不对"）
  SELECT count(*) INTO n
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'TenantType' AND e.enumlabel IN ('PERSONAL', 'COMPANY');
  IF n <> 2 THEN
    RAISE EXCEPTION 'TenantType 的枚举值不完整（期望 PERSONAL/COMPANY）';
  END IF;

  SELECT count(*) INTO n
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'TenantRole' AND e.enumlabel IN ('OWNER', 'ADMIN', 'MEMBER');
  IF n <> 3 THEN
    RAISE EXCEPTION 'TenantRole 的枚举值不完整（期望 OWNER/ADMIN/MEMBER）';
  END IF;

  -- 1.6 关键索引
  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname IN (
       'tenants_platform_external_id_key',
       'memberships_tenant_id_user_id_key',
       'memberships_user_id_idx',
       'friendships_user_id_friend_id_key',
       'meetings_tenant_id_created_at_idx',
       'users_active_tenant_id_idx'
     );
  IF n <> 6 THEN
    RAISE EXCEPTION '关键索引缺失：期望 6 个，实际 % 个', n;
  END IF;

  -- 1.7 users_phone_key 必须**仍然存在**（v2 刻意不改手机号唯一性）
  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'users_phone_key';
  IF n <> 1 THEN
    RAISE EXCEPTION 'users_phone_key 不见了：v2 不应改动全局手机号唯一索引';
  END IF;

  -- 1.8 超管唯一索引必须还是**全局**的（不含 tenant_id 或 active_tenant_id）
  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname = 'users_single_super_admin_key'
     AND indexdef NOT LIKE '%tenant_id%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'users_single_super_admin_key 被改成了按租户唯一，与 v2 设计不符';
  END IF;

  RAISE NOTICE 'OK: 结构断言通过';
END $$;

-- =============================================================================
-- 2) 数据断言：回填完整、归属自洽
-- =============================================================================
\echo '--- 2) 数据断言 ---'

DO $$
DECLARE
  bad int;
BEGIN
  SELECT count(*) INTO bad FROM "meetings"            WHERE "tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'meetings 有 % 行 tenant_id 为空', bad; END IF;

  -- 有操作者的审计必须有归属；系统动作（actor 为空）允许为空
  SELECT count(*) INTO bad FROM "audit_logs"
   WHERE "actor_id" IS NOT NULL AND "tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION '有 % 条有操作者的审计缺少租户归属', bad; END IF;

  SELECT count(*) INTO bad FROM "meeting_generations" WHERE "tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'meeting_generations 有 % 行 tenant_id 为空', bad; END IF;

  SELECT count(*) INTO bad FROM "meeting_notices"     WHERE "tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'meeting_notices 有 % 行 tenant_id 为空', bad; END IF;

  SELECT count(*) INTO bad FROM "inbox_reads"         WHERE "tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'inbox_reads 有 % 行 tenant_id 为空', bad; END IF;

  SELECT count(*) INTO bad FROM "asr_jobs"            WHERE "tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'asr_jobs 有 % 行 tenant_id 为空', bad; END IF;

  -- 每个用户的当前空间必须有 membership，否则一登录就 401
  SELECT count(*) INTO bad
    FROM "users" u
   WHERE NOT EXISTS (
     SELECT 1 FROM "memberships" m
      WHERE m."user_id" = u."id" AND m."tenant_id" = u."active_tenant_id"
   );
  IF bad > 0 THEN RAISE EXCEPTION '有 % 个用户的当前空间没有 membership', bad; END IF;

  -- 每个用户恰好一个 PERSONAL 空间（不是"至少一个"）
  SELECT count(*) INTO bad
    FROM (
      SELECT u."id"
        FROM "users" u
        JOIN "memberships" m ON m."user_id" = u."id"
        JOIN "tenants" t ON t."id" = m."tenant_id" AND t."type" = 'PERSONAL'
       GROUP BY u."id"
      HAVING count(*) <> 1
    ) t;
  IF bad > 0 THEN RAISE EXCEPTION '有 % 个用户的个人空间数量不等于 1', bad; END IF;

  -- 会议与创建者同租户
  SELECT count(*) INTO bad
    FROM "meetings" m JOIN "users" u ON u."id" = m."owner_id"
   WHERE m."tenant_id" <> u."active_tenant_id";
  IF bad > 0 THEN RAISE EXCEPTION '会议与创建者跨租户：% 行', bad; END IF;

  -- 平台超管唯一
  SELECT count(*) INTO bad FROM "users" WHERE "role" = 'SUPER_ADMIN';
  IF bad > 1 THEN RAISE EXCEPTION '平台超管不唯一：% 个', bad; END IF;

  -- 手机号全局唯一（v2 的刻意设计）
  SELECT count(*) INTO bad
    FROM (SELECT "phone" FROM "users" GROUP BY "phone" HAVING count(*) > 1) t;
  IF bad > 0 THEN RAISE EXCEPTION '有 % 个手机号重复，违反 v2 的全局唯一设计', bad; END IF;

  RAISE NOTICE 'OK: 数据断言通过';
END $$;

-- =============================================================================
-- 3) 正例：双租户并存，隔离的前提成立
-- =============================================================================
\echo '--- 3) 正例：双租户 ---'

-- 建第二个企业
INSERT INTO "tenants" ("id", "name", "type", "updated_at")
VALUES ('00000000-0000-0000-0000-0000000000bb', 'VERIFY-企业B', 'COMPANY', now());

-- 模拟注册流程的插入顺序（文档 §6.12）：先建空间，再建用户，最后建关系。
-- 反过来会撞 users.active_tenant_id 的 NOT NULL 约束。
INSERT INTO "tenants" ("id", "name", "type", "updated_at")
VALUES ('00000000-0000-0000-0000-0000000000cc', 'VERIFY-个人A', 'PERSONAL', now());

-- users.updated_at 没有 DEFAULT（Prisma 的 @updatedAt 由客户端写），
-- 直接 SQL 造数据必须显式给，否则插入失败。
INSERT INTO "users" ("phone", "password_hash", "name", "role", "active_tenant_id", "updated_at")
VALUES ('19900000001', 'x', 'VERIFY-A', 'USER', '00000000-0000-0000-0000-0000000000bb', now());

INSERT INTO "memberships" ("tenant_id", "user_id", "role")
SELECT '00000000-0000-0000-0000-0000000000bb', id, 'MEMBER'
  FROM "users" WHERE phone = '19900000001';

INSERT INTO "memberships" ("tenant_id", "user_id", "role")
SELECT '00000000-0000-0000-0000-0000000000cc', id, 'OWNER'
  FROM "users" WHERE phone = '19900000001';

DO $$
DECLARE n int;
BEGIN
  -- A 有 2 个空间：企业B + 个人A
  SELECT count(*) INTO n FROM "memberships" m
    JOIN "users" u ON u."id" = m."user_id"
   WHERE u."phone" = '19900000001';
  IF n <> 2 THEN
    RAISE EXCEPTION '期望测试用户有 2 个空间，实际 % 个', n;
  END IF;

  -- 企业B 里只有 A 一个成员
  SELECT count(*) INTO n FROM "memberships"
   WHERE "tenant_id" = '00000000-0000-0000-0000-0000000000bb';
  IF n <> 1 THEN
    RAISE EXCEPTION '企业B 的成员数应为 1，实际 %', n;
  END IF;

  -- 迁移补建的个人空间：存量用户 13800000001 必须恰好有 1 个 PERSONAL 空间
  SELECT count(*) INTO n
    FROM "memberships" m
    JOIN "tenants" t ON t."id" = m."tenant_id"
    JOIN "users" u ON u."id" = m."user_id"
   WHERE u."phone" = '13800000001' AND t."type" = 'PERSONAL';
  IF n <> 1 THEN
    RAISE EXCEPTION '存量用户的个人空间数量应为 1，实际 %', n;
  END IF;

  RAISE NOTICE 'OK: 一个账号可同时存在于多个空间';
END $$;

-- =============================================================================
-- 4) 负例：唯一性与约束必须仍然生效
-- =============================================================================
\echo '--- 4) 负例 ---'

DO $$
BEGIN
  -- 4.1 同一 (tenant, user) 重复插入必须被拒
  BEGIN
    INSERT INTO "memberships" ("tenant_id", "user_id", "role")
    SELECT '00000000-0000-0000-0000-0000000000bb', id, 'MEMBER'
      FROM "users" WHERE phone = '19900000001';
    RAISE EXCEPTION '重复 membership 竟然插入成功 —— 唯一索引失效';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: 重复 membership 被拒';
  END;

  -- 4.2 好友自环必须被拒
  BEGIN
    INSERT INTO "friendships" ("user_id", "friend_id")
    SELECT id, id FROM "users" WHERE phone = '19900000001';
    RAISE EXCEPTION '自己加自己为好友竟然成功 —— CHECK 约束失效';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: 好友自环被拒';
  END;

  -- 4.3 同一手机号重复注册必须被拒（v2 保持全局唯一）
  BEGIN
    INSERT INTO "users" ("phone", "password_hash", "name", "role", "active_tenant_id", "updated_at")
    VALUES ('19900000001', 'y', 'VERIFY-dup', 'USER', '00000000-0000-0000-0000-0000000000bb', now());
    RAISE EXCEPTION '同手机号重复插入竟然成功 —— 全局唯一失效';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: 全局手机号唯一仍然生效';
  END;

  -- 4.4 第二个平台超管必须被拒
  BEGIN
    INSERT INTO "users" ("phone", "password_hash", "name", "role", "active_tenant_id", "updated_at")
    VALUES ('19900000002', 'x', 'VERIFY-admin', 'SUPER_ADMIN',
            '00000000-0000-0000-0000-0000000000bb', now());
    RAISE EXCEPTION '第二个平台超管竟然插入成功 —— 唯一性失效';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: 平台超管唯一仍然生效';
  END;
END $$;

-- =============================================================================
-- 5) 回滚往返：在事务里拆一遍，断言还原干净，然后整体 ROLLBACK
-- =============================================================================
\echo '--- 5) 回滚往返（结束后自动 ROLLBACK） ---'

BEGIN;

-- 回滚前先清掉非默认租户的数据（FK 是 RESTRICT）
UPDATE "users" SET "active_tenant_id" = '00000000-0000-4000-8000-000000000001'
 WHERE "active_tenant_id" = '00000000-0000-0000-0000-0000000000bb';

DELETE FROM "meeting_notices"
 WHERE "meeting_id" IN (SELECT "id" FROM "meetings"
                         WHERE "tenant_id" <> '00000000-0000-4000-8000-000000000001');
DELETE FROM "meetings"
 WHERE "tenant_id" <> '00000000-0000-4000-8000-000000000001';

ALTER TABLE "asr_jobs"            DROP CONSTRAINT IF EXISTS "asr_jobs_tenant_id_fkey";
ALTER TABLE "inbox_reads"         DROP CONSTRAINT IF EXISTS "inbox_reads_tenant_id_fkey";
ALTER TABLE "meeting_notices"     DROP CONSTRAINT IF EXISTS "meeting_notices_tenant_id_fkey";
ALTER TABLE "meeting_generations" DROP CONSTRAINT IF EXISTS "meeting_generations_tenant_id_fkey";
ALTER TABLE "audit_logs"          DROP CONSTRAINT IF EXISTS "audit_logs_tenant_id_fkey";
ALTER TABLE "meetings"            DROP CONSTRAINT IF EXISTS "meetings_tenant_id_fkey";
ALTER TABLE "users"               DROP CONSTRAINT IF EXISTS "users_active_tenant_id_fkey";

ALTER TABLE "asr_jobs"            DROP COLUMN IF EXISTS "tenant_id";
ALTER TABLE "inbox_reads"         DROP COLUMN IF EXISTS "tenant_id";
ALTER TABLE "meeting_notices"     DROP COLUMN IF EXISTS "tenant_id";
ALTER TABLE "meeting_generations" DROP COLUMN IF EXISTS "tenant_id";
ALTER TABLE "audit_logs"          DROP COLUMN IF EXISTS "tenant_id";
ALTER TABLE "meetings"            DROP COLUMN IF EXISTS "tenant_id";
ALTER TABLE "users"               DROP COLUMN IF EXISTS "active_tenant_id";

DROP TABLE IF EXISTS "friendships";
DROP TABLE IF EXISTS "tenant_invites";
DROP TABLE IF EXISTS "memberships";
DROP TABLE IF EXISTS "tenants";
DROP TYPE IF EXISTS "TenantRole";
DROP TYPE IF EXISTS "TenantType";

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND column_name IN ('tenant_id', 'active_tenant_id');
  IF n <> 0 THEN
    RAISE EXCEPTION '回滚后仍有 % 个租户列', n;
  END IF;

  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN ('tenants', 'memberships', 'tenant_invites', 'friendships');
  IF n <> 0 THEN
    RAISE EXCEPTION '回滚后仍有 % 张新表', n;
  END IF;

  -- 唯一索引从来没被碰过，回滚后必须还在
  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'users_phone_key';
  IF n <> 1 THEN
    RAISE EXCEPTION '回滚后 users_phone_key 不见了';
  END IF;

  RAISE NOTICE 'OK: 回滚可完整还原';
END $$;

ROLLBACK;

\echo '--- 验收全部通过 ---'
