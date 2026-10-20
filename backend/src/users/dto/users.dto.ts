import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** 角色白名单，与 Prisma 枚举保持一致 */
const ROLES = ['USER', 'ADMIN', 'SUPER_ADMIN'] as const;

export class CreateUserDto {
  @IsString()
  phone!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsString()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsIn(ROLES)
  role?: (typeof ROLES)[number];
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsIn(ROLES)
  role?: (typeof ROLES)[number];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password?: string;
}