import { createHash, randomBytes } from 'node:crypto'

/**
 * 邀请令牌的有效期。
 *
 * 7 天：够长到能通过微信转达、也够对方找到时间注册；
 * 够短到不会变成一个长期有效的后门。
 */
export const INVITE_TTL_DAYS = 7

/**
 * 生成明文令牌。
 *
 * base64url 而不是 hex：同样 32 字节熵，字符串短四分之一，
 * 放进链接和二维码都不至于长得难看。base64url 也不含需要转义的字符。
 */
export const createInviteToken = (): string =>
  randomBytes(32).toString('base64url')

/**
 * 只存哈希。
 *
 * 与密码重置令牌同样的理由：数据库被读走时，攻击者拿不到可用链接。
 * 明文只在生成的那一刻返回一次，之后谁（包括管理员）都看不到。
 */
export const hashInviteToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

/**
 * 手机号脱敏：138****8888。
 *
 * 邀请链接在 inspect 时是公开的（未登录也要能看到"你被邀请加入某某公司"），
 * 所以绑定的手机号不能原样返回 —— 那等于给了任何人一个查号工具。
 */
export const maskPhone = (phone: string): string => {
  if (phone.length !== 11) return phone

  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}
