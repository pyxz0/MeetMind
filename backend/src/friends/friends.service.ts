import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AuthService } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';

/**
 * 好友关系。
 *
 * 个人会议只能邀请好友（文档 §2.6），这张表就是那道闸门。
 *
 * 设计要点：
 * - **双向存两行**（A→B 与 B→A）。查「我的好友」是一句 where: { userId: me }，
 *   不用 OR；加/删都在一个事务里同时处理两行，不会出现单向脏数据。
 * - **只能按手机号精确查找**。不做模糊搜索、不提供"可能认识的人"——
 *   那等于开放全平台用户枚举，企业客户第一个就会问这个。
 * - **不做申请-同意审批**：会议邀请本身就是一次告知，再加一层审批是双重摩擦。
 *   将来真出现骚扰，加一个 status 字段即可，表结构不用改。
 */
@Injectable()
export class FriendsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  /** 我的好友列表，按加好友时间倒序 */
  async list(user: AuthenticatedUser) {
    const rows = await this.prisma.friendship.findMany({
      where: { userId: user.id },
      select: {
        createdAt: true,
        friend: {
          select: {
            id: true,
            name: true,
            phone: true,
            avatar: true,
            isActive: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => ({
      id: row.friend.id,
      name: row.friend.name,
      phone: row.friend.phone,
      avatar: row.friend.avatar,
      isActive: row.friend.isActive,
      since: row.createdAt.toISOString(),
    }));
  }

  /**
   * 按手机号加好友。
   *
   * 幂等：已经是好友时直接返回，不报错 —— 用户在选人框里输两次同一个人
   * 是常事，弹个"你们已经是好友了"没有意义。
   */
  async add(user: AuthenticatedUser, phoneInput: string) {
    const phone = this.authService.normalizePhone(phoneInput);

    if (phone === user.phone) {
      throw new BadRequestException('不能加自己为好友');
    }

    const target = await this.prisma.user.findUnique({
      where: { phone },
      select: {
        id: true,
        name: true,
        phone: true,
        avatar: true,
        isActive: true,
      },
    });

    /**
     * 找不到就说找不到。
     *
     * 这里可以直说 —— 调用方必须知道对方的手机号才能发起，
     * 枚举成本是"试遍号段"，比模糊搜索高几个数量级。
     */
    if (!target) {
      throw new NotFoundException('未找到该用户');
    }

    if (!target.isActive) {
      throw new BadRequestException('该账号已被停用');
    }

    await this.prisma.$transaction([
      this.prisma.friendship.createMany({
        data: [
          { userId: user.id, friendId: target.id },
          { userId: target.id, friendId: user.id },
        ],
        skipDuplicates: true,
      }),
    ]);

    /** 回真实建立时间：可能是刚刚建的，也可能早就加过 */
    const relation = await this.prisma.friendship.findUnique({
      where: {
        userId_friendId: { userId: user.id, friendId: target.id },
      },
      select: { createdAt: true },
    });

    return {
      id: target.id,
      name: target.name,
      phone: target.phone,
      avatar: target.avatar,
      isActive: target.isActive,
      since: relation?.createdAt.toISOString() ?? new Date().toISOString(),
    };
  }

  /**
   * 删好友：两行一起删。
   *
   * 幂等：本来就不是好友也返回成功，客户端重试不该报错。
   *
   * **不联动清理会议参与关系**：邀请是独立动作。删好友不会把对方
   * 从已有会议里踢出去（类似微信群，删好友不等于退群）。
   * 想踢人就显式调移除成员接口。
   */
  async remove(user: AuthenticatedUser, friendId: number) {
    await this.prisma.friendship.deleteMany({
      where: {
        OR: [
          { userId: user.id, friendId },
          { userId: friendId, friendId: user.id },
        ],
      },
    });

    return { removed: true };
  }
}
