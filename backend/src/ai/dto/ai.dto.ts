import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class GenerateMeetingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  content!: string;

  /**
   * 生成的会议要落到哪个空间；不传 = 当前空间。
   *
   * 和企业/个人会议一样，服务端会校验它是否属于该用户（见 §2.5）。
   */
  @IsOptional()
  @IsUUID('all', { message: 'tenantId 必须是合法的空间 id' })
  tenantId?: string;
}

/**
 * 就某场会议提问。
 *
 * 只收问题本身：历史对话由服务端按会议 ID 从库里取，
 * 不接受客户端上传的「上下文」—— 否则谁都能伪造一段对话塞进模型。
 */
export class AskMeetingDto {
  @IsString()
  @MinLength(1, { message: '请输入要问的问题' })
  @MaxLength(500, { message: '问题太长了，请控制在 500 字以内' })
  question!: string;
}