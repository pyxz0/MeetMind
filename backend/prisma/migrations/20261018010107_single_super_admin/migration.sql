/*
  超级管理员唯一性约束。

  业务规则：系统全局只能有一个超级管理员（SUPER_ADMIN）。

  应用层已经在 UsersService 里挡住「创建/提升第二个超管」以及
  「降级/停用/删除唯一超管」，本迁移补数据库层兜底 ——
  即使将来某处代码写错，或有人直接连库改数据，也无法出现两个超管。

  为什么用「部分唯一索引」：
  Prisma schema 无法表达带 WHERE 的唯一索引，因此这里手写 SQL。
  索引建在 role 列上并限定 WHERE role = 'SUPER_ADMIN'，
  效果是「所有超管行的 role 值唯一」，即至多一行超管。

  ⚠️ 维护提示：
  该索引不在 schema.prisma 中，未来用 `prisma migrate dev` 生成新迁移时，
  Prisma 可能提示该索引为「多余」并建议删除。
  请务必保留本索引 —— 删掉它就回到了「应用层单点保证」。

  先做一次防御性收尾：如果某个环境历史上已存在多个超管，
  保留 id 最小的一个，其余降为 ADMIN，否则索引无法创建。
*/

-- 防御性收尾：多超管时保留最早创建的那个
UPDATE "users"
SET "role" = 'ADMIN'
WHERE "role" = 'SUPER_ADMIN'
  AND "id" <> (
    SELECT min("id") FROM "users" WHERE "role" = 'SUPER_ADMIN'
  );

-- 至多一个超级管理员
CREATE UNIQUE INDEX "users_single_super_admin_key"
  ON "users" ("role")
  WHERE "role" = 'SUPER_ADMIN';
