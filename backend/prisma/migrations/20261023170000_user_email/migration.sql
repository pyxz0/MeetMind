-- 绑定邮箱：自助找回密码的接收地址。
--
-- 唯一约束而不是普通索引：一个邮箱只能对应一个账号，
-- 否则同一邮箱会收到多条重置链接，用户不知道点哪个，
-- 也会把「谁绑了哪个邮箱」变成可枚举的信息。
--
-- 允许 NULL：老账号与不愿绑定的用户保持原状，找回密码仍需管理员发链接。

ALTER TABLE "users" ADD COLUMN "email" VARCHAR(160);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
