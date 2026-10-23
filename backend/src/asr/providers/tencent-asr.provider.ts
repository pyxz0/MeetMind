import { createHash, createHmac } from 'node:crypto';
import type {
  AsrPollResult,
  AsrProvider,
  AsrSubmitResult,
} from './asr-provider';

/** 腾讯云语音识别（录音文件识别）的固定入口与版本 */
const HOST = 'asr.tencentcloudapi.com';
const SERVICE = 'asr';
const VERSION = '2019-06-14';

interface TencentAsrOptions {
  secretId: string;
  secretKey: string;
  region: string;
}

/**
 * 腾讯云录音文件识别。
 *
 * 为什么用它：服务器就在腾讯云广州，内网直连、账单合并，
 * 而且「录音文件识别」是异步任务模式 —— 一小时的会议不需要一直挂着 HTTP 请求。
 *
 * 关键约束：服务商是按 URL 拉文件的，所以必须先把音频暴露成一个
 * 带签名、有时效的公网地址（见 asr-file-url.ts），不能只给鉴权接口。
 */
export class TencentAsrProvider implements AsrProvider {
  readonly name = 'tencent';

  constructor(private readonly options: TencentAsrOptions) {}

  async submit(url: string, format: string): Promise<AsrSubmitResult> {
    const response = await this.call('CreateRecTask', {
      // 16k_zh：中文通用模型，会议场景够用
      EngSerViceType: '16k_zh',
      // 1 = 通过 URL 拉取（0 是直接传 base64，长会议超限）
      SourceType: 1,
      Url: url,
      VoiceFormat: format,
      ChannelNum: 1,
      // 0 = 只返回文本，不做词级时间戳
      ResTextFormat: 0,
      // 数字转阿拉伯、过滤脏词，会议记录可读性更好
      ConvertNumMode: 1,
      FilterDirty: 1,
      FilterModal: 1,
    });

    const taskId = response?.Data?.TaskId;

    if (!taskId) {
      throw new Error('腾讯云 ASR 未返回 TaskId');
    }

    return { taskId: String(taskId) };
  }

  async poll(taskId: string): Promise<AsrPollResult> {
    const response = await this.call('DescribeTaskStatus', {
      TaskId: Number(taskId),
    });

    const data = response?.Data ?? {};
    /** 0 等待中 / 1 识别中 / 2 成功 / 3 失败 */
    const status = Number(data.TaskStatus);

    if (status === 2) {
      return {
        status: 'done',
        text: String(data.Result ?? '').trim(),
        durationSec: data.AudioDuration
          ? Math.round(Number(data.AudioDuration) / 1000)
          : undefined,
      };
    }

    if (status === 3) {
      return {
        status: 'failed',
        error: String(data.ErrorMsg || '转写失败（服务商未给出原因）'),
      };
    }

    return { status: 'running' };
  }

  /**
   * 调用腾讯云 API（TC3-HMAC-SHA256 签名）。
   *
   * 签名串的四段（规范请求、待签字符串、派生密钥、Authorization）顺序不能变，
   * 任何一段不同都会得到 AuthFailure.SignatureFailure，且报错不会告诉你差在哪。
   */
  private async call(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<any> {
    const { secretId, secretKey, region } = this.options;
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const body = JSON.stringify(payload);

    const canonicalRequest = [
      'POST',
      '/',
      '',
      `content-type:application/json; charset=utf-8\nhost:${HOST}\n`,
      'content-type;host',
      sha256(body),
    ].join('\n');

    const credentialScope = `${date}/${SERVICE}/tc3_request`;
    const stringToSign = [
      'TC3-HMAC-SHA256',
      String(timestamp),
      credentialScope,
      sha256(canonicalRequest),
    ].join('\n');

    const secretDate = hmac(`TC3${secretKey}`, date);
    const secretService = hmac(secretDate, SERVICE);
    const secretSigning = hmac(secretService, 'tc3_request');
    const signature = createHmac('sha256', secretSigning)
      .update(stringToSign)
      .digest('hex');

    const authorization =
      `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
      `SignedHeaders=content-type;host, Signature=${signature}`;

    const response = await fetch(`https://${HOST}`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        'X-TC-Action': action,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': VERSION,
        'X-TC-Region': region,
      },
      body,
    });

    const json = (await response.json()) as any;
    const error = json?.Response?.Error;

    if (error) {
      throw new Error(
        `腾讯云 ASR ${action} 失败：${error.Code} ${error.Message}`,
      );
    }

    return json.Response;
  }
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const hmac = (key: string | Buffer, value: string): Buffer =>
  createHmac('sha256', key).update(value).digest();
