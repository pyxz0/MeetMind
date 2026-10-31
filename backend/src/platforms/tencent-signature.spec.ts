import { createHmac } from 'node:crypto';
import {
  buildAuthHeaders,
  buildStringToSign,
  buildWebhookSortString,
  computeWebhookSignature,
  signRequest,
  verifyWebhookSignature,
} from './tencent-signature';

const CREDS = {
  secretId: 'AKIDtest123',
  secretKey: 'SECRETKEYtest456',
  appId: '1234567890',
};

/** 固定输入下的期望签名（按官方算法逐步手算，用作回归护栏） */
const FIXED = {
  method: 'POST' as const,
  uri: '/v1/meetings',
  body: '{"userid":"test1","instanceid":1}',
  timestamp: 1700000000,
  nonce: 123456789,
};

const FIXED_SIGNATURE =
  'OGY1YWE2MTBlMjBmZDQzYmI3YjcwMjJiZmVmM2EwOGRkNWJjNjI4NGNkYTg4Yzg2NzBkN2JkZGQ2NzFiMTMyMA==';

describe('buildStringToSign', () => {
  it('按 METHOD / Header / URI / body 四段拼接', () => {
    expect(
      buildStringToSign({
        method: 'POST',
        secretId: 'AKIDtest123',
        nonce: 123456789,
        timestamp: 1700000000,
        uri: '/v1/meetings',
        body: '{"a":1}',
      }),
    ).toBe(
      'POST\nX-TC-Key=AKIDtest123&X-TC-Nonce=123456789&X-TC-Timestamp=1700000000\n/v1/meetings\n{"a":1}',
    );
  });

  it('Header 段按 Key / Nonce / Timestamp 的固定顺序拼接', () => {
    const text = buildStringToSign({
      method: 'GET',
      secretId: 'K',
      nonce: 2,
      timestamp: 1,
      uri: '/v1/meetings',
    });

    expect(text).toContain('X-TC-Key=K&X-TC-Nonce=2&X-TC-Timestamp=1');
  });

  it('GET 没有 body 时补空串，但保留最后一段分隔', () => {
    const text = buildStringToSign({
      method: 'GET',
      secretId: 'K',
      nonce: 2,
      timestamp: 1,
      uri: '/v1/meetings?userid=tester1&instanceid=1',
    });

    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')).toHaveLength(4);
    expect(text).toContain('userid=tester1&instanceid=1');
  });

  it('method 统一大写', () => {
    expect(
      buildStringToSign({
        method: 'get' as never,
        secretId: 'K',
        nonce: 2,
        timestamp: 1,
        uri: '/x',
      }),
    ).toMatch(/^GET\n/);
  });
});

describe('signRequest', () => {
  it('固定输入得到固定签名（防回归）', () => {
    const signed = signRequest({ ...CREDS, ...FIXED });

    expect(signed.signature).toBe(FIXED_SIGNATURE);
  });

  /**
   * 这条是整份测试里最重要的一条：
   * 最常见的错误实现是 `base64(hmacBytes)`，它同样是一个合法 base64，
   * 本地怎么跑都不报错，只有真调接口时才会一直「签名错误」。
   */
  it('签名是 base64(十六进制字符串)，不是 base64(原始哈希)', () => {
    const signed = signRequest({ ...CREDS, ...FIXED });

    const stringToSign = buildStringToSign({
      method: FIXED.method,
      secretId: CREDS.secretId,
      nonce: FIXED.nonce,
      timestamp: FIXED.timestamp,
      uri: FIXED.uri,
      body: FIXED.body,
    });

    const rawBase64 = createHmac('sha256', CREDS.secretKey)
      .update(stringToSign, 'utf8')
      .digest('base64');

    expect(signed.signature).not.toBe(rawBase64);
    // 解码后应当是 64 位小写十六进制
    expect(Buffer.from(signed.signature, 'base64').toString('utf8')).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('输入任何一处变化都会改变签名', () => {
    const base = signRequest({ ...CREDS, ...FIXED });

    const changedBody = signRequest({
      ...CREDS,
      ...FIXED,
      body: '{"userid":"other"}',
    });
    const changedNonce = signRequest({ ...CREDS, ...FIXED, nonce: 1 });
    const changedUri = signRequest({ ...CREDS, ...FIXED, uri: '/v1/meetings/1' });

    expect(changedBody.signature).not.toBe(base.signature);
    expect(changedNonce.signature).not.toBe(base.signature);
    expect(changedUri.signature).not.toBe(base.signature);
  });

  it('不给 timestamp / nonce 时自动生成', () => {
    const signed = signRequest({ ...CREDS, method: 'GET', uri: '/v1/meetings' });

    expect(signed.timestamp).toBeGreaterThan(1_600_000_000);
    expect(signed.nonce).toBeGreaterThan(0);
    expect(Number.isInteger(signed.nonce)).toBe(true);
  });
});

describe('buildAuthHeaders', () => {
  it('带上全部必填头', () => {
    const headers = buildAuthHeaders({ ...CREDS, ...FIXED });

    expect(headers['X-TC-Key']).toBe(CREDS.secretId);
    expect(headers.AppId).toBe(CREDS.appId);
    expect(headers['X-TC-Signature']).toBe(FIXED_SIGNATURE);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-TC-Timestamp']).toBe('1700000000');
  });

  it('SdkId 为空时不写该头（早期应用没有 SdkId）', () => {
    expect(buildAuthHeaders({ ...CREDS, ...FIXED }).SdkId).toBeUndefined();

    expect(
      buildAuthHeaders({ ...CREDS, ...FIXED, sdkId: '  ' }).SdkId,
    ).toBeUndefined();
  });

  it('有 SdkId 时原样带上', () => {
    expect(
      buildAuthHeaders({ ...CREDS, ...FIXED, sdkId: 'sdk-001' }).SdkId,
    ).toBe('sdk-001');
  });
});

describe('webhook 验签', () => {
  const params = {
    token: 'bVPU6F8Htxl5XkAbp3jGV2xWp',
    timestamp: '1609239040864',
    nonce: '14964161',
    data: 'eyJldmVudCI6Im1lZXRpbmcuY3JlYXRlZCJ9',
  };

  it('四个值按字典序排序后直接拼接', () => {
    // 14964161 < 1609239040864 < bVPU... < eyJ...
    expect(buildWebhookSortString(params)).toBe(
      '149641611609239040864bVPU6F8Htxl5XkAbp3jGV2xWpeyJldmVudCI6Im1lZXRpbmcuY3JlYXRlZCJ9',
    );
  });

  it('用 SHA1 而不是 SHA256', () => {
    const signature = computeWebhookSignature(params);

    expect(signature).toHaveLength(40);
    expect(signature).toMatch(/^[0-9a-f]{40}$/);
  });

  it('签名正确时通过', () => {
    const signature = computeWebhookSignature(params);

    expect(verifyWebhookSignature({ ...params, signature })).toBe(true);
  });

  it('data 被篡改则失败', () => {
    const signature = computeWebhookSignature(params);

    expect(
      verifyWebhookSignature({
        ...params,
        data: `${params.data}tampered`,
        signature,
      }),
    ).toBe(false);
  });

  it('nonce 或 timestamp 变化则失败（防重放）', () => {
    const signature = computeWebhookSignature(params);

    expect(
      verifyWebhookSignature({ ...params, nonce: '99', signature }),
    ).toBe(false);

    expect(
      verifyWebhookSignature({ ...params, timestamp: '1', signature }),
    ).toBe(false);
  });

  it('未配置 token 时一律拒绝', () => {
    const signature = computeWebhookSignature(params);

    expect(
      verifyWebhookSignature({ ...params, token: '', signature }),
    ).toBe(false);
  });

  it('签名为空时拒绝，不会退化成恒真', () => {
    expect(verifyWebhookSignature({ ...params, signature: '' })).toBe(false);
  });
});
