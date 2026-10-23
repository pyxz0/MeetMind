import { createHmac, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';

/**
 * 允许上传的扩展名。
 *
 * 音频/视频交给 ASR；txt/md 直接当原文，不花转写费用。
 * 不支持 docx/pdf：解析它们要再加一层依赖，且会议录音才是主场景。
 */
export const AUDIO_EXTENSIONS = [
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.amr',
  '.mp4',
] as const;

export const TEXT_EXTENSIONS = ['.txt', '.md'] as const;

export const ALLOWED_EXTENSIONS = [
  ...AUDIO_EXTENSIONS,
  ...TEXT_EXTENSIONS,
] as const;

/** 单个文件上限：一小时 mp3 约 60MB，留足余量但别把 50G 盘写满 */
export const MAX_ASR_FILE_BYTES = 300 * 1024 * 1024;

/** 转写服务商拉文件用的签名有效期 */
const FILE_URL_TTL_SECONDS = 60 * 60;

export const isTextFile = (filename: string): boolean =>
  (TEXT_EXTENSIONS as readonly string[]).includes(
    extname(filename).toLowerCase(),
  );

export const isAllowedFile = (filename: string): boolean =>
  (ALLOWED_EXTENSIONS as readonly string[]).includes(
    extname(filename).toLowerCase(),
  );

/** 下载时用的 Content-Type，尽量让浏览器/播放器能直接认 */
export const mimeOf = (filename: string): string => {
  switch (extname(filename).toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.m4a':
      return 'audio/mp4';
    case '.aac':
      return 'audio/aac';
    case '.flac':
      return 'audio/flac';
    case '.ogg':
      return 'audio/ogg';
    case '.amr':
      return 'audio/amr';
    case '.mp4':
      return 'video/mp4';
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.txt':
    default:
      return 'text/plain; charset=utf-8';
  }
};

/**
 * 文件地址签名。
 *
 * 服务商是按 URL 拉文件的，这个地址不能要求登录态 ——
 * 所以用「id + 过期时间 + HMAC」自证，签名里绑定了 jobId，
 * 拿到 A 的链接改不了 B 的文件。
 */
const secret = (): string =>
  process.env.ASR_URL_SECRET?.trim() ||
  process.env.JWT_SECRET?.trim() ||
  'meetmind-asr-dev-secret';

const sign = (payload: string): string =>
  createHmac('sha256', secret()).update(payload).digest('hex').slice(0, 32);

export const signFileToken = (jobId: number): string => {
  const expiresAt = Math.floor(Date.now() / 1000) + FILE_URL_TTL_SECONDS;

  return `${expiresAt}.${sign(`${jobId}.${expiresAt}`)}`;
};

export const verifyFileToken = (jobId: number, token: string): boolean => {
  const [expiresRaw, signature] = (token ?? '').split('.');
  const expiresAt = Number(expiresRaw);

  if (!expiresAt || !signature) return false;
  if (expiresAt < Math.floor(Date.now() / 1000)) return false;

  const expected = sign(`${jobId}.${expiresAt}`);

  if (expected.length !== signature.length) return false;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
};

/** 拼出服务商可访问的公网地址；没配 APP_PUBLIC_URL 时返回 null */
export const buildFileUrl = (jobId: number): string | null => {
  const base = process.env.APP_PUBLIC_URL?.trim();

  if (!base) return null;

  return `${base.replace(/\/+$/, '')}/api/asr/files/${jobId}/${signFileToken(jobId)}`;
};
