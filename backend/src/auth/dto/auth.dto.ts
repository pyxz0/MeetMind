import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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

  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword?: string;
}