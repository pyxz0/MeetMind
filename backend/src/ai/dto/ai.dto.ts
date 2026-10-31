import { IsString, MaxLength, MinLength } from 'class-validator';

export class GenerateMeetingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  content!: string;
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