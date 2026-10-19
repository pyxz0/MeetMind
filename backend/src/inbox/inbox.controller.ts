import { Controller, Get, Post } from '@nestjs/common';
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

  /** 标记通知全部已读 */
  @Post('read')
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.inboxService.markAllRead(user);
  }
}
