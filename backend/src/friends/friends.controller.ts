import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { FriendsService } from './friends.service';
import { AddFriendDto } from './dto/friends.dto';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/auth.decorators';

/**
 * 好友关系。
 *
 * 好友是个人会议的唯一受邀来源（文档 §2.6），所以这几个接口
 * **不额外要求任何权限位** —— 登录即可用。加限制反而会让
 * 纯个人用户（只有 MEMBER 角色）用不了自己的功能。
 */
@Controller('friends')
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  /** 我的好友列表 */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.friends.list(user);
  }

  /** 按手机号加好友（幂等） */
  @Post()
  add(@Body() dto: AddFriendDto, @CurrentUser() user: AuthenticatedUser) {
    return this.friends.add(user, dto.phone);
  }

  /** 删好友（幂等，两行一起删） */
  @Delete(':userId')
  remove(
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.friends.remove(user, userId);
  }
}
