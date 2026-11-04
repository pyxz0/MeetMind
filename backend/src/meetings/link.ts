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
