-- =============================================================================
-- 多租户迁移的验收脚本（配合 0001_multitenant.sql 使用）
-- =============================================================================
--
-- 用法：在**已经执行过** 0001_multitenant.sql 的库上跑
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0001_multitenant.verify.sql
--
-- 特点：
--   * 所有断言都是"不满足就 RAISE EXCEPTION"，靠退出码判断成败，不用人肉看输出
--   * 负例用 BEGIN ... EXCEPTION 包住，**期望它失败**；如果它成功了反而报错
--   * 回滚演练在事务里做，结尾 ROLLBACK，不会把库改坏
--   * 可以重复执行（每次先清理自己的测试租户）
--
-- 一条命令自动跑完整个流程（建库→迁移→验收）见
--   scripts/db/rehearse-multitenant.ps1
-- =============================================================================

\set ON_ERROR_STOP on
\echo '--- 0) 清理上次运行残留的测试租户 ---'

DELETE FROM users   WHERE tenant_id IN (SELECT id FROM tenants WHERE name LIKE 'VERIFY-%');
DELETE FROM tenants WHERE name LIKE 'VERIFY-%';

-- =============================================================================
-- 1) 结构断言：索引形态
-- =============================================================================
\echo '--- 1) 结构断言 ---'

DO $$
DECLARE
  has_global int;
  has_scoped int;
  super_ok   int;
BEGIN
  SELECT count(*) INTO has_global
    FROM pg_indexes WHERE schemaname='public' AND indexname='users_phone_key';
  IF has_global > 0 THEN
    RAISE EXCEPTION '全局唯一索引 users_phone_key 仍然存在（致命：第二个企业装不进来）';
  END IF;

  SELECT count(*) INTO has_scoped
    FROM pg_indexes WHERE schemaname='public' AND indexname='users_tenant_id_phone_key';
  IF has_scoped = 0 THEN
    RAISE EXCEPTION '缺少 users_tenant_id_phone_key';
  END IF;

  SELECT count(*) INTO super_ok
    FROM pg_indexes
   WHERE schemaname='public'
     AND indexname='users_single_super_admin_key'
     AND indexdef LIKE '%tenant_id%';
  IF super_ok = 0 THEN
    RAISE EXCEPTION '超管唯一索引没有改造成按租户唯一';
  END IF;

  RAISE NOTICE 'OK: 索引形态正确';
END $$;

-- =============================================================================
-- 2) 数据断言：无空租户、无跨租户脏数据、每租户至多一个超管
-- =============================================================================
\echo '--- 2) 数据断言 ---'

DO $$
DECLARE
  bad int;
BEGIN
  SELECT count(*) INTO bad FROM "users"    WHERE tenant_id IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'users 有 % 行 tenant_id 为空', bad; END IF;

  SELECT count(*) INTO bad FROM "meetings" WHERE tenant_id IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'meetings 有 % 行 tenant_id 为空', bad; END IF;

  SELECT count(*) INTO bad FROM "audit_logs" WHERE tenant_id IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'audit_logs 有 % 行 tenant_id 为空', bad; END IF;

  SELECT count(*) INTO bad
    FROM "meetings" m JOIN "users" u ON u.id = m.owner_id
   WHERE m.tenant_id <> u.tenant_id;
  IF bad > 0 THEN RAISE EXCEPTION '会议与创建者跨租户：% 行', bad; END IF;

  SELECT count(*) INTO bad
    FROM "audit_logs" a JOIN "users" u ON u.id = a.actor_id
   WHERE a.tenant_id <> u.tenant_id;
  IF bad > 0 THEN RAISE EXCEPTION '审计与操作者跨租户：% 行', bad; END IF;

  SELECT count(*) INTO bad
    FROM (SELECT tenant_id FROM "users" WHERE role='SUPER_ADMIN'
           GROUP BY tenant_id HAVING count(*) > 1) t;
  IF bad > 0 THEN RAISE EXCEPTION '有 % 个租户存在多个超管', bad; END IF;

  RAISE NOTICE 'OK: 回填完整、无跨租户脏数据、超管互不冲突';
END $$;

-- =============================================================================
-- 3) 正例：同一手机号可以在两个租户分别注册
-- =============================================================================
\echo '--- 3) 正例：跨租户同号注册 ---'

INSERT INTO tenants (id, name, platform) VALUES
  ('00000000-0000-0000-0000-0000000000aa', 'VERIFY-A', 'standalone'),
  ('00000000-0000-0000-0000-0000000000bb', 'VERIFY-B', 'standalone');

INSERT INTO users (tenant_id, phone, password_hash, name, role, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000aa', '13900000000', 'x', 'A', 'USER', now()),
  ('00000000-0000-0000-0000-0000000000bb', '13900000000', 'x', 'B', 'USER', now());

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "users" WHERE phone = '13900000000';
  IF n <> 2 THEN
    RAISE EXCEPTION '期望两个租户各有一行，实际 % 行', n;
  END IF;
  RAISE NOTICE 'OK: 同一手机号在 A / B 两个租户并存';
END $$;

-- =============================================================================
-- 4) 负例：同租户第二个超管、同租户重复手机号，都必须被拒
-- =============================================================================
\echo '--- 4) 负例：唯一性必须仍然生效 ---'

DO $$
BEGIN
  -- 租户 A 的第一个超管：应当成功
  INSERT INTO users (tenant_id, phone, password_hash, name, role, updated_at)
  VALUES ('00000000-0000-0000-0000-0000000000aa', '13900000001', 'x', 'A-admin', 'SUPER_ADMIN', now());

  -- 租户 A 的第二个超管：必须失败
  BEGIN
    INSERT INTO users (tenant_id, phone, password_hash, name, role, updated_at)
    VALUES ('00000000-0000-0000-0000-0000000000aa', '13900000002', 'x', 'A-admin2', 'SUPER_ADMIN', now());

    RAISE EXCEPTION '同租户第二个超管竟然插入成功 —— 超管唯一性失效';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: 同租户第二个超管被拒';
  END;

  -- 租户 A 内重复手机号：必须失败
  BEGIN
    INSERT INTO users (tenant_id, phone, password_hash, name, role, updated_at)
    VALUES ('00000000-0000-0000-0000-0000000000aa', '13900000000', 'x', 'dup', 'USER', now());

    RAISE EXCEPTION '同租户重复手机号竟然插入成功 —— 租户内唯一性失效';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: 同租户重复手机号被拒';
  END;
END $$;

-- =============================================================================
-- 5) 回滚往返：在事务里回滚一次，断言还原成功，然后整体 ROLLBACK
-- =============================================================================
\echo '--- 5) 回滚往返（结束后自动 ROLLBACK，不会破坏当前库） ---'

BEGIN;

-- 回滚前提：先清掉"只有多租户才可能存在"的重复手机号，否则重建全局唯一索引会失败
DELETE FROM "users"   WHERE tenant_id IN ('00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000000bb');
DELETE FROM "tenants" WHERE id IN ('00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000000bb');

DROP INDEX IF EXISTS "users_single_super_admin_key";
CREATE UNIQUE INDEX "users_single_super_admin_key" ON "users" ("role") WHERE "role" = 'SUPER_ADMIN';

DROP INDEX IF EXISTS "users_tenant_id_phone_key";
CREATE UNIQUE INDEX "users_phone_key" ON "users" ("phone");

ALTER TABLE "users"               DROP COLUMN IF EXISTS "tenant_id";
ALTER TABLE "meetings"            DROP COLUMN IF EXISTS "tenant_id";
ALTER TABLE "audit_logs"          DROP COLUMN IF EXISTS "tenant_id";
ALTER TABLE "meeting_generations" DROP COLUMN IF EXISTS "tenant_id";
ALTER TABLE "meeting_notices"     DROP COLUMN IF EXISTS "tenant_id";
ALTER TABLE "inbox_reads"         DROP COLUMN IF EXISTS "tenant_id";
DROP TABLE IF EXISTS "tenants";

DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM pg_indexes WHERE schemaname='public' AND indexname='users_phone_key';
  IF n <> 1 THEN RAISE EXCEPTION '回滚后 users_phone_key 未恢复'; END IF;

  SELECT count(*) INTO n FROM information_schema.columns WHERE column_name='tenant_id';
  IF n <> 0 THEN RAISE EXCEPTION '回滚后仍有 % 个 tenant_id 列', n; END IF;

  SELECT count(*) INTO n FROM information_schema.tables WHERE table_name='tenants';
  IF n <> 0 THEN RAISE EXCEPTION '回滚后 tenants 表仍在'; END IF;

  RAISE NOTICE 'OK: 回滚可完整还原';
END $$;

ROLLBACK;

\echo '--- 验收全部通过 ---'
