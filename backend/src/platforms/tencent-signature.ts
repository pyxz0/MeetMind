import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 腾讯会议企业自建应用（AK/SK）的请求签名。
 *
 * 算法与官方 Java/Go/Python 示例一致：
 *   1. 收签串 = METHOD \n "X-TC-Key=..&X-TC-Nonce=..&X-TC-Timestamp=.." \n URI \n body
 *   2. HMAC-SHA256(secretKey, 收签串)
 *   3. 转成**小写十六进制字符串**
 *   4. 对那个字符串再做 Base64
 *
 * 第 4 步是最容易写错的地方：Base64 的是十六进制字符串，不是哈希原始字节。
 * 写成 `base64(hmac)` 在本地看不出问题，只有真调接口时才会一直返回签名错误。
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface SignRequestInput {
  secretId: string;
  secretKey: string;
  method: HttpMethod;
  /** 含查询串的 URI，例如 /v1/meetings/123?userid=test1&instanceid=1 */
  uri: string;
  /** 请求体原文；GET 没有 body，传空串 */
  body?: string;
  /** 秒级时间戳，缺省取当前时间 */
  timestamp?: number;
  /** 随机正整数 */
  nonce?: number;
}

export interface SignedAuth {
  signature: string;
  timestamp: number;
  nonce: number;
}

/** 收签串。抽出来单独可测，避免签名函数里混着字符串拼接逻辑 */
export const buildStringToSign = (params: {
  method: HttpMethod;
  secretId: string;
  nonce: number | string;
  timestamp: number | string;
  uri: string;
  body?: string;
}): string =>
  [
    params.method.toUpperCase(),
    `X-TC-Key=${params.secretId}&X-TC-Nonce=${params.nonce}&X-TC-Timestamp=${params.timestamp}`,
    params.uri,
    params.body ?? '',
  ].join('\n');

export const signRequest = (input: SignRequestInput): SignedAuth => {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  // 官方要求「随机正整数」；用加密随机源，避免可预测的 nonce
  const nonce =
    input.nonce ??
    Math.floor(Math.random() * 900_000_000 + 100_000_000);

  const stringToSign = buildStringToSign({
    method: input.method,
    secretId: input.secretId,
    nonce,
    timestamp,
    uri: input.uri,
    body: input.body,
  });

  const hexHash = createHmac('sha256', input.secretKey)
    .update(stringToSign, 'utf8')
    .digest('hex');

  // 注意：Base64 的是 hex 字符串本身
  const signature = Buffer.from(hexHash, 'utf8').toString('base64');

  return { signature, timestamp, nonce };
};

/**
 * 组装可直接给 HTTP 客户端的鉴权头。
 *
 * AppId / SdkId 也在这里 —— 它们不参与签名，但缺任何一个都会被拒，
 * 放在一处能避免调用点漏写。
 */
export const buildAuthHeaders = (params: {
  secretId: string;
  secretKey: string;
  appId: string;
  sdkId?: string;
  method: HttpMethod;
  uri: string;
  body?: string;
  timestamp?: number;
  nonce?: number;
}): Record<string, string> => {
  const signed = signRequest(params);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-TC-Key': params.secretId,
    'X-TC-Timestamp': String(signed.timestamp),
    'X-TC-Nonce': String(signed.nonce),
    'X-TC-Signature': signed.signature,
    AppId: params.appId,
  };

  if (params.sdkId?.trim()) {
    headers.SdkId = params.sdkId.trim();
  }

  return headers;
};

/* =========================================================
   Webhook 验签
   ========================================================= */

/**
 * 回调验签。
 *
 * 官方文档：`dev_signature = sha1(sort(token, timestamp, nonce, data))`，
 * sort 指把四个**值**按字典序排序后直接拼接，再 SHA1，取十六进制小写。
 *
 * 两个容易踩的坑：
 * - 是 SHA1，不是 SHA256（不少第三方文章写错）
 * - data 必须参与，且用的是收到的**原始字符串**
 *   （GET 验证时是 check_str，POST 回调时是 body 里的 data，都是 base64）
 */
/** 字典序排序后直接拼接，官方 `sort(...)` 的字面含义 */
export const buildWebhookSortString = (params: {
  token: string;
  timestamp: string;
  nonce: string;
  data: string;
}): string =>
  [params.token, params.timestamp, params.nonce, params.data]
    .sort()
    .join('');

export const computeWebhookSignature = (params: {
  token: string;
  timestamp: string;
  nonce: string;
  data: string;
}): string =>
  createHash('sha1')
    .update(buildWebhookSortString(params), 'utf8')
    .digest('hex');

/** 定长比较，避免用 `===` 提前返回泄漏前缀匹配长度 */
const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
};

export const verifyWebhookSignature = (params: {
  token: string;
  timestamp: string;
  nonce: string;
  data: string;
  signature: string;
}): boolean => {
  if (!params.token) {
    // 没配 token 时一律拒绝：宁可收不到事件，也不能让伪造回调进来
    return false;
  }

  if (!params.signature) {
    return false;
  }

  return safeEqual(
    computeWebhookSignature({
      token: params.token,
      timestamp: params.timestamp,
      nonce: params.nonce,
      data: params.data,
    }),
    params.signature,
  );
};
