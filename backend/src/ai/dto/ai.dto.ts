import { IsString, MaxLength, MinLength } from 'class-validator';

export class GenerateMeetingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  content!: string;
}