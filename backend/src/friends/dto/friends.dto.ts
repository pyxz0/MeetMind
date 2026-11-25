import { IsString, MaxLength } from 'class-validator';

/**
 * 加好友：只收手机号。
 *
 * 不做格式校验，交给 AuthService.normalizePhone —— 那里会去掉空格、
 * 连字符和 +86 前缀再统一校验，与登录/注册完全一致。
 * 在这里再写一遍正则会变成两份容易漂移的规则。
 */
export class AddFriendDto {
  @IsString()
  @MaxLength(20)
  phone!: string;
}
