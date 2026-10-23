#!/usr/bin/env node
/**
 * 腾讯会议打点脚本（只读）
 *
 * 用法（PowerShell）：
 *   $env:TENCENT_APP_ID="..."
 *   $env:TENCENT_SDK_ID="..."
 *   $env:TENCENT_SECRET_KEY="..."
 *   $env:TENCENT_USER_ID="admin@example.com"   # 企管员的 userid，查询会议列表要用
 *   node scripts/spike/tencent.mjs
 *
 * ⚠️ 签名算法在不同版本文档里表述不一（hex / base64 两种编码都出现过），
 *    所以这里把两种都算出来打印，脚本默认用 base64。
 *    如果返回签名错误，先改 TENCENT_SIGNATURE_ENCODING=hex 再试一次，
 *    两次都失败再去核对文档——这一步必须做，否则后面所有调用都会 401。
 *
 * 打点要回答的问题：
 *   1. 签名是否算对（能不能过鉴权）
 *   2. 能不能列出企业内的会议
 *   3. 能不能拿到录制列表 / 下载地址（这是内容获取的唯一入口）
 *   4. 录制转写文本是否可得（取决于版本与开通项）
 */

import { createHmac } from 'node:crypto';
import { createReport, requestJson } from './lib/probe.mjs';

const APP_ID = process.env.TENCENT_APP_ID ?? '';
const SDK_ID = process.env.TENCENT_SDK_ID ?? '';
const SECRET_KEY = process.env.TENCENT_SECRET_KEY ?? '';
const USER_ID = process.env.TENCENT_USER_ID ?? '';
const ENCODING = (process.env.TENCENT_SIGNATURE_ENCODING ?? 'base64').toLowerCase();
const BASE = (process.env.TENCENT_BASE ?? 'https://api.meeting.tencent.com').replace(/\/$/, '');

/** 按五元组生成签名头；body 必须与实际发出的字节完全一致 */
function buildHeaders(body = '') {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = Math.floor(Math.random() * 1e9).toString();

  const payload = `${APP_ID}${SDK_ID}${timestamp}${nonce}${body}`;
  const hex = createHmac('sha256', SECRET_KEY).update(payload).digest('hex');
  const b64 = createHmac('sha256', SECRET_KEY).update(payload).digest('base64');

  return {
    hex,
    b64,
    headers: {
      AppId: APP_ID,
      SdkId: SDK_ID,
      Timestamp: timestamp,
      Nonce: nonce,
      Signature: ENCODING === 'hex' ? hex : b64,
      'content-type': 'application/json; charset=utf-8',
    },
  };
}

async function main() {
  if (!APP_ID || !SDK_ID || !SECRET_KEY) {
    console.error('缺少环境变量 TENCENT_APP_ID / TENCENT_SDK_ID / TENCENT_SECRET_KEY');
    return 2;
  }

  const report = createReport('tencent');

  const built = buildHeaders('');
  console.log(`签名编码 = ${ENCODING}`);
  console.log(`  base64 = ${built.b64}`);
  console.log(`  hex    = ${built.hex}`);

  /** ① 会议列表：验证签名 + 企业级读权限 */
  const listPath = USER_ID
    ? `/v1/meetings?userid=${encodeURIComponent(USER_ID)}&instanceid=1`
    : '/v1/meetings?instanceid=1';

  report.add('会议-列表', await requestJson(`${BASE}${listPath}`, { headers: buildHeaders('').headers }));

  /** ② 录制列表：拿到一次云录制之后才能查 */
  report.add('录制-列表', await requestJson(`${BASE}/v1/records`, { headers: buildHeaders('').headers }));

  report.print();

  console.log(
    [
      '下一步：',
      '  1. 若「会议-列表」返回签名错误 → 改 TENCENT_SIGNATURE_ENCODING=hex 重跑。',
      '  2. 若返回权限错误 → 确认企业管理员已授权该应用。',
      '  3. 「录制-列表」为 200 且带下载地址时，立刻验证：地址有有效期吗？能直接用 curl 下载吗？',
      '  4. 录制里有转写文本 → 走第 1 级降级链；只有音频 → 必须自建 ASR（第 2 级）。',
    ].join('\n'),
  );

  return report.failedCount > 0 ? 1 : 0;
}

// 不用 process.exit()：Windows + undici 下强退会触发 libuv 断言
process.exitCode = await main();
