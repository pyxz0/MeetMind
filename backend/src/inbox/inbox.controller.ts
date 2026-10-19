import { Body, Controller, Get, Post } from '@nestjs/common';
import { InboxService } from './inbox.service';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.decorators';

@Controller('inbox')
export class InboxController {
  constructor(private readonly inboxService: InboxService) {}

  /** 收件箱：通知 + 待办提醒 + 未读数 */
  @Get()
  getInbox(@CurrentUser() user: AuthenticatedUser) {
    return this.inboxService.getInbox(user);
  }

  /** 侧边栏角标用：只取未读数 */
  @Get('unread-count')
  getUnreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.inboxService.getUnreadCount(user);
  }

  /**
   * 标记已读。
   *
   * 传 keys 只标记这几条（点击单条通知），不传则全部标记已读。
   */
  @Post('read')
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body?: { keys?: string[] },
  ) {
    return this.inboxService.markRead(user, body?.keys);
  }
}
