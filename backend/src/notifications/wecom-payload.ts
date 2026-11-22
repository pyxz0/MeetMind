/**
 * 企业微信群机器人的协议细节。
 *
 * 单独抽出来是因为这三件事都容易出错，而且都能用纯函数验证：
 * 1. 内容要按**字节**截断 —— 中文一个字 3 字节，按字符数算会直接超限
 * 2. @手机号必须是 11 位，有一条脏数据整条消息就会被拒收
 * 3. 消息体结构固定，msgtype 写错群机器人会静默忽略
 */

/** 群机器人 markdown 内容上限 4096 字节，留点余量 */
const MAX_CONTENT_BYTES = 3800;

/** 企微只认 11 位中国大陆手机号 */
export const isMentionableMobile = (value: string): boolean =>
  /^1[3-9]\d{9}$/.test(value);

/** 过滤掉非法号码，同时去重 —— 重复 @ 同一个人没有意义 */
export const filterMentionMobiles = (mobiles: string[]): string[] => {
  return [...new Set(mobiles.filter((phone) => isMentionableMobile(phone)))];
};

/**
 * 按字节截断。
 *
 * 不能按字符数截：4096 个汉字是 12KB，企微会直接拒收整条消息。
 */
export const truncateByBytes = (content: string): string => {
  if (Buffer.byteLength(content, 'utf8') <= MAX_CONTENT_BYTES) {
    return content;
  }

  let result = '';

  for (const char of content) {
    if (Buffer.byteLength(result + char, 'utf8') > MAX_CONTENT_BYTES - 40) {
      break;
    }

    result += char;
  }

  return `${result}\n\n…（内容过长已截断）`;
};

export interface WeComBody {
  msgtype: 'markdown';
  markdown: {
    content: string;
    mentioned_mobile_list: string[];
  };
}

/** 组装请求体；截断与手机号过滤都在这里收口 */
export const buildWeComBody = (
  content: string,
  mentionMobiles: string[] = [],
): WeComBody => ({
  msgtype: 'markdown',
  markdown: {
    content: truncateByBytes(content),
    mentioned_mobile_list: filterMentionMobiles(mentionMobiles),
  },
});

/**
 * 判断响应是否真的成功。
 *
 * 企微即使业务失败也返回 HTTP 200，只看 status 会让「消息没发出去」
 * 变成长期静默 —— 这也是接群机器人最容易踩的坑。
 */
export const isWeComSuccess = (status: number, body: unknown): boolean => {
  if (status < 200 || status >= 300) {
    return false;
  }

  if (!body || typeof body !== 'object') {
    // 有些网关会返回空体；只要 HTTP 成功就当作已送达，避免误判重发
    return true;
  }

  const errcode = (body as { errcode?: number }).errcode;

  return !errcode;
};
