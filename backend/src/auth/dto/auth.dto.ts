import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * 登录入参。
 *
 * 这里只约束「结构」，手机号格式与密码强度属于业务规则，
 * 留在 AuthService 里校验，以返回中文提示。
 */
export class LoginDto {
  @IsString()
  phone!: string;

  @IsString()
  password!: string;
}

export class RegisterDto {
  @IsString()
  phone!: string;

  @IsString()
  password!: string;

  @IsString()
  @MaxLength(80)
  name!: string;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  /**
   * 头像：前端已压到 256px 的 JPEG data URL。
   *
   * 格式与大小（约 400KB）都在 Service 里校验——
   * 需要返回中文错误提示，而不是 class-validator 的英文默认文案。
   * 传空字符串表示「移除头像」。
   */
  @IsOptional()
  @IsString()
  avatar?: string;

  /**
   * 绑定邮箱：自助找回密码的接收地址。
   *
   * 格式与唯一性在 Service 里校验（要返回中文提示）；
   * 传空字符串表示解除绑定。
   */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword?: string;

  /**
   * 是否接收邮件提醒。
   *
   * 关掉之后站内收件箱照常，只是不再往邮箱推送 ——
   * 「关不掉的通知」是这类系统最招人烦的地方，所以给一个明确的开关。
   */
  @IsOptional()
  @IsBoolean()
  notifyEmail?: boolean;
}
/** 校验重置令牌（进入重置页时先调，链接失效能立刻提示） */
export class PasswordResetTokenDto {
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  token!: string;
}

/**
 * 用一次性令牌设置新密码。
 *
 * 这里只约束结构；强度规则（至少 8 位、字母 + 数字）由
 * AuthService.assertPasswordStrength 统一给出中文原因。
 */
export class ConfirmPasswordResetDto extends PasswordResetTokenDto {
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}

/** 自助找回：提交绑定邮箱，由后端发一次性链接 */
export class RequestPasswordResetDto {
  @IsString()
  @MaxLength(160)
  email!: string;
}
