#!/usr/bin/env node
/**
 * 飞书打点脚本（只读）
 *
 * 用法（PowerShell）：
 *   $env:FEISHU_APP_ID="cli_xxx"
 *   $env:FEISHU_APP_SECRET="xxx"
 *   node scripts/spike/feishu.mjs
 *
 * 它回答三个问题：
 *   1. 应用凭证是否可用（能不能拿到 tenant_access_token）
 *   2. 通讯录权限是否开通（能不能读到部门/用户）
 *   3. 会议与妙记接口是否可达（能不能拿到会议列表、录制、转写）
 *
 * ⚠️ 判断标准：
 *   - 99991672 / 99991663 之类 = 权限没申请或被拒 → 这才是打点要记的结论
 *   - 404 / 400    = 路径或参数不对（API 版本演进过，路径以官方文档为准）
 *   两者含义完全不同，不要混为一谈。
 */

import { createReport, mask, requestJson } from './lib/probe.mjs';

const APP_ID = process.env.FEISHU_APP_ID ?? '';
const APP_SECRET = process.env.FEISHU_APP_SECRET ?? '';
const BASE = (process.env.FEISHU_BASE ?? 'https://open.feishu.cn').replace(/\/$/, '');

/** 只读探针：每一项的失败原因就是这次打点最重要的产出 */
const PROBES = [
  // 通讯录：department_id=0 表示根部门
  ['通讯录-根部门用户', '/open-apis/contact/v3/users/find_by_department?department_id=0&page_size=1'],
  // 会议：列表接口路径随版本变动，404 说明要查最新文档，不是没权限
  ['会议-列表', '/open-apis/vc/v1/meetings?page_size=1'],
  ['会议-房间列表', '/open-apis/vc/v1/rooms?page_size=1'],
  // 妙记：转写文本在这里，权限通常要单独申请
  ['妙记-列表', '/open-apis/minutes/v1/minutes?page_size=1'],
];

async function main() {
  if (!APP_ID || !APP_SECRET) {
    console.error('缺少环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET');
    return 2;
  }

  const report = createReport('feishu');

  /** ① 应用凭证 → tenant_access_token（有效期 2h，生产环境必须缓存） */
  const tokenRes = await requestJson(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });

  const token = tokenRes.body?.tenant_access_token;
  report.add('tenant_access_token', tokenRes);

  console.log(`tenant_access_token = ${mask(token)}`);
  console.log(`expire = ${tokenRes.body?.expire ?? '-'} 秒`);

  if (!token) {
    report.print();
    return 1;
  }

  /** ② 逐个探针 */
  for (const [name, path] of PROBES) {
    const res = await requestJson(`${BASE}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });

    report.add(name, res);
  }

  report.print();

  /**
   * ③ 录制相关的接口需要具体 meeting_id，无法盲探。
   *    拿到一次真实会议后，把 id 填进来再跑：
   *      $env:FEISHU_MEETING_ID="xxx"
   */
  const meetingId = process.env.FEISHU_MEETING_ID;

  if (meetingId) {
    const detail = await requestJson(`${BASE}/open-apis/vc/v1/meetings/${meetingId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    report.add('会议-详情', detail);

    const recording = await requestJson(
      `${BASE}/open-apis/vc/v1/meetings/${meetingId}/recording`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    report.add('会议-录制', recording);

    report.print();
  }

  return report.failedCount > 0 ? 1 : 0;
}

// 不使用 process.exit()：在 Windows + undici 下，带未关闭的 keep-alive 连接强退
// 会触发 libuv 断言（0xC0000409）。设置 exitCode 让事件循环自然退出更稳。
process.exitCode = await main();
