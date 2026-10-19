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
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * 通讯录：只返回「姓名 + 手机号」的最小集合。
   *
   * 任何已登录用户都能调用，用于在会议里指定负责人与成员 ——
   * 普通用户没有 user:read 权限，不能走完整用户列表接口。
   * 只暴露姓名与手机号，不含角色、启用状态、创建时间等管理信息。
   *
   * 注意：必须声明在 `:id` 相关路由之前，避免被当成 id 参数解析。
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

  /**
   * 以指定账号身份浏览（代登）。
   *
   * 仅超级管理员可用：代登能完整看到对方数据，
   * 因此不给管理员开放，避免管理员越权查看用户私有会议。
   */
  @Post(':id/impersonate')
  @RequireRoles('SUPER_ADMIN')
  impersonate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.usersService.impersonate(user, id);
  }
}
