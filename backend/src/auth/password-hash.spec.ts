import * as bcrypt from 'bcryptjs';
import {
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password-hash';

describe('密码哈希', () => {
  it('生成的哈希能通过校验', async () => {
    const stored = await hashPassword('Abc123456!');

    expect(stored.startsWith('scrypt$')).toBe(true);
    await expect(verifyPassword('Abc123456!', stored)).resolves.toBe(true);
  });

  it('密码错误时不通过', async () => {
    const stored = await hashPassword('Abc123456!');

    await expect(verifyPassword('Abc123456?', stored)).resolves.toBe(false);
    await expect(verifyPassword('', stored)).resolves.toBe(false);
  });

  it('同一密码两次哈希结果不同（盐随机）', async () => {
    const [a, b] = await Promise.all([
      hashPassword('Abc123456!'),
      hashPassword('Abc123456!'),
    ]);

    expect(a).not.toBe(b);
    await expect(verifyPassword('Abc123456!', a)).resolves.toBe(true);
    await expect(verifyPassword('Abc123456!', b)).resolves.toBe(true);
  });

  it('兼容历史 bcrypt 哈希', async () => {
    const legacy = await bcrypt.hash('Abc123456!', 4); // 测试用低成本因子

    await expect(verifyPassword('Abc123456!', legacy)).resolves.toBe(true);
    await expect(verifyPassword('wrong', legacy)).resolves.toBe(false);
    expect(needsRehash(legacy)).toBe(true);
  });

  it('新哈希不需要重算', async () => {
    const stored = await hashPassword('Abc123456!');

    expect(needsRehash(stored)).toBe(false);
  });

  it('空值与损坏的哈希一律判失败，不抛异常', async () => {
    const broken = [
      null,
      undefined,
      '',
      'scrypt$',
      'scrypt$abc$8$1$xx$yy',
      'scrypt$999999999$8$1$xx$yy',
      'scrypt$32768$999$1$xx$yy',
      'md5$whatever',
      '$2b$broken',
    ];

    for (const value of broken) {
      await expect(verifyPassword('Abc123456!', value)).resolves.toBe(false);
    }
  });
});
