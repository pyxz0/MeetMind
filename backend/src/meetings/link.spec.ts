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
import {
  normalizeJoinUrl,
  normalizeMeetingCode,
  parseJoinInput,
} from './link';

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

describe('parseJoinInput', () => {
  it('只贴会议号', () => {
    expect(parseJoinInput('498330226')).toEqual({
      code: '498330226',
      joinUrl: null,
    });
    expect(parseJoinInput('498 330 226')).toEqual({
      code: '498330226',
      joinUrl: null,
    });
  });

  it('只贴链接', () => {
    expect(parseJoinInput('https://meeting.tencent.com/dm/AbCd1234')).toEqual({
      code: null,
      joinUrl: 'https://meeting.tencent.com/dm/AbCd1234',
    });
  });

  /** 主场景：微信里复制来的整段邀请 */
  it('从整段邀请文本里同时取出链接和会议号', () => {
    const invite = [
      '张三 邀请你加入腾讯会议',
      '会议主题：季度复盘',
      '',
      '点击链接直接加入会议：',
      'https://meeting.tencent.com/dm/AbCd1234',
      '',
      '#腾讯会议：498-330-226',
    ].join('\n');

    expect(parseJoinInput(invite)).toEqual({
      code: '498330226',
      joinUrl: 'https://meeting.tencent.com/dm/AbCd1234',
    });
  });

  it('认识「会议号：」和「会议 ID:」两种标签', () => {
    expect(parseJoinInput('会议号：498 330 226').code).toBe('498330226');
    expect(parseJoinInput('会议 ID: 498330226').code).toBe('498330226');
  });

  it('识别客户端 scheme，并且不把它当成 http 链接', () => {
    expect(
      parseJoinInput('wemeet://page/inmeeting?meeting_code=498330226'),
    ).toEqual({ code: '498330226', joinUrl: null });
  });

  it('链接自带 meeting_code 时也能取到号', () => {
    expect(
      parseJoinInput(
        'https://meeting.tencent.com/w/join?meeting_code=498330226',
      ),
    ).toEqual({
      code: '498330226',
      joinUrl: 'https://meeting.tencent.com/w/join?meeting_code=498330226',
    });
  });

  /** 链接里那段 dm 串是字母数字混合，不能被当成会议号 */
  it('不会从 dm 串里挖数字当会议号', () => {
    expect(
      parseJoinInput('https://meeting.tencent.com/dm/AbCd1234').code,
    ).toBeNull();
  });

  it('链接末尾的中文标点不算进链接', () => {
    expect(parseJoinInput('点击 https://meeting.tencent.com/dm/AbCd1234，即可入会')).toEqual({
      code: null,
      joinUrl: 'https://meeting.tencent.com/dm/AbCd1234',
    });
  });

  it('链接和会议号分两行时都能取到', () => {
    // 编辑会议时前端就是这么回填的：链接一行、号码一行，不带标签
    expect(
      parseJoinInput('https://meeting.tencent.com/dm/AbCd1234\n498 330 226'),
    ).toEqual({
      code: '498330226',
      joinUrl: 'https://meeting.tencent.com/dm/AbCd1234',
    });
  });

  it('认不出任何东西时给中文提示', () => {
    expect(() => parseJoinInput('下午三点开会')).toThrow(BadRequestException);
    expect(() => parseJoinInput('12345')).toThrow(BadRequestException);
  });

  it('空值返回两个 null，表示清空', () => {
    expect(parseJoinInput('')).toEqual({ code: null, joinUrl: null });
    expect(parseJoinInput('   ')).toEqual({ code: null, joinUrl: null });
    expect(parseJoinInput(undefined)).toEqual({ code: null, joinUrl: null });
  });
});
