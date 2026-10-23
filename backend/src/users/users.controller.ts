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
  RequireRoles,
  type AuthenticatedUser,
} from '../auth/auth.decorators';
import { PERMISSIONS } from '../auth/permissions';
import { CreateUserDto, UpdateUserDto } from './dto/users.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * 通讯录：只返回「姓名 + 手机号」的最小集合。
   *
   * 任何已登录用户都能调用，用于在会议里指定负责人与成员。
   * 必须声明在 `:id` 相关路由之前，避免被当成 id 参数解析。
   */
  @Get('contacts')
  contacts() {
    return this.usersService.listContacts();
  }

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
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateUserDto) {
    return this.usersService.create(user, dto);
  }

  /** 修改资料、手机号、角色或启用状态 */
  @Patch(':id')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.update(user, id, dto);
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

  /**
   * 以指定账号身份浏览（代登）。仅超级管理员可用。
   */
  @Post(':id/impersonate')
  @RequireRoles('SUPER_ADMIN')
  impersonate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.usersService.impersonate(user, id);
  }

  /**
   * 生成一次性密码重置链接（管理员及以上）。
   *
   * 不让管理员直接设新密码：那样管理员会知道用户的明文密码，
   * 事后也无法证明是本人操作的。这里只发链接，新密码由本人设置。
   */
  @Post(':id/password-reset')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  issuePasswordReset(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.usersService.issuePasswordReset(user, id);
  }
}