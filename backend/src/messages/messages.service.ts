import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MessageKind, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';

/** 私信发送的正文（文字，或图片/文件的说明文字） */
export interface SendMessageInput {
  content?: string;
  kind?: 'TEXT' | 'IMAGE' | 'FILE';
}

/** 附件元信息（由 controller 在落盘后传入） */
export interface MessageAttachmentInput {
  originalname: string;
  mimetype: string;
  size: number;
  path: string;
  filename: string;
  isImage: boolean;
}

/** 会话列表条目（对当前用户） */
export interface ConversationSummary {
  id: number;
  peerId: number;
  peerName: string;
  peerPhone: string;
  peerAvatar: string | null;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
}

/** 单条消息 */
export interface MessageView {
  id: number;
  conversationId: number;
  senderId: number;
  senderName: string;
  kind: MessageKind;
  content: string | null;
  createdAt: string;
  mine: boolean;
  attachments: Array<{
    id: number;
    fileName: string;
    sizeBytes: number;
    mimeType: string;
    isImage: boolean;
    url: string;
  }>;
}

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 我参与的会话列表，按最后一条消息时间倒序。
   *
   * 每个会话返回「对方」的信息 + 最后一条消息摘要 + 我的未读数。
   */
  async listConversations(user: AuthenticatedUser): Promise<ConversationSummary[]> {
    const conversations = await this.prisma.conversation.findMany({
      where: {
        OR: [{ userAId: user.id }, { userBId: user.id }],
      },
      include: {
        userA: { select: { id: true, name: true, phone: true, avatar: true } },
        userB: { select: { id: true, name: true, phone: true, avatar: true } },
        messages: {
          orderBy: { id: 'desc' },
          take: 1,
          select: { id: true, content: true, kind: true, createdAt: true },
        },
        members: { where: { userId: user.id }, select: { lastReadMessageId: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // 一次性查出每个会话的未读数（基于最后一条消息 id 与我的已读游标）
    const unreadMap = await this.unreadCounts(
      user.id,
      conversations.map((c) => c.id),
    );

    return conversations.map((conv) => {
      const peer = conv.userAId === user.id ? conv.userB : conv.userA;
      const last = conv.messages[0];

      return {
        id: conv.id,
        peerId: peer.id,
        peerName: peer.name,
        peerPhone: peer.phone,
        peerAvatar: peer.avatar,
        lastMessage: last
          ? this.previewContent(last.kind, last.content)
          : '开始聊天吧',
        lastMessageAt: last?.createdAt.toISOString() ?? conv.updatedAt.toISOString(),
        unreadCount: unreadMap.get(conv.id) ?? 0,
      };
    });
  }

  /** 精确统计每个会话的未读数（基于 lastReadMessageId 与最后一条消息） */
  private async unreadCounts(
    userId: number,
    conversationIds: number[],
  ): Promise<Map<number, number>> {
    if (!conversationIds.length) return new Map();

    // 每个会话的最后一条消息 id（只有它比已读游标大才算未读）
    const lastMessages = await this.prisma.message.groupBy({
      by: ['conversationId'],
      where: { conversationId: { in: conversationIds } },
      _max: { id: true },
    });

    const members = await this.prisma.conversationMember.findMany({
      where: { userId, conversationId: { in: conversationIds } },
      select: { conversationId: true, lastReadMessageId: true },
    });

    const readByConv = new Map(
      members.map((m) => [m.conversationId, m.lastReadMessageId]),
    );

    const result = new Map<number, number>();

    for (const row of lastMessages) {
      const lastId = row._max.id ?? 0;
      const readUpTo = readByConv.get(row.conversationId) ?? 0;

      // 只统计「对方发的、且我还没读」的消息数
      const unread = await this.prisma.message.count({
        where: {
          conversationId: row.conversationId,
          senderId: { not: userId },
          id: { gt: readUpTo },
        },
      });

      if (unread > 0) result.set(row.conversationId, unread);
    }

    return result;
  }

  /**
   * 发起或进入与某人的会话。
   *
   * 一对一：按 (minId, maxId) 找会话，不存在就创建。
   * 不允许和自己聊天。
   */
  async openConversation(user: AuthenticatedUser, peerId: number) {
    if (peerId === user.id) {
      throw new BadRequestException('不能和自己聊天');
    }

    const peer = await this.prisma.user.findUnique({
      where: { id: peerId },
      select: { id: true, isActive: true },
    });

    if (!peer) throw new NotFoundException('对方账号不存在');
    if (!peer.isActive) throw new BadRequestException('对方账号已停用');

    const [userAId, userBId] = user.id < peerId
      ? [user.id, peerId]
      : [peerId, user.id];

    const conversation = await this.prisma.conversation.upsert({
      where: { userAId_userBId: { userAId, userBId } },
      create: {
        userAId,
        userBId,
        createdBy: user.id,
        members: {
          create: [{ userId: userAId }, { userId: userBId }],
        },
      },
      update: {},
    });

    return { conversationId: conversation.id };
  }

  /** 获取某个会话的消息列表（含附件），并把我方的已读游标推进到最后一条 */
  async listMessages(
    user: AuthenticatedUser,
    conversationId: number,
  ): Promise<MessageView[]> {
    const conversation = await this.assertMember(user, conversationId);

    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      include: {
        sender: { select: { name: true } },
        attachments: { orderBy: { id: 'asc' } },
      },
      orderBy: { id: 'asc' },
    });

    // 拉取即视为已读：把游标推进到当前最后一条
    if (messages.length) {
      const lastId = messages[messages.length - 1].id;
      await this.prisma.conversationMember.updateMany({
        where: {
          conversationId,
          userId: user.id,
          lastReadMessageId: { lt: lastId },
        },
        data: { lastReadMessageId: lastId },
      });
    }

    return messages.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      senderName: m.sender.name,
      kind: m.kind,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      mine: m.senderId === user.id,
      attachments: m.attachments.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        sizeBytes: a.sizeBytes,
        mimeType: a.mimeType,
        isImage: a.isImage,
        url: `/api/messages/attachments/${a.id}`,
      })),
    }));
  }

  /** 发送一条消息（文字，或带附件）。会话不存在时自动创建。 */
  async sendMessage(
    user: AuthenticatedUser,
    conversationId: number,
    input: SendMessageInput,
    attachments: MessageAttachmentInput[] = [],
  ) {
    const conversation = await this.assertMember(user, conversationId);

    const kind = (input.kind ?? 'TEXT') as MessageKind;
    const content = input.content?.trim() || null;

    if (kind === 'TEXT' && !content) {
      throw new BadRequestException('消息内容不能为空');
    }

    if (attachments.length === 0 && kind !== 'TEXT') {
      throw new BadRequestException('请附带要发送的文件');
    }

    if (attachments.length > 5) {
      throw new BadRequestException('单条消息最多附带 5 个文件');
    }

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId,
          senderId: user.id,
          kind,
          content,
          attachments: {
            create: attachments.map((a) => ({
              fileName: a.originalname,
              storedPath: a.path,
              sizeBytes: a.size,
              mimeType: a.mimetype,
              isImage: a.isImage,
            })),
          },
        },
        include: { attachments: true },
      });

      // 推进双方会话活跃时间，并把我方已读游标同步到最后一条
      await tx.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });

      await tx.conversationMember.updateMany({
        where: { conversationId, userId: user.id },
        data: { lastReadMessageId: created.id },
      });

      return created;
    });

    return {
      id: message.id,
      conversationId,
      senderId: user.id,
      senderName: user.name,
      kind: message.kind,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
      mine: true,
      attachments: message.attachments.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        sizeBytes: a.sizeBytes,
        mimeType: a.mimeType,
        isImage: a.isImage,
        url: `/api/messages/attachments/${a.id}`,
      })),
    };
  }

  /** 校验当前用户是否是该会话成员，并返回会话（不是则 404，避免探测） */
  private async assertMember(user: AuthenticatedUser, conversationId: number) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        OR: [{ userAId: user.id }, { userBId: user.id }],
      },
    });

    if (!conversation) {
      throw new NotFoundException('会话不存在');
    }

    return conversation;
  }

  /** 鉴权下载附件：只允许会话双方下载 */
  async resolveAttachment(user: AuthenticatedUser, attachmentId: number) {
    const attachment = await this.prisma.messageAttachment.findUnique({
      where: { id: attachmentId },
      include: {
        message: {
          select: {
            conversation: { select: { userAId: true, userBId: true } },
          },
        },
      },
    });

    if (!attachment) throw new NotFoundException('附件不存在');

    const { userAId, userBId } = attachment.message.conversation;

    if (user.id !== userAId && user.id !== userBId) {
      throw new ForbiddenException('无权访问该附件');
    }

    return {
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      absolutePath: attachment.storedPath,
    };
  }

  /** 会话列表未读总数，供导航角标 */
  async unreadTotal(user: AuthenticatedUser): Promise<{ unreadTotal: number }> {
    const members = await this.prisma.conversationMember.findMany({
      where: { userId: user.id },
      select: { conversationId: true, lastReadMessageId: true },
    });

    let total = 0;

    for (const member of members) {
      const count = await this.prisma.message.count({
        where: {
          conversationId: member.conversationId,
          senderId: { not: user.id },
          id: { gt: member.lastReadMessageId },
        },
      });
      total += count;
    }

    return { unreadTotal: total };
  }

  /** 消息摘要：图片/文件用占位文案 */
  private previewContent(kind: MessageKind, content: string | null): string {
    if (kind === 'IMAGE') return '[图片]';
    if (kind === 'FILE') return content || '[文件]';
    return content ?? '';
  }
}
