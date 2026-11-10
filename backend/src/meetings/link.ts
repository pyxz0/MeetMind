import { BadRequestException } from '@nestjs/common';

/**
 * 手动填写的入会信息。
 *
 * 用腾讯会议 OpenAPI 自动建会需要商业版（约 1 万/年），
 * 多数场景其实是「用户自己在腾讯会议建会，把会议号贴进来」——
 * 这两个函数就是给这条路径兜底的。
 */

/** 会议号：腾讯会议是 9-11 位数字，用户常常带空格或短横线 */
export const normalizeMeetingCode = (raw?: string | null): string | null => {
  const cleaned = (raw ?? '').replace(/[\s-]/g, '');

  if (!cleaned) {
    return null;
  }

  if (!/^\d{9,11}$/.test(cleaned)) {
    throw new BadRequestException('会议号应为 9-11 位数字');
  }

  return cleaned;
};

/**
 * 入会链接。
 *
 * 必须校验协议：这个值会被前端直接拿去打开新窗口，
 * 放任 `javascript:` 这类伪协议等于白送一个 XSS 入口。
 */
export const normalizeJoinUrl = (raw?: string | null): string | null => {
  const value = (raw ?? '').trim();

  if (!value) {
    return null;
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException('入会链接格式不正确');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException('入会链接必须以 http:// 或 https:// 开头');
  }

  // 与 schema 的 VarChar(512) 对齐
  return value.slice(0, 512);
};

export interface JoinInfo {
  /** 纯数字会议号（分隔符已去掉） */
  code: string | null;
  /** http/https 入会链接 */
  joinUrl: string | null;
}

/** 从文本里挑出网址；中文标点要排除，否则「链接，」会把逗号吃进去 */
const URL_PATTERN = /https?:\/\/[^\s<>"'，。、；：）】」》]+/i;

/**
 * 会议号前的标签，覆盖邀请文本里的常见写法：
 *   #腾讯会议：498-330-226
 *   会议号：498 330 226
 *   会议 ID: 498330226
 */
const CODE_LABEL_PATTERN =
  /(?:腾讯会议号?|会议号|会议\s*ID|Meeting\s*ID)\s*[:：#]?\s*(\d[\d\s-]{7,13}\d)/i;

/** 客户端入会 scheme —— 用户可能从别处直接复制这条 */
const WEMEET_SCHEME_PATTERN = /wemeet:\/\/[^\s]*meeting_code=(\d{9,11})/i;

/** 链接本身带会议号的情况（少见，但解析成本为零） */
const CODE_IN_URL_PATTERN = /[?&](?:meeting_code|meetingCode|code)=(\d{9,11})/i;

/**
 * 解析用户粘贴的一坨东西。
 *
 * 实际场景里没人只贴一个干净的会议号 —— 大多是微信里复制来的整段邀请：
 *
 *   张三 邀请你加入腾讯会议
 *   点击链接直接加入会议：
 *   https://meeting.tencent.com/dm/AbCd1234
 *   #腾讯会议：498-330-226
 *
 * 让人自己从里面抠出会议号再分两次填，是没必要的负担。
 */
export const parseJoinInput = (raw?: string | null): JoinInfo => {
  const text = (raw ?? '').trim();

  if (!text) {
    return { code: null, joinUrl: null };
  }

  const scheme = text.match(WEMEET_SCHEME_PATTERN);
  const urlMatch = text.match(URL_PATTERN);
  const joinUrl = urlMatch ? normalizeJoinUrl(urlMatch[0]) : null;

  // 先把链接抠掉再找号，否则可能从 dm 串或参数里挖出一串数字当会议号
  const rest = urlMatch ? text.replace(urlMatch[0], ' ') : text;

  let code: string | null = null;

  if (scheme) {
    code = scheme[1];
  } else {
    const labeled = rest.match(CODE_LABEL_PATTERN);

    if (labeled) {
      code = normalizeMeetingCode(labeled[1]);
    } else if (/^\s*\d[\d\s-]*$/.test(rest)) {
      // 整段就是个号码，允许带空格和短横线
      // 必须至少含一个数字：链接被抠掉后 rest 可能只剩空白
      code = normalizeMeetingCode(rest);
    } else {
      /**
       * 单独一行的纯号码。
       *
       * 编辑会议时前端会把链接和会议号分两行回填，
       * 带上「会议号：」这种标签反而显得多余。
       * 只认「整行只有数字/空格/短横线」的行，避免误伤别的数字。
       */
      const lineCode = rest
        .split('\n')
        .map((line) => line.trim())
        .find((line) => /^\d[\d\s-]{7,13}$/.test(line));

      if (lineCode) {
        code = normalizeMeetingCode(lineCode);
      } else if (joinUrl) {
        code = joinUrl.match(CODE_IN_URL_PATTERN)?.[1] ?? null;
      }
    }
  }

  if (!code && !joinUrl) {
    throw new BadRequestException('没认出会议号或入会链接，请检查后重试');
  }

  return { code, joinUrl };
};
