import { IsArray, IsOptional, IsString } from 'class-validator';

/** 标记已读：传 keys 只标记这些，不传表示全部已读 */
export class MarkInboxReadDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keys?: string[];
}