import { Module } from '@nestjs/common';
import { FriendsController } from './friends.controller';
import { FriendsService } from './friends.service';

/**
 * 好友关系模块。
 *
 * PrismaModule 与 AuthModule 都是 @Global，所以这里不需要 imports。
 */
@Module({
  controllers: [FriendsController],
  providers: [FriendsService],
  exports: [FriendsService],
})
export class FriendsModule {}
