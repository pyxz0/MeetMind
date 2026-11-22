import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma.module';
import { SystemModule } from '../system/system.module';
import { NotificationsService } from './notifications.service';
import { OverdueReminderService } from './overdue-reminder.service';
import { WeComNotifier } from './wecom-notifier.service';

/**
 * 提醒投递。
 *
 * 三个出口：
 * - NotificationsService  消费 meeting_notices，把站内消息发到邮箱（每 2 分钟）
 * - OverdueReminderService 扫逾期未完成的待办（每天一次），同时产出邮件与群消息
 * - WeComNotifier         企业微信群机器人；未配置 WECOM_WEBHOOK_URL 时自动停用
 *
 * MailService 由全局的 AuthModule 导出，这里直接注入即可，
 * 不重复 provide —— 否则会建出第二个 nodemailer 连接池。
 */
@Module({
  imports: [PrismaModule, SystemModule],
  providers: [NotificationsService, OverdueReminderService, WeComNotifier],
  exports: [NotificationsService, OverdueReminderService, WeComNotifier],
})
export class NotificationsModule {}
