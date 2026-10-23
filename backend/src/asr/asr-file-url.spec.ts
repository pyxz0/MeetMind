import {
  isAllowedFile,
  isTextFile,
  mimeOf,
  signFileToken,
  verifyFileToken,
} from './asr-file-url';

describe('转写文件地址签名', () => {
  it('自己签的令牌能验证通过', () => {
    const token = signFileToken(7);

    expect(verifyFileToken(7, token)).toBe(true);
  });

  it('换成别的任务 id 就不认（防止拿 A 的链接读 B 的文件）', () => {
    const token = signFileToken(7);

    expect(verifyFileToken(8, token)).toBe(false);
  });

  it('篡改签名不通过', () => {
    const token = signFileToken(7);
    const tampered = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;

    expect(verifyFileToken(7, tampered)).toBe(false);
  });

  it('缺段或空令牌不通过', () => {
    expect(verifyFileToken(7, '')).toBe(false);
    expect(verifyFileToken(7, '12345')).toBe(false);
  });
});

describe('文件类型判定', () => {
  it('只接受音频/视频与纯文本', () => {
    expect(isAllowedFile('a.mp3')).toBe(true);
    expect(isAllowedFile('a.MP4')).toBe(true);
    expect(isAllowedFile('notes.md')).toBe(true);
    expect(isAllowedFile('a.pdf')).toBe(false);
    expect(isAllowedFile('a.docx')).toBe(false);
  });

  it('文本类不走 ASR', () => {
    expect(isTextFile('notes.txt')).toBe(true);
    expect(isTextFile('a.mp3')).toBe(false);
  });

  it('按扩展名给出可播放的 MIME', () => {
    expect(mimeOf('a.mp3')).toBe('audio/mpeg');
    expect(mimeOf('a.m4a')).toBe('audio/mp4');
    expect(mimeOf('a.txt')).toContain('text/plain');
  });
});
