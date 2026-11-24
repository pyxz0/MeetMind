/**
 * 当前进程是不是「0 号 worker」。
 *
 * 多进程之后每个 worker 都会完整启动一遍 Nest，定时任务（邮件轮询、
 * 逾期提醒）如果各自都跑，用户会收到重复邮件 —— 邮件不像站内消息，
 * 发出去就收不回来。
 *
 * 所以约定：只有 0 号 worker 跑定时任务。判定放在这里而不是散在各处，
 * 是为了让「为什么这个进程不跑定时器」只有一处答案。
 *
 * 未设置 APP_WORKER_INDEX 表示单进程运行（本地开发、或 APP_WORKERS=1），
 * 此时它就是唯一进程，应该跑。
 */
export const isSchedulerWorker = (
  index: string | undefined = process.env.APP_WORKER_INDEX,
): boolean => index === undefined || index === '' || index === '0';
