/** @nestjs/common 是纯 ESM，Node 22 下 Jest 需要最小 mock（见 job-run.spec） */
jest.mock('@nestjs/common', () => {
  class HttpException extends Error {
    constructor(public readonly response?: unknown) {
      super(String(response));
    }
  }

  return {
    HttpException,
    BadRequestException: class extends HttpException {},
  };
});

import { BadRequestException } from '@nestjs/common';
import { normalizeJoinUrl, normalizeMeetingCode } from './link';

describe('normalizeMeetingCode', () => {
  it('去掉空格和短横线', () => {
    expect(normalizeMeetingCode('123 456 789')).toBe('123456789');
    expect(normalizeMeetingCode('123-456-789')).toBe('123456789');
  });

  it('接受 9 到 11 位数字', () => {
    expect(normalizeMeetingCode('123456789')).toBe('123456789');
    expect(normalizeMeetingCode('1234567890')).toBe('1234567890');
    expect(normalizeMeetingCode('12345678901')).toBe('12345678901');
  });

  it('位数不对时给中文提示', () => {
    expect(() => normalizeMeetingCode('12345678')).toThrow(BadRequestException);
    expect(() => normalizeMeetingCode('123456789012')).toThrow(
      BadRequestException,
    );
  });

  it('非数字直接拒绝', () => {
    expect(() => normalizeMeetingCode('abcdefghi')).toThrow(
      BadRequestException,
    );
  });

  it('空值返回 null，不算错误', () => {
    expect(normalizeMeetingCode('')).toBeNull();
    expect(normalizeMeetingCode('   ')).toBeNull();
    expect(normalizeMeetingCode(null)).toBeNull();
    expect(normalizeMeetingCode(undefined)).toBeNull();
  });
});

describe('normalizeJoinUrl', () => {
  it('接受 https 链接并原样返回', () => {
    const url = 'https://meeting.tencent.com/dm/AbCdEf123';

    expect(normalizeJoinUrl(url)).toBe(url);
  });

  it('http 也放行（内网自建会议可能没有证书）', () => {
    expect(normalizeJoinUrl('http://10.0.0.5:8080/room/1')).toBe(
      'http://10.0.0.5:8080/room/1',
    );
  });

  /** 这条是安全底线：链接会被直接用来打开新窗口 */
  it('拒绝 javascript: 这类伪协议', () => {
    expect(() => normalizeJoinUrl('javascript:alert(1)')).toThrow(
      BadRequestException,
    );
    expect(() => normalizeJoinUrl('data:text/html,<script>1</script>')).toThrow(
      BadRequestException,
    );
  });

  it('没有协议的字符串报错', () => {
    expect(() => normalizeJoinUrl('meeting.tencent.com/dm/abc')).toThrow(
      BadRequestException,
    );
  });

  it('超长链接按 512 截断，与数据库字段对齐', () => {
    const long = `https://meeting.tencent.com/dm/${'a'.repeat(600)}`;

    expect(normalizeJoinUrl(long)).toHaveLength(512);
  });

  it('空值返回 null', () => {
    expect(normalizeJoinUrl('')).toBeNull();
    expect(normalizeJoinUrl('  ')).toBeNull();
    expect(normalizeJoinUrl(undefined)).toBeNull();
  });
});
