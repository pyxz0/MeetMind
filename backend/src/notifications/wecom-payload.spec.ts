import {
  buildWeComBody,
  filterMentionMobiles,
  isMentionableMobile,
  isWeComSuccess,
  truncateByBytes,
} from './wecom-payload';

/**
 * 企微群机器人最容易踩的三个坑：字节截断、@手机号脏数据、HTTP 200 但 errcode 报错。
 * 这三个都在这层收口，service 只负责发请求。
 */
describe('wecom-payload', () => {
  describe('手机号过滤', () => {
    it('只保留 11 位大陆手机号', () => {
      expect(isMentionableMobile('13800000001')).toBe(true);
      expect(isMentionableMobile('1380000000')).toBe(false);
      expect(isMentionableMobile('23800000001')).toBe(false);
      expect(isMentionableMobile('+8613800000001')).toBe(false);
    });

    it('过滤脏数据并去重', () => {
      expect(
        filterMentionMobiles([
          '13800000001',
          'bad',
          '13800000001',
          '',
          '13900000002',
        ]),
      ).toEqual(['13800000001', '13900000002']);
    });
  });

  describe('按字节截断', () => {
    it('短内容原样返回', () => {
      expect(truncateByBytes('逾期 3 条')).toBe('逾期 3 条');
    });

    it('长中文内容截到 4096 字节以内并带提示', () => {
      const result = truncateByBytes('逾'.repeat(2000));

      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(4096);
      expect(result.endsWith('（内容过长已截断）')).toBe(true);
    });

    it('不会把一个多字节字符截成半截', () => {
      const result = truncateByBytes('a' + '逾'.repeat(2000))
      const body = result.replace(/\n\n…（内容过长已截断）$/, '')

      // 去掉提示后必须是完整字符序列：能被顺利解码就说明没截断半个字
      expect(Buffer.from(body, 'utf8').toString('utf8')).toBe(body);
    });
  });

  describe('请求体', () => {
    it('结构固定为 markdown', () => {
      const body = buildWeComBody('**标题**', ['13800000001']);

      expect(body.msgtype).toBe('markdown');
      expect(body.markdown.content).toBe('**标题**');
      expect(body.markdown.mentioned_mobile_list).toEqual(['13800000001']);
    });

    it('不传手机号时列表为空，只发消息不 @ 人', () => {
      expect(buildWeComBody('x').markdown.mentioned_mobile_list).toEqual([]);
    });
  });

  describe('成功判定', () => {
    it('HTTP 200 且 errcode=0 才算成功', () => {
      expect(isWeComSuccess(200, { errcode: 0 })).toBe(true);
    });

    it('HTTP 200 但 errcode 非 0 视为失败', () => {
      expect(isWeComSuccess(200, { errcode: 93000 })).toBe(false);
    });

    it('非 2xx 一律失败', () => {
      expect(isWeComSuccess(500, { errcode: 0 })).toBe(false);
    });

    it('空响应体按 HTTP 状态判断', () => {
      expect(isWeComSuccess(200, null)).toBe(true);
      expect(isWeComSuccess(502, null)).toBe(false);
    });
  });
});
