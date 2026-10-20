import { existsSync, readFileSync } from 'node:fs';
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * 兼容两种环境变量位置。
 *
 * 仓库把配置统一放在根目录 `.env`，但 Prisma CLI 在 `backend/` 下执行时
 * 只会读当前目录的 `.env`。这里在缺失时回退读上一级，
 * 让 CLI 与后端运行时（ConfigModule 的 envFilePath）遵循同一套规则。
 */
function loadEnvFallback() {
  if (process.env.DATABASE_URL) {
    return;
  }

  const candidates = ['.env', '../.env'];

  for (const file of candidates) {
    if (!existsSync(file)) {
      continue;
    }

    const text = readFileSync(file, 'utf8');

    for (const rawLine of text.split(/\r?\n/)) {
      const match = rawLine.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);

      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }

    if (process.env.DATABASE_URL) {
      return;
    }
  }
}

loadEnvFallback();

// Prisma 7 将连接串放在配置文件中；模型文件只声明数据库类型和数据结构。
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
