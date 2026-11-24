import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';
import * as bcrypt from 'bcryptjs';

/**
 * promisify 的类型推断只认三参数重载，带 options 的调用会被 TS 拒掉，
 * 这里显式给出四参数签名。
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * 密码哈希。scrypt 放在这里而不是 auth.service 里，有两个原因：
 *
 * 1. **不能阻塞事件循环**。之前用的 bcryptjs 是纯 JS 实现，代价因子 12 时
 *    单次约 270ms，而且 `await` 并不能让它并行 —— 实测 4 个并发登录耗时
 *    923ms，等于一个人登录时全站请求都停在原地。`crypto.scrypt` 的异步版
 *    走 libuv 线程池，事件循环照常处理其它请求。
 * 2. **纯函数好测**。项目的 jest 环境加载不了 @nestjs/common，所以凡是
 *    需要测试的逻辑都得跟框架解耦（同 deadline.ts / rate-limit 的做法）。
 *
 * 格式：`scrypt$N$r$p$<salt base64url>$<hash base64url>`
 * 兼容历史的 bcrypt 哈希（`$2a$` / `$2b$`）：老用户照常登录，
 * 登录成功后由 AuthService 顺手升级成 scrypt。
 */

/** N=2^15、r=8、p=1：约 32MB 内存 / 100ms，与 bcrypt cost 12 强度相当 */
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/**
 * scrypt 需要 128*N*r ≈ 33.5MB，默认 maxmem 只有 32MB 会直接报错。
 * 给到 64MB 留余量；线程池默认 4 个线程，峰值约 250MB，2G 机器扛得住。
 */
const MAX_MEM = 64 * 1024 * 1024;

const PREFIX = 'scrypt';

/** 参数上限：数据库里的哈希若被篡改成天文数字，不能让一次登录把内存吃光 */
const LIMITS = {
  n: 2 ** 20,
  r: 32,
  p: 8,
  keyLength: 256,
};

const isLegacyHash = (stored: string): boolean =>
  stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$');

/** 生成哈希。注册、改密、重置密码三处共用，保证格式一致 */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_LENGTH);
  const key = (await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  })) as Buffer;

  return [
    PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
};

const verifyScrypt = async (password: string, stored: string): Promise<boolean> => {
  const [prefix, n, r, p, saltText, hashText] = stored.split('$');

  if (prefix !== PREFIX || !saltText || !hashText) {
    return false;
  }

  const params = { N: Number(n), r: Number(r), p: Number(p) };

  if (
    !Number.isInteger(params.N) ||
    !Number.isInteger(params.r) ||
    !Number.isInteger(params.p) ||
    params.N < 2 ||
    params.r < 1 ||
    params.p < 1 ||
    params.N > LIMITS.n ||
    params.r > LIMITS.r ||
    params.p > LIMITS.p
  ) {
    return false;
  }

  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(hashText, 'base64url');

  if (expected.length < 16 || expected.length > LIMITS.keyLength) {
    return false;
  }

  try {
    const actual = (await scrypt(password, salt, expected.length, {
      ...params,
      maxmem: MAX_MEM,
    })) as Buffer;

    // 定长比较，避免按字节提前返回泄露信息
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};

/**
 * 校验密码。历史 bcrypt 哈希走老路径，其余走 scrypt。
 *
 * 任何异常都当成「不匹配」而不是向上抛：哈希格式坏掉不该让登录接口 500，
 * 否则攻击者能靠报错差异判断某个账号的哈希是否异常。
 */
export const verifyPassword = async (
  password: string,
  stored: string | null | undefined,
): Promise<boolean> => {
  if (!stored) {
    return false;
  }

  if (isLegacyHash(stored)) {
    try {
      return await bcrypt.compare(password, stored);
    } catch {
      return false;
    }
  }

  return verifyScrypt(password, stored);
};

/** 是否需要在本次登录成功后重算哈希（老 bcrypt 用户透明升级） */
export const needsRehash = (stored: string | null | undefined): boolean =>
  !!stored && isLegacyHash(stored);
