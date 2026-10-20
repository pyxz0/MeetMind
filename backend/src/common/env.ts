/**
 * 启动期环境变量校验。
 *
 * 目的：缺少关键变量时立刻失败并说明缺哪个，
 * 而不是等到第一个请求才 500（例如 JWT_SECRET 缺失会让登录直接崩）。
 */
export function validateEnv(config: Record<string, unknown>) {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter((key) => {
    const value = config[key];

    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim() === '';

    return false;
  });

  if (missing.length) {
    throw new Error(
      `缺少必需的环境变量：${missing.join(', ')}。请参考仓库根目录的 .env.example`,
    );
  }

  return config;
}