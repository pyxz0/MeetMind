import api from './http'

/** 一条审计记录 */
export interface AuditLogItem {
  id: number
  action: string
  resourceType: string
  resourceId: string | null
  metadata: Record<string, unknown> | null
  ip: string | null
  createdAt: string
  /** 代登时记录真实操作者 */
  impersonatedBy: number | null
  actor: { id: number; name: string; phone: string } | null
}

export interface AuditLogPage {
  items: AuditLogItem[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

export interface AuditLogQuery {
  page?: number
  pageSize?: number
  action?: string
  resourceType?: string
  actorId?: number
}

/** 分页查询审计日志（需要 audit:read 权限） */
export const listAuditLogs = async (
  query: AuditLogQuery = {}
): Promise<AuditLogPage> => {
  const response = await api.get<AuditLogPage>('/audit-logs', {
    params: query
  })

  return response.data
}
