-- 密码重置：一次性令牌 + 令牌版本
--
-- 为什么不用「管理员直接设新密码」：那样管理员会知道用户的明文密码，
-- 也无法证明是本人操作的。改成一次性链接后，管理员只负责核实身份，
-- 新密码只有本人知道。
--
-- token_version 用于让旧 JWT 立即失效：重置密码后自增，
-- 守卫发现令牌里的 tv 与库中不一致就拒绝（详见 jwt-auth.guard.ts）。

ALTER TABLE "users"
  ADD COLUMN "password_reset_token_hash" VARCHAR(64),
  ADD COLUMN "password_reset_expires_at" TIMESTAMPTZ(3),
  ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;
