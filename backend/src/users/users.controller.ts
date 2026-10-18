import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../auth/auth.decorators';
import { PERMISSIONS } from '../auth/permissions';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /** 用户列表，供分享时挑选接收人、以及管理员管人 */
  @Get()
  @RequirePermissions(PERMISSIONS.USER_READ)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('keyword') keyword?: string,
    @Query('role') role?: string,
  ) {
    return this.usersService.list(user, { keyword, role });
  }

  /** 新建账号（管理员及以上） */
  @Post()
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      phone?: string;
      password?: string;
      name?: string;
      role?: string;
    },
  ) {
    return this.usersService.create(user, {
      phone: body?.phone ?? '',
      password: body?.password ?? '',
      name: body?.name ?? '',
      role: body?.role,
    });
  }

  /** 修改资料、手机号、角色或启用状态 */
  @Patch(':id')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      phone?: string;
      name?: string;
      role?: string;
      isActive?: boolean;
      password?: string;
    },
  ) {
    return this.usersService.update(user, id, body ?? {});
  }

  /** 删除账号 */
  @Delete(':id')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.usersService.remove(user, id);
  }
}
