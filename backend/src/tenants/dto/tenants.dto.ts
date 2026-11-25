import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateTenantDto {
  /**
   * 企业名称。
   *
   * 上限 40 字：真实公司名很少超过这个长度，再长在界面上也显示不下。
   * 下限 2 字是为了挡住"a""1"这类无意义输入。
   */
  @IsString()
  @MinLength(2, { message: '企业名称至少 2 个字' })
  @MaxLength(40, { message: '企业名称最多 40 个字' })
  name!: string;
}

export class SwitchTenantDto {
  /**
   * 用 `'all'` 而不是 `'4'`。
   *
   * 开发期踩过一次：默认组织原本用 `00000000-0000-0000-0000-000000000001`，
   * 看着像 UUID，但第 4 组的 variant 位是 0（RFC 4122 要求 8/9/a/b），
   * `isUUID` 判它是非法值 —— 存量用户切回自己的企业空间直接吃 400。
   * PostgreSQL 的 uuid 类型不校验版本位，所以这个坑只有在应用层才暴露。
   *
   * 现在默认组织已换成合规的 v4，但 DTO 仍不限定版本：
   * 真正的合法性由服务层的 membership 校验兜底，这里只做格式筛查。
   */
  @IsUUID('all', { message: '空间 id 不合法' })
  tenantId!: string;
}

/** 生成邀请链接 */
export class CreateInviteDto {
  /**
   * 指定手机号后，只有该号能接受。
   *
   * 不填就是"拿到链接的人都能用"—— 适合发在群里。
   * 填了就变成定向邀请，转发出去也没用。
   */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  /**
   * 邀请进来给什么角色。
   *
   * 不允许 OWNER（转让是独立操作），ADMIN 只有所有者能发。
   */
  @IsOptional()
  @IsIn(['ADMIN', 'MEMBER'], { message: '角色只能是 ADMIN 或 MEMBER' })
  role?: 'ADMIN' | 'MEMBER';

  /** 可用次数：默认 1（一对一邀请），最多 50（发给一个部门） */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxUses?: number;
}

/** 校验 / 接受邀请 */
export class InviteTokenDto {
  @IsString()
  @MinLength(10, { message: '邀请链接不完整' })
  @MaxLength(200)
  token!: string;
}
