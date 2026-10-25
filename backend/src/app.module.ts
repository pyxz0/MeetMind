
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ConfigModule } from '@nestjs/config'
import { validateEnv } from './common/env'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { AiModule } from './ai/ai.module'
import { MeetingsModule } from './meetings/meetings.module'
import { AsrModule } from './asr/asr.module'
import { PrismaModule } from './common/prisma.module'
import { AuthModule } from './auth/auth.module'
import { UsersModule } from './users/users.module'
import { InboxModule } from './inbox/inbox.module'
import { MessagesModule } from './messages/messages.module'
import { AuditModule } from './audit/audit.module'
import { JwtAuthGuard } from './auth/jwt-auth.guard'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // 兼容两种位置：backend/.env（本地）与仓库根 .env（Docker 编排）
      envFilePath: ['.env', '../.env'],
      // 缺少 DATABASE_URL / JWT_SECRET 时启动即失败，避免运行到一半才 500
      validate: validateEnv,
    }),
    PrismaModule,
    // AuthModule 为 @Global，JwtModule / AuthService / 守卫在全局可用
    AuthModule,
    UsersModule,
    InboxModule,
    MessagesModule,
    AuditModule,
    AiModule,
    MeetingsModule,
    AsrModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    /**
     * 全局注册 JWT 守卫：默认所有接口都需要登录，
     * 只有显式标了 @Public() 的接口放行（fail-closed）。
     */
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
