/*
  删除账号不应连带删除会议。

  原外键是 ON DELETE CASCADE：删掉一个用户，他创建的所有会议
  （连同决策、待办、录音）都会被静默删除 —— 这是数据丢失风险。

  改为 RESTRICT 后，数据库层面禁止"直接删掉仍有会议的用户"；
  应用层在删除用户前先把其会议转移给操作者（见 UsersService.remove），
  既保住数据，也不会出现"删用户失败"的困惑。
*/

ALTER TABLE "meetings" DROP CONSTRAINT "meetings_owner_id_fkey";

ALTER TABLE "meetings" ADD CONSTRAINT "meetings_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;