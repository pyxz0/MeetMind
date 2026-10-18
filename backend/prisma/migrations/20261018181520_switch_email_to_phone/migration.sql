/*
  登录标识由邮箱改为手机号。

  改动内容：
    users.email（唯一）  ->  users.phone（唯一）

  为什么手写而不让 Prisma 自动生成：
  Prisma 会先删列再加非空列，存量数据会直接丢失；
  这里改为「加可空列 -> 回填 -> 收紧非空 -> 删旧列」的安全顺序。

  回填规则：
    1. 种子超级管理员（admin@meetmind.local）
       -> 13800000000，与 README 中记录的初始账号保持一致，
          保证全新部署按 README 仍能登录
    2. 其余账号（含旧数据）
       -> 11 位占位号 '1' + 补零的 id，仅保证唯一非空。
          这些账号需要由超级管理员在「用户管理」里改成真实手机号，
          在此之前无法用手机号登录。

  注意：本仓库不写入真实个人手机号，避免 PII 进入 git 历史。
*/

-- 1. 新增可空列
ALTER TABLE "users" ADD COLUMN "phone" VARCHAR(20);

-- 2. 回填：种子账号使用文档中公布的默认手机号
UPDATE "users"
SET "phone" = '13800000000'
WHERE "email" = 'admin@meetmind.local';

-- 3. 回填：其余账号给唯一占位号（'1' + 10 位补零 id = 11 位）
UPDATE "users"
SET "phone" = '1' || lpad("id"::text, 10, '0')
WHERE "phone" IS NULL;

-- 4. 收紧为非空并建立唯一约束（索引名遵循 Prisma 的 @unique 命名约定）
ALTER TABLE "users" ALTER COLUMN "phone" SET NOT NULL;
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- 5. 删除旧列（其唯一索引 users_email_key 随列一并删除）
ALTER TABLE "users" DROP COLUMN "email";
