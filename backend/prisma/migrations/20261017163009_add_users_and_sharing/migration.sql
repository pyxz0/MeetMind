/*
  用户与共享体系初始化。

  原始 Prisma 生成的迁移直接给 meetings 加非空的 owner_id，
  在有存量数据时会失败。这里改为安全的四步顺序：
    1. 建枚举与用户表 / 共享表
    2. 插入种子超级管理员（固定 id = 1）
    3. 把存量会议回填给该超级管理员
    4. 再把 owner_id 收紧为 NOT NULL 并建立外键

  种子账号：
    邮箱 admin@meetmind.local
    初始密码见交付说明（仅保存 bcrypt 哈希，无法从库中反推）
*/

-- 1. 枚举
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'USER');
CREATE TYPE "SharePermission" AS ENUM ('READ', 'EDIT');

-- 2. 用户表
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(160) NOT NULL,
    "password_hash" VARCHAR(120) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_role_idx" ON "users"("role");

-- 3. 种子超级管理员（固定 id=1，便于回填引用；ON CONFLICT 保证可重复执行）
INSERT INTO "users" ("id", "email", "password_hash", "name", "role", "is_active")
VALUES (
    1,
    'admin@meetmind.local',
    '$2b$12$ws8pYlCT.35pOGZHo4CEpuDB/fZ5tivhcCDZ0hgPh73a8vdzUR8Q.',
    '系统管理员',
    'SUPER_ADMIN',
    true
)
ON CONFLICT ("id") DO NOTHING;

-- 让自增序列从 2 开始，避免后续注册与种子账号 ID 冲突
SELECT setval(
    pg_get_serial_sequence('"users"', 'id'),
    GREATEST((SELECT COALESCE(MAX("id"), 1) FROM "users"), 1)
);

-- 4. 会议归属：先加可空列，回填，再收紧
ALTER TABLE "meetings" ADD COLUMN "owner_id" INTEGER;

-- 存量会议（用户系统上线前创建的）统一归属给超级管理员，避免数据变孤儿
UPDATE "meetings" SET "owner_id" = 1 WHERE "owner_id" IS NULL;

ALTER TABLE "meetings" ALTER COLUMN "owner_id" SET NOT NULL;

CREATE INDEX "meetings_owner_id_created_at_idx" ON "meetings"("owner_id", "created_at" DESC);

ALTER TABLE "meetings" ADD CONSTRAINT "meetings_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. 共享表
CREATE TABLE "meeting_shares" (
    "id" SERIAL NOT NULL,
    "meeting_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "permission" "SharePermission" NOT NULL DEFAULT 'READ',
    "granted_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_shares_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "meeting_shares_user_id_idx" ON "meeting_shares"("user_id");
CREATE UNIQUE INDEX "meeting_shares_meeting_id_user_id_key" ON "meeting_shares"("meeting_id", "user_id");

ALTER TABLE "meeting_shares" ADD CONSTRAINT "meeting_shares_meeting_id_fkey"
    FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_shares" ADD CONSTRAINT "meeting_shares_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_shares" ADD CONSTRAINT "meeting_shares_granted_by_id_fkey"
    FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
