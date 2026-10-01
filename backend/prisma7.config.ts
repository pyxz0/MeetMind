import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma 7 将连接串放在配置文件中；模型文件只声明数据库类型和数据结构。
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
