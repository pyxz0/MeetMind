import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma.module';
import { NotificationsService } from './notifications.service';
import { OverdueReminderService } from './overdue-reminder.service';

/**
 * 邮件提醒投递。
 *
 * 两个独立的出口：
 * - NotificationsService  消费 meeting_notices，把站内消息发到邮箱（每 2 分钟）
 * - OverdueReminderService 扫逾期未完成的待办（每天一次）
 *
 * MailService 由全局的 AuthModule 导出，这里直接注入即可，
 * 不重复 provide —— 否则会建出第二个 nodemailer 连接池。
 */
@Module({
  imports: [PrismaModule],
  providers: [NotificationsService, OverdueReminderService],
  exports: [NotificationsService, OverdueReminderService],
})
export class NotificationsModule {}
