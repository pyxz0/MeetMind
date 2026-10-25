import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class SendMessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  content?: string;

  @IsOptional()
  @IsIn(['TEXT', 'IMAGE', 'FILE'])
  kind?: 'TEXT' | 'IMAGE' | 'FILE';
}

export class OpenConversationDto {
  @IsInt()
  peerId!: number;
}
