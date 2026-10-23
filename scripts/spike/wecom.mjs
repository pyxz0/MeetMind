#!/usr/bin/env node
/**
 * 企业微信打点脚本（只读）
 *
 * 企业微信有两条完全不同的接入路径，先确认你在哪条：
 *
 *   A. 自建应用（只装在自己企业，不需要上架）
 *      → 只需要 corpid + corpsecret，1 分钟能拿到 access_token
 *      → 用法：$env:WECOM_CORP_ID / $env:WECOM_CORP_SECRET
 *
 *   B. 第三方应用（上架应用市场）
 *      → 需要 suite_id + suite_secret + suite_ticket
 *      → suite_ticket 只能由**服务端每 10 分钟被推送一次**，脚本自己拿不到；
 *        必须先把回调跑通、把 ticket 存下来，再本机读出来喂给这个脚本
 *      → 用法：$env:WECOM_SUITE_ID / $env:WECOM_SUITE_SECRET / $env:WECOM_SUITE_TICKET
 *
 * 建议先跑 A：能立刻验证"凭证可用 + 权限开通到什么程度"，
 * 而 B 的授权模型坑位（permanent_code、corp_access_token）留到真接入时再踩。
 */

import { createReport, mask, requestJson } from './lib/probe.mjs';

const BASE = (process.env.WECOM_BASE ?? 'https://qyapi.weixin.qq.com').replace(/\/$/, '');

const CORP_ID = process.env.WECOM_CORP_ID ?? '';
const CORP_SECRET = process.env.WECOM_CORP_SECRET ?? '';

const SUITE_ID = process.env.WECOM_SUITE_ID ?? '';
const SUITE_SECRET = process.env.WECOM_SUITE_SECRET ?? '';
const SUITE_TICKET = process.env.WECOM_SUITE_TICKET ?? '';

async function main() {
  const report = createReport('wecom');
  let accessToken = '';

  if (CORP_ID && CORP_SECRET) {
    /** A. 自建应用：直接换 access_token */
    const res = await requestJson(
      `${BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(CORP_ID)}&corpsecret=${encodeURIComponent(CORP_SECRET)}`,
    );

    accessToken = res.body?.access_token ?? '';
    report.add('A-自建应用 access_token', res);
    console.log(`access_token = ${mask(accessToken)}  expire=${res.body?.expires_in ?? '-'}s`);
  } else if (SUITE_ID && SUITE_SECRET && SUITE_TICKET) {
    /** B. 第三方应用：suite_ticket 换 suite_access_token */
    const res = await requestJson(`${BASE}/cgi-bin/service/get_suite_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        suite_id: SUITE_ID,
        suite_secret: SUITE_SECRET,
        suite_ticket: SUITE_TICKET,
      }),
    });

    accessToken = res.body?.suite_access_token ?? '';
    report.add('B-第三方 suite_access_token', res);
    console.log(`suite_access_token = ${mask(accessToken)}  expire=${res.body?.expires_in ?? '-'}s`);
  } else {
    console.error(
      '缺少凭证：要么给 WECOM_CORP_ID + WECOM_CORP_SECRET（自建应用），' +
        '要么给 WECOM_SUITE_ID + WECOM_SUITE_SECRET + WECOM_SUITE_TICKET（第三方应用）',
    );
    return 2;
  }

  if (!accessToken) {
    report.print();
    return 1;
  }

  /** 只读探针：失败原因（尤其 errcode 60011 / 48002）就是结论 */
  const probes = [
    ['通讯录-部门列表', `/cgi-bin/department/list?access_token=${accessToken}`],
    ['通讯录-成员列表', `/cgi-bin/user/list?access_token=${accessToken}&department_id=1`],
    // 会议相关接口需要「会议」权限与相应版本，打点就是确认这条到底通不通
    ['会议-预约列表', `/cgi-bin/meeting/meeting_list?access_token=${accessToken}`],
  ];

  for (const [name, path] of probes) {
    const res = await requestJson(`${BASE}${path}`);
    report.add(name, res);
  }

  report.print();

  return report.failedCount > 0 ? 1 : 0;
}

// 不用 process.exit()：Windows + undici 下强退会触发 libuv 断言
process.exitCode = await main();
