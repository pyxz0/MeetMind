import cluster from 'node:cluster';

/**
 * 多进程入口。
 *
 * 为什么需要：Node 是单线程的，一个进程只能用满一个核。这台机器 2 核，
 * 压测时读接口在 50 并发下已经到 189 req/s 而 CPU 只用了约 1 核 ——
 * 第二个核被浪费了。开两个 worker 能吃满，同时把「登录算哈希」这类
 * CPU 密集操作关在各自的事件循环里，不会互相卡住。
 *
 * APP_WORKERS 默认 1（不 fork），生产由 compose 设成 2。
 * 本地开发保持单进程，调试时不会有「改一次代码起两个进程」的困扰。
 */
const requested = Number(process.env.APP_WORKERS ?? 1);
const workers =
  Number.isFinite(requested) && requested > 1 ? Math.floor(requested) : 1;

if (workers > 1 && cluster.isPrimary) {
  // eslint-disable-next-line no-console
  console.log(`[cluster] 主进程 ${process.pid} 启动 ${workers} 个 worker`);

  /**
   * 记录 worker.id → 序号。
   *
   * 序号决定「谁跑定时任务」（0 号），所以重启时必须沿用原来的序号：
   * 否则 0 号挂掉后被补成 1 号，就再没人跑定时任务了。
   */
  const indexes = new Map<number, number>();

  const spawn = (index: number) => {
    const worker = cluster.fork({ APP_WORKER_INDEX: String(index) });

    indexes.set(worker.id, index);

    return worker;
  };

  for (let i = 0; i < workers; i += 1) {
    spawn(i);
  }

  let shuttingDown = false;

  cluster.on('exit', (worker, code, signal) => {
    // 主动停止时不要补进程，否则会出现「越关越多」的假象
    if (shuttingDown) {
      return;
    }

    const index = indexes.get(worker.id) ?? 0;

    indexes.delete(worker.id);

    // eslint-disable-next-line no-console
    console.error(
      `[cluster] worker ${worker.process.pid} 退出（code=${code} signal=${signal}），按 ${index} 号重启`,
    );

    spawn(index);
  });

  /**
   * 容器停止时 docker 发的是 SIGTERM，默认不会转发给 worker。
   * 不处理就会被等满 stop_grace_period 再 SIGKILL，
   * 表现是「每次部署都要多等十几秒」。
   */
  const shutdown = (signal: string) => {
    shuttingDown = true;

    // eslint-disable-next-line no-console
    console.log(`[cluster] 收到 ${signal}，关闭所有 worker`);

    for (const worker of Object.values(cluster.workers ?? {})) {
      worker?.kill();
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
} else {
  // 单进程模式也走这里，保证 `node dist/cluster.js` 在任何配置下都能起服务。
  // 用 import() 而不是顶层 import：顶层导入会让主进程也执行一遍 bootstrap。
  void import('./main.js');
}
