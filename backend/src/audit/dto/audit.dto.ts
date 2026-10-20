import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** 审计日志查询参数 */
export class AuditQueryDto {
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

  /** 动作模糊匹配，如 meeting.delete */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  resourceType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  actorId?: number;
}
