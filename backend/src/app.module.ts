
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ConfigModule } from '@nestjs/config'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { AiModule } from './ai/ai.module'
import { MeetingsModule } from './meetings/meetings.module'
import { PrismaModule } from './common/prisma.module'
import { AuthModule } from './auth/auth.module'
import { UsersModule } from './users/users.module'
import { InboxModule } from './inbox/inbox.module'
import { JwtAuthGuard } from './auth/jwt-auth.guard'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    // AuthModule 为 @Global，JwtModule / AuthService / 守卫在全局可用
    AuthModule,
    UsersModule,
    InboxModule,
    AiModule,
    MeetingsModule,
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
