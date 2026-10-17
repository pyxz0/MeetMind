import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../auth/auth.decorators';
import { PERMISSIONS } from '../auth/permissions';
import { MeetingShareService } from './meeting-share.service';

@Controller('meetings')
export class MeetingShareController {
  constructor(private readonly shareService: MeetingShareService) {}

  /** 查看某场会议的共享名单（仅归属者 / 管理员） */
  @Get(':id/shares')
  @RequirePermissions(PERMISSIONS.MEETING_SHARE_OWN)
  listShares(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.shareService.listShares(id, user);
  }

  /** 共享会议给某人（重复调用等于更新权限） */
  @Post(':id/shares')
  @RequirePermissions(PERMISSIONS.MEETING_SHARE_OWN)
  share(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { userId?: number; permission?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const userId = body?.userId;

    if (typeof userId !== 'number' || !Number.isInteger(userId) || userId <= 0) {
      throw new BadRequestException('userId 必须是正整数');
    }

    const permission = (body?.permission ?? 'READ').toUpperCase();

    if (permission !== 'READ' && permission !== 'EDIT') {
      throw new BadRequestException('permission 只能是 READ 或 EDIT');
    }

    return this.shareService.shareMeeting(id, userId, permission, user);
  }

  /** 修改共享权限 */
  @Patch(':id/shares/:userId')
  @RequirePermissions(PERMISSIONS.MEETING_SHARE_OWN)
  updateShare(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() body: { permission?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const permission = (body?.permission ?? '').toUpperCase();

    if (permission !== 'READ' && permission !== 'EDIT') {
      throw new BadRequestException('permission 只能是 READ 或 EDIT');
    }

    return this.shareService.shareMeeting(id, userId, permission, user);
  }

  /** 撤销共享（被共享者也可用来自行退出） */
  @Delete(':id/shares/:userId')
  @RequirePermissions(PERMISSIONS.MEETING_SHARE_OWN)
  revoke(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.shareService.revokeShare(id, userId, user);
  }
}
