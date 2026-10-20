import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';

/** 一条审计记录 */
export interface AuditEntry {
  /** 动作标识，形如 meeting.delete / user.update_role */
  action: string;
  /** 资源类型：meeting / user / share */
  resourceType: string;
  /** 资源 id（字符串，兼容未来的 uuid 主键） */
  resourceId?: string | number | null;
  /** 附加信息，如修改前后的值 */
  metadata?: Record<string, unknown> | null;
  /** 客户端 IP，便于追溯来源 */
  ip?: string | null;
}

/**
 * 审计日志。
 *
 * 设计要点：
 * - 写入失败绝不影响主流程（只记日志），审计不能成为业务单点故障
 * - actorId 可为空：账号被删后历史记录仍需保留
 * - 代登场景记录 impersonatedBy，能区分"超管以某人身份操作"
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 记录一次操作；内部吞掉所有异常 */
  async record(
    actor: Pick<AuthenticatedUser, 'id' | 'impersonatedBy'> | null,
    entry: AuditEntry,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: actor?.id ?? null,
          impersonatedBy: actor?.impersonatedBy ?? null,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId:
            entry.resourceId === undefined || entry.resourceId === null
              ? null
              : String(entry.resourceId),
          metadata: (entry.metadata ?? undefined) as never,
          ip: entry.ip ?? null,
        },
      });
    } catch (error) {
      // 审计失败不能影响业务，只记一条错误日志
      this.logger.error(
        `审计写入失败 action=${entry.action}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** 分页查询审计日志（管理员） */
  async list(query: {
    page?: number;
    pageSize?: number;
    action?: string;
    resourceType?: string;
    actorId?: number;
  }) {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize ?? 20)));

    const where = {
      ...(query.action ? { action: { contains: query.action } } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          action: true,
          resourceType: true,
          resourceId: true,
          metadata: true,
          ip: true,
          createdAt: true,
          impersonatedBy: true,
          actor: { select: { id: true, name: true, phone: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        metadata: row.metadata,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
        actor: row.actor,
        impersonatedBy: row.impersonatedBy,
      })),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }
}
