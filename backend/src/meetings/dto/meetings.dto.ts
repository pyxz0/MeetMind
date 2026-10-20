import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const COMPLETION_STATUS = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

const TODO_STATUS = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;

export class TodoInputDto {
  @IsString()
  @MaxLength(500)
  content!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  assignee?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  deadline?: string;
}

/** 创建会议（AI 生成结果落库） */
export class CreateMeetingDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsString()
  content!: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  decisions?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TodoInputDto)
  todos?: TodoInputDto[];
}

/** 创建正式会议（预约） */
export class CreateScheduledMeetingDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  /** ISO 时间字符串，具体格式由服务层解析并给出中文提示 */
  @IsString()
  scheduledAt!: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  leaderIds?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  memberIds?: number[];
}

/** 修改未开始会议的预约信息 */
export class UpdateScheduledMeetingDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  scheduledAt?: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  leaderIds?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  memberIds?: number[];
}

export class UpdateMeetingTitleDto {
  @IsString()
  @MaxLength(200)
  title!: string;
}

export class PinMeetingDto {
  @IsBoolean()
  pinned!: boolean;
}

export class CompletionStatusDto {
  @IsIn(COMPLETION_STATUS)
  completionStatus!: (typeof COMPLETION_STATUS)[number];
}

/** 负责人 / 成员共用：只需一个用户 id */
export class MeetingUserDto {
  @IsInt()
  @Min(1)
  userId!: number;
}

export class AudioOpenDto {
  @IsBoolean()
  audioOpen!: boolean;
}

export class CreateTodoDto {
  @IsString()
  @MaxLength(500)
  content!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  assignee?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  deadline?: string;
}

export class UpdateTodoDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  content?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  assignee?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  deadline?: string;
}

export class TodoStatusDto {
  @IsIn(TODO_STATUS)
  status!: (typeof TODO_STATUS)[number];
}

export class CreateDraftDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsString()
  content!: string;
}
/** 把 "true"/"1" 这类查询串转成布尔值 */
const toBoolean = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1';

/**
 * 列表查询参数。
 *
 * 分页与服务端筛选都放在这里：
 * pageSize 上限 100，避免一次把整库拉出来。
 */
export class ListMeetingsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  keyword?: string;

  @IsOptional()
  @IsIn(COMPLETION_STATUS)
  status?: (typeof COMPLETION_STATUS)[number];

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from 需为 YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to 需为 YYYY-MM-DD' })
  to?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  upcoming?: boolean;

  /** 排序：newest 最新创建在前（默认），oldest 最早创建在前 */
  @IsOptional()
  @IsIn(['newest', 'oldest'])
  sort?: 'newest' | 'oldest';
}