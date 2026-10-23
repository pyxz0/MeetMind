import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MailService } from '../common/mail.service';

/**
 * 认证与授权模块。
 *
 * 设为 @Global，使 JwtAuthGuard 可在任意模块用 APP_GUARD 注册，
 * 而不必每个业务模块重复 import。
 */
@Global()
@Module({
  imports: [
    /**
     * 必须用 registerAsync + ConfigService 读取密钥。
     *
     * 直接写 process.env.JWT_SECRET 会在模块求值时执行，
     * 那时 ConfigModule 还没把 .env 载入 process.env，
     * 结果 secret 为 undefined，签发 token 时报
     * "secretOrPrivateKey must have a value"。
     */
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');

        if (!secret) {
          // 宁可启动失败，也不要签发用弱密钥签名的 token
          throw new Error(
            '缺少 JWT_SECRET，请在 backend/.env 中配置后再启动服务',
          );
        }

        return {
          secret,
          signOptions: {
            // 7 天：会议类工具的使用频率下，过短会频繁要求重新登录
            expiresIn: '7d',
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, MailService],
  exports: [AuthService, JwtAuthGuard, JwtModule, MailService],
})
export class AuthModule {}
