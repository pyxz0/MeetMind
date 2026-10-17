/*
  对齐 users.updated_at 的数据库默认值。

  建表迁移里为了插入种子账号，给 updated_at 加了 DEFAULT CURRENT_TIMESTAMP，
  但 schema.prisma 用的是 Prisma 的 @updatedAt（应用层赋值），
  并不声明数据库默认值，于是库与 schema 之间出现永久差异，
  以后每次生成迁移都会附带一条无关的 DROP DEFAULT。

  这里去掉默认值，让数据库与 schema 完全一致。
  Prisma 写入时始终会显式赋值 updated_at，去掉默认值不影响功能。
*/

ALTER TABLE "users" ALTER COLUMN "updated_at" DROP DEFAULT;
