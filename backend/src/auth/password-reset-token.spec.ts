import {
  createResetToken,
  hashResetToken,
  RESET_TOKEN_TTL_MINUTES,
} from './password-reset-token';

describe('密码重置令牌', () => {
  it('哈希是 64 位 hex（sha256），保证库里存不下明文', () => {
    expect(hashResetToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('同一输入哈希稳定，不同令牌不会撞', () => {
    const token = createResetToken();

    expect(hashResetToken(token)).toBe(hashResetToken(token));
    expect(hashResetToken(token)).not.toBe(hashResetToken(createResetToken()));
  });

  it('令牌足够长且互不相同', () => {
    const a = createResetToken();
    const b = createResetToken();

    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).not.toBe(b);
    expect(RESET_TOKEN_TTL_MINUTES).toBe(30);
  });
});
