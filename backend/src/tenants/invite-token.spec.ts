import {
  INVITE_TTL_DAYS,
  createInviteToken,
  hashInviteToken,
  maskPhone,
} from './invite-token';

describe('createInviteToken', () => {
  it('生成的令牌是 URL 安全的，不需要额外转义', () => {
    const token = createInviteToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('32 字节熵：base64url 编码后 43 个字符', () => {
    expect(createInviteToken()).toHaveLength(43);
  });

  it('每次都不一样', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => createInviteToken()));

    expect(tokens.size).toBe(50);
  });
});

describe('hashInviteToken', () => {
  it('同一令牌哈希稳定（否则接受时匹配不上）', () => {
    const token = createInviteToken();

    expect(hashInviteToken(token)).toBe(hashInviteToken(token));
  });

  it('是 sha256 十六进制，长度 64', () => {
    expect(hashInviteToken(createInviteToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('不同令牌不会撞哈希', () => {
    expect(hashInviteToken('a')).not.toBe(hashInviteToken('b'));
  });
});

describe('maskPhone', () => {
  it('保留前三后四', () => {
    expect(maskPhone('13812348888')).toBe('138****8888');
  });

  it('长度不是 11 位时原样返回，不做猜测性截断', () => {
    expect(maskPhone('12345')).toBe('12345');
  });
});

describe('INVITE_TTL_DAYS', () => {
  it('是 7 天 —— 太短来不及转达，太长等于长期后门', () => {
    expect(INVITE_TTL_DAYS).toBe(7);
  });
});
