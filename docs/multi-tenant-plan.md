# MeetMind 多租户改造方案

> 目标：让同一套服务同时服务多个企业（每个企业 = 一个 tenant），
> 为「上架飞书/企微/腾讯会议应用市场」和「公网独立站」做前置准备。
>
> 本文只做设计，不改现有代码。配套的可执行 SQL 草稿见
> [`backend/prisma/drafts/0001_multitenant.sql`](../backend/prisma/drafts/0001_multitenant.sql)，
> 该目录不在 `prisma/migrations/` 下，`prisma migrate deploy` 不会执行它。

---

## 0. 结论先看

| 问题 | 结论 |
|---|---|
| 必须做吗 | **必须**。应用市场模式下，一个应用要服务 N 个企业，现有「全局唯一手机号 + 全局唯一超管」会直接冲突 |
| 改造范围 | 比预想小：只需给 **6 张"根表"** 加 `tenant_id`，子表通过会议继承 |
| 为什么可以只改根表 | 权限判定是集中的：待办/决策/成员/共享的访问都要先过 `assertCan*` → `resolveMeetingAccess`，只要那个函数带租户，子表就跟着安全 |
| 最大风险 | `visibleMeetingWhere` 在管理员分支返回 `{}`（无过滤），多租户后必须改成 `{ tenantId }`，漏掉这一处就是**跨租户全量泄露** |
| 工期 | 约 **2.5–3 周**（含隔离测试），不含平台对接 |
| 落地方式 | 单库共享 schema + `tenant_id` + Prisma 查询注入；Postgres RLS 作为第二阶段硬化 |

---

## 1. 现有模型里的三个硬冲突

### 1.1 手机号全局唯一

```prisma
// backend/prisma/schema.prisma:100
phone String @unique @db.VarChar(20)
```

企业 A 和 企业 B 都可能有 `13800138000`。上架后第二个企业安装就开始报唯一键冲突。

### 1.2 超级管理员全局唯一

迁移 [`20261018010107_single_super_admin`](../backend/prisma/migrations/20261018010107_single_super_admin/migration.sql) 建的是：

```sql
CREATE UNIQUE INDEX "users_single_super_admin_key"
  ON "users" ("role")
  WHERE "role" = 'SUPER_ADMIN';
```

一个应用服务 100 个企业，就应该有 100 个超管，这条索引会让第 2 个企业永远装不上。

### 1.3 "全局权限"其实是"全库权限"

```ts
// backend/src/meetings/meetings.access.ts:49
export const hasGlobalMeetingAccess = (user: AuthenticatedUser) =>
  roleHasPermission(user.role, PERMISSIONS.MEETING_READ_ALL);
```

名字叫 global，语义上却是 `READ_ALL`。多租户后必须变成 `READ_ALL_WITHIN_TENANT`，
否则 A 公司的 ADMIN 输入一个 id 就能读到 B 公司的会议。

> 这三条不是"顺手优化"，是上架的准入门槛。做完之前，应用市场审核即使通过也跑不起来。

---

## 2. 目标模型

采用**单库共享 schema + `tenant_id`**，不做 schema-per-tenant：

- Prisma 迁移工具对多 schema 支持差，schema-per-tenant 会让迁移变成 N 次执行
- 租户数量预期在百级、单租户数据量小，共享 schema 的隔离成本可接受
- 真正敏感的企业客户走**私有化部署**（一个租户一个库），这条产品线本来就存在

### 2.1 哪些表加 `tenant_id`

| 表 | 加 | 理由 |
|---|:--:|---|
| `tenants`（新） | — | 租户主表本身 |
| `users` | ✅ | 手机号唯一性要按租户重算；守卫每次回库查的就是它 |
| `meetings` | ✅ | 数据归属的根，所有子表的租户来源 |
| `audit_logs` | ✅ | 审计必须能按企业导出/隔离，且是企业采购时的硬要求 |
| `meeting_generations` | ✅ | 后台任务要能按租户恢复/清理 |
| `meeting_notices` | ✅ | 收件箱消息按租户推送 |
| `inbox_reads` | ✅ | 同上 |
| `meeting_decisions` / `meeting_todos` / `meeting_leaders` / `meeting_members` / `meeting_shares` | ❌ | 全部经会议访问，开会话时已校验；避免双写不一致 |

**不加子表 `tenant_id` 的前提**：所有子表操作必须先解析出 `meetingId` 并过 `assertCan*`。
当前代码已经是这个模式（见 §5.4），所以成立；未来新增子表也必须遵守。

### 2.2 新表

```prisma
/// 租户：一个企业 = 一个租户。
/// 平台安装的租户由 platform + external_id 唯一确定；
/// 私有化/独立站的租户 external_id 为空。
model Tenant {
  id         String   @id @default(uuid()) @db.Uuid
  name       String   @db.VarChar(120)
  /// feishu / wecom / tencent / standalone
  platform   String   @default("standalone") @db.VarChar(32)
  /// 平台侧的企业标识（飞书 tenant_key、企微 corpid、腾讯会议企业 id）
  externalId String?  @map("external_id") @db.VarChar(120)
  status     String   @default("ACTIVE") @db.VarChar(20)
  plan       String   @default("free") @db.VarChar(32)
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt  DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  users    User[]
  meetings Meeting[]

  @@unique([platform, externalId])
  @@map("tenants")
}
```

`id` 用 UUID 而不是自增：租户 id 会出现在 URL/日志/审计里，自增会泄露客户数量。

### 2.3 唯一约束改写

```prisma
// User
tenantId String @map("tenant_id") @db.Uuid
tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)
phone    String @db.VarChar(20)       // 去掉 @unique

@@unique([tenantId, phone])
@@index([tenantId, role])
```

超管唯一性改成**每租户一个**（手写 SQL，Prisma schema 表达不了带 WHERE 的索引）：

```sql
CREATE UNIQUE INDEX "users_single_super_admin_key"
  ON "users" ("tenant_id", "role")
  WHERE "role" = 'SUPER_ADMIN';
```

> ⚠️ 迁移注释里的旧提醒仍然有效：这条索引不在 `schema.prisma` 里，
> `prisma migrate dev` 会把它当成"多余索引"建议删除。**必须保留**。

---

## 3. 租户上下文怎么传

### 3.1 好消息：JWT 不用改

`JwtAuthGuard` 每个请求都会回库读用户（[`jwt-auth.guard.ts:81`](../backend/src/auth/jwt-auth.guard.ts#L81)），
所以租户 id 直接从用户行取即可，**不必往 token 里加 `tid`**：

```ts
const user = await this.prisma.user.findUnique({
  where: { id: userId },
  select: { id: true, phone: true, name: true, role: true, isActive: true,
            tenantId: true },   // ← 新增
});
```

好处：已有 token 全部继续有效，不需要强制重新登录；代登（`imp` 声明）也天然落在目标用户的租户里。

### 3.2 AsyncLocalStorage 承载当前租户

```ts
// backend/src/common/tenant-context.ts（新建）
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<string>();

export const TenantContext = {
  run<T>(tenantId: string, fn: () => T): T {
    return als.run(tenantId, fn);
  },
  get(): string | undefined {
    return als.getStore();
  },
  /** 只有后台任务 / 安装回调可以调用；HTTP 请求内调用直接抛错 */
  assertUnscoped(reason: string): void {
    if (als.getStore()) {
      throw new Error(`禁止在租户上下文中执行全库操作：${reason}`);
    }
  },
};
```

在 `JwtAuthGuard` 里包住后续处理：

```ts
request.user = currentUser;
return TenantContext.run(currentUser.tenantId, () => true);
```

> ⚠️ 注意：`CanActivate` 返回 `true` 后，Nest 继续走 pipe/handler 时**已经离开了 `als.run` 的同步作用域**。
> 正确做法是用拦截器（`NestInterceptor`）包住 `next.handle()`：
>
> ```ts
> intercept(ctx: ExecutionContext, next: CallHandler) {
>   return TenantContext.run(ctx.switchToHttp().getRequest().user.tenantId,
>     () => next.handle());
> }
> ```
>
> 这是最容易踩的一个坑：写成守卫里 run，业务代码里 `get()` 永远是 `undefined`。

### 3.3 Prisma 自动注入

`PrismaService` 里增加一个"按当前租户取扩展客户端"的入口，**调用方一行不用改**：

```ts
// backend/src/common/prisma.service.ts（改造后骨架）
import { Prisma, PrismaClient } from '@prisma/client';
// import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
// import { PrismaPg } from '@prisma/adapter-pg';

const TENANT_SCOPED = new Set([
  'User', 'Meeting', 'AuditLog', 'MeetingGeneration',
  'MeetingNotice', 'InboxRead',
]);

const tenantExtension = (tenantId: string) =>
  Prisma.defineExtension({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_SCOPED.has(model)) return query(args);

          const a = (args ?? {}) as Record<string, any>;

          // 读 / 批量改 / 批量删：强制 AND 上租户
          if (/^(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|count|aggregate|groupBy|updateMany|deleteMany)$/.test(operation)) {
            a.where = { AND: [{ tenantId }, a.where ?? {}] };
          }

          // 单条写：补 data
          if (operation === 'create') {
            a.data = { ...a.data, tenantId };
          }
          if (operation === 'createMany') {
            const rows = Array.isArray(a.data) ? a.data : [a.data];
            a.data = rows.map((r: any) => ({ ...r, tenantId }));
          }

          return query(a);
        },
      },
    },
  });

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly base: PrismaClient;
  private readonly cache = new Map<string, PrismaClient>();

  constructor() {
    this.base = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
    });
  }

  /** 当前请求的客户端；无租户上下文时返回原始客户端（仅后台任务会走到） */
  private get db(): PrismaClient {
    const tenantId = TenantContext.get();
    if (!tenantId) return this.base;

    let scoped = this.cache.get(tenantId);
    if (!scoped) {
      scoped = this.base.$extends(tenantExtension(tenantId)) as unknown as PrismaClient;
      this.cache.set(tenantId, scoped);
    }
    return scoped;
  }

  // 现有 107 处调用点全部走这些 getter，签名不变
  get user() { return this.db.user; }
  get meeting() { return this.db.meeting; }
  get meetingLeader() { return this.db.meetingLeader; }
  get meetingMember() { return this.db.meetingMember; }
  get meetingShare() { return this.db.meetingShare; }
  get meetingGeneration() { return this.db.meetingGeneration; }
  get meetingNotice() { return this.db.meetingNotice; }
  get inboxRead() { return this.db.inboxRead; }
  get todo() { return this.db.todo; }
  get decision() { return this.db.decision; }
  get auditLog() { return this.db.auditLog; }
  get tenant() { return this.base.tenant; }   // 租户表本身不注入

  // 事务必须在扩展客户端上开，否则回调里的 tx 不带租户。
  // 两种调用形式都要保留：项目里都在用
  //   - 回调形式：meetings.service.ts:1177
  //   - 数组形式：users.service.ts:480
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  $transaction<const P extends readonly Promise<unknown>[]>(
    ops: P,
  ): Promise<{ [K in keyof P]: Awaited<P[K]> }>;
  $transaction(arg: unknown): Promise<unknown> {
    return typeof arg === 'function'
      ? this.db.$transaction(arg as never)
      : this.db.$transaction(arg as never);
  }

  /** 原始 SQL 绕过扩展，调用方必须自己带租户条件（见 §4 要点 3） */
  get $executeRaw(): PrismaClient['$executeRaw'] {
    return this.db.$executeRaw.bind(this.db) as PrismaClient['$executeRaw'];
  }

  async onModuleInit() { await this.base.$connect(); }
  async onModuleDestroy() { await this.base.$disconnect(); }
}
```

要点与坑：

1. **必须按 tenantId 缓存扩展客户端**。`$extends()` 每次返回新对象，不缓存会在每个查询上重建一层代理。
2. **`findUnique` 注入额外条件**依赖 Prisma 的 extendedWhereUnique（Prisma 5+ GA，本项目 7.x 没问题）。
3. **`$executeRaw` 不会被扩展拦截**。现有 [`users.service.ts:481`](../backend/src/users/users.service.ts#L481)
   的 `INSERT ... SELECT` / `DELETE FROM meeting_leaders` 必须手写租户条件（或者确保入参 `targetId` 已在本租户内校验过）。
4. **`$transaction` 回调里的 `tx`**：在扩展客户端上调 `$transaction`，回调拿到的 `tx` 也是扩展过的，所以上面的 `$transaction` 包装是必要的——不要用 `this.base.$transaction`。
5. 后台任务没有租户上下文，拿到的是原始客户端。**这是故意的**：提醒扫描、任务恢复必须跨租户。这类代码要显式标注并走白名单。

---

## 4. 危险点清单（按危险程度排序）

> 这份清单是改造时的 checklist，每一条都对应现有行号，改完逐条打勾。

### ⭐⭐⭐⭐⭐ `visibleMeetingWhere` 的管理员分支

```ts
// backend/src/meetings/meetings.service.ts:747
private visibleMeetingWhere(user: AuthenticatedUser): Prisma.MeetingWhereInput {
  if (hasGlobalMeetingAccess(user)) {
    return {};            // ← 多租户后这是"看全库"
  }
  ...
}
```

改为：

```ts
  if (hasGlobalMeetingAccess(user)) {
    return { tenantId: user.tenantId };
  }
```

`getStats`、`findAll`、`findDrafts` 都从它派生，所以只要改这一处，统计和列表一起修好。
**但 `findOne` / 详情页不走它**，见下一条。

### ⭐⭐⭐⭐⭐ `resolveMeetingAccess` 的入口查询

```ts
// backend/src/meetings/meetings.access.ts:126
const meeting = await prisma.meeting.findUnique({
  where: { id: meetingId },
  ...
});
```

`id` 是全局自增，B 公司的会议 id 也存在。这里必须带租户：

```ts
const meeting = await prisma.meeting.findUnique({
  where: { id: meetingId, tenantId: user.tenantId },
  ...
});
```

带 Prisma 扩展后这行会被自动注入，但**不要把安全性寄托在扩展上**——这个函数是所有权限判定的唯一入口，
显式写出来，将来有人绕过扩展（比如用原始客户端）也不会失守。

### ⭐⭐⭐⭐⭐ 全局角色的跨租户越权

```ts
// backend/src/meetings/meetings.access.ts:164
if (hasGlobalMeetingAccess(user)) {
  return finish(roleHasPermission(...) ? 'edit' : 'read');
}
```

前置条件必须是"该会议属于我的租户"。改完上一条后天然满足（查不到就是 404），
但建议同时把 `hasGlobalMeetingAccess` 改名：

```ts
export const hasTenantWideMeetingAccess = (user: AuthenticatedUser) => ...;
```

名字骗人是这类漏洞的常见来源；`global` 这个词在 107 处调用点里会持续误导后来的人。

### ⭐⭐⭐⭐ `UsersService.list` 的空 where

```ts
// backend/src/users/users.service.ts:68
const where: Record<string, unknown> = {};   // 超管分支 = 查全库
```

改成从 `{ tenantId: operator.tenantId }` 起步。`listContacts`（[:122](../backend/src/users/users.service.ts#L122)）
同样要加，否则通讯录里会看到别家公司的员工。

### ⭐⭐⭐⭐ 后台任务的跨租户行为

| 位置 | 现象 | 处理 |
|---|---|---|
| [`ai.service.ts:524`](../backend/src/ai/ai.service.ts#L524) `onModuleInit` | 启动时把**全库** `PENDING/RUNNING` 任务标记失败。多租户 + 多副本下，任何一次滚动发布都会杀掉其他实例正在跑的任务 | 上队列后删掉这段；过渡期至少加 `instanceId` 过滤 |
| [`inbox.service.ts:64`](../backend/src/inbox/inbox.service.ts#L64) `setInterval` | 每分钟全表扫描。N 个副本 = N 份扫描 | 短期靠唯一索引幂等（已有），长期改为队列定时任务 |

### ⭐⭐⭐ 子表操作的间接性

[`meetings.service.ts:634`](../backend/src/meetings/meetings.service.ts#L634)、
[:1164](../backend/src/meetings/meetings.service.ts#L1164)、[:1323](../backend/src/meetings/meetings.service.ts#L1323)
都是 `todo.findUnique({ where: { id } })` → 再 `assertCan*(todo.meetingId)`。

这个模式是安全的（只要 `resolveMeetingAccess` 修好）。**但它是"约定"不是"约束"**，
新增待办相关接口时很容易写成直接 `todo.update({ where: { id } })`。
建议在 `meetings.service.ts` 里加一个私有方法 `loadTodoOrThrow(id, user)`，把"查 + 鉴权"合并成一个不可绕过的入口。

### ⭐⭐⭐ 审计日志的租户归属

`AuditService.record(actor, entry)`（[`audit.service.ts:34`](../backend/src/audit/audit.service.ts#L34)）
目前靠 `actor.id` 隐式归属。多租户后 `tenant_id` 由扩展自动补，但**系统级动作没有 actor**（比如平台回调），
这类记录要显式传 tenantId，否则会出现 `tenant_id = null` 的孤儿审计。

### ⭐⭐ 唯一键相关的错误提示

`register`（[`auth.service.ts:107`](../backend/src/auth/auth.service.ts#L107)）和
`create`（[`users.service.ts:175`](../backend/src/users/users.service.ts#L175)）都是"先查再插"，
并发下会撞唯一键。多租户后错误信息要区分"本企业内已存在"，不能再说"该手机号已被注册"（会泄露其他企业是否有这个号）。

---

## 5. 迁移步骤（零停机执行）

手写迁移草稿见 `backend/prisma/drafts/0001_multitenant.sql`。顺序不能变：

```
① 建 tenants + 插入"默认组织"（承载现有全部数据）
② 6 张根表 ADD COLUMN tenant_id UUID（可空）
③ UPDATE ... SET tenant_id = <默认组织> WHERE tenant_id IS NULL
④ 加 NOT NULL + 外键 + 索引
⑤ 重建 users 唯一键：drop users_phone_key → create (tenant_id, phone)
⑥ 重建超管索引：(tenant_id, role) WHERE role='SUPER_ADMIN'
```

要点：

- **分两次发布，顺序不能颠倒**：
  1. 先执行 ①②③（加列 + 回填，列仍然可空），发布"开始写 `tenant_id`"的代码；
  2. 观察 `SELECT count(*) FROM users WHERE tenant_id IS NULL` 一段时间，确认没有新增空值；
  3. 再执行 ④⑤⑥（NOT NULL + 外键 + 唯一键切换）。
  直接一次性跑完会在滚动发布期间失败：老实例还在插入不带 `tenant_id` 的行，
  `SET NOT NULL` 之后这些插入立刻报错。
- **`users_phone_key` 是唯一索引，不是表约束**（已核对：
  [`switch_email_to_phone/migration.sql:38`](../backend/prisma/migrations/20261018181520_switch_email_to_phone/migration.sql#L38)
  用的是 `CREATE UNIQUE INDEX`）。所以必须 `DROP INDEX`，写成
  `ALTER TABLE ... DROP CONSTRAINT` 会**静默什么都不做**——随后再建租户内唯一索引也不报错，
  最后两个索引并存，第二个企业永远装不进来。这是本方案里最隐蔽的一个坑。
- 现有数据默认全部归入"默认组织"，私有化客户升级后即是单租户，行为不变。
- 验收查询已写在 SQL 草稿末尾（6 组断言，其中第 6 组直接验证"同一手机号可在两个租户注册"）。

---

## 6. RLS：建议**第二阶段**再做，但别做错

Postgres 行级安全是跨租户泄露的最终兜底：

```sql
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meetings
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

**为什么建议后置**：用 `pg` 连接池时，`SET app.tenant_id` 是**会话级**的，
连接被复用后会泄漏到下一个请求。要正确实现必须：

- 每个请求包在事务里用 `SET LOCAL`，或者
- 用 Prisma 的 `$transaction` 逐请求包裹（本项目 1475 行的 service 里到处是独立查询，改造面很大）

**推荐做法**：先上 Prisma 扩展 + 隔离测试（§7 已能拦住绝大多数问题）；
等有真实企业客户要求"数据库层强制隔离"时，再引入 RLS，并且**加一个独立的数据库角色**
（应用用非 owner 角色连接，owner 保留给迁移），否则表 owner 会绕过策略。

一句更重要的话：**RLS 不是替代代码审查的**。它防的是"漏写 where"，不是"写错 where"。

---

## 7. 测试策略（这是验收的唯一标准）

现有 CI 跑真库迁移 + 冒烟（[`ci.yml:56`](../.github/workflows/ci.yml#L56)），加一组双租户端到端用例：

| 用例 | 断言 |
|---|---|
| A 租户普通用户按 id 访问 B 租户会议 | 404（不是 403） |
| A 租户 ADMIN 访问 B 租户会议 | 404 |
| A 租户 ADMIN 的会议列表 / 统计 | 只含 A 的数据 |
| A 租户通讯录 | 不含 B 的员工 |
| A 租户搜手机号（与 B 员工同号） | 只返回 A 的 |
| A 用户勾选 B 的待办 | 404 |
| A 的审计日志 | 不含 B 的动作 |
| 平台回调创建两个租户 | 各自超管唯一，互不冲突 |
| 并发注册同号不同租户 | 两边都成功 |

**建议**：这组用例写在一个 `test/tenant-isolation.e2e-spec.ts` 里，
每个用例前用固定种子重建两个租户，不要依赖生产数据。

---

## 8. 工期

| 任务 | 人日 |
|---|---|
| Prisma schema 变更 + 手写迁移 + 本地/CI 验证 | 2–3 |
| `TenantContext` + 拦截器 + `PrismaService` 改造 | 2 |
| 107 处调用点审计（重点在 `meetings.service.ts` 1475 行） | 5–7 |
| `visibleMeetingWhere` / `resolveMeetingAccess` / `hasGlobalMeetingAccess` 语义修正 | 1 |
| 双租户隔离测试套件 | 2–3 |
| 现有单元测试修复 + 回归 | 1–2 |
| **合计** | **≈ 13–18 人日（2.5–3.5 周）** |

比上一轮估的 3 周略低，原因是确认了"权限判定集中"这个结构优势——比逐表加 `tenant_id` 便宜得多。

---

## 9. 验收标准（Definition of Done）

- [ ] 两个租户可同时存在，各自的超管、手机号、会议互不干扰
- [ ] 双租户隔离用例全绿，且**故意注释掉租户过滤后用例必须变红**（验证测试真的有效）
- [ ] 现有单租户部署升级后，数据完整、行为不变（默认组织）
- [ ] 全库搜索 `return {}` / `where: {}`，无残留的全库查询
- [ ] 全库搜索 `hasGlobalMeetingAccess`，全部替换为带租户语义的名字
- [ ] `$executeRaw` 调用点逐个确认租户条件
- [ ] CI 增加"启动两个租户的冒烟"步骤

---

## 10. 演练记录（已跑通，2026-xx）

环境：一次性 `postgres:16-alpine` 容器（PG 16.15），从零 `prisma migrate deploy` →
插入种子数据（3 用户 / 1 会议 / 待办 / 决策 / 负责人 / 成员 / 共享 / 2 条审计 / 2 个生成任务 / 通知 / 已读）
→ 执行 `drafts/0001_multitenant.sql` → 校验 → 回滚 → 再校验。容器用完即删。

**通过的断言**

| # | 断言 | 结果 |
|---|---|---|
| 1 | 全局 `users_phone_key` 消失，只剩 `users_tenant_id_phone_key` | ✅ |
| 2 | 超管索引变成 `(tenant_id, role) WHERE role='SUPER_ADMIN'` | ✅ |
| 3 | 六张根表 NULL 租户数全为 0 | ✅ |
| 4 | 每租户超管数 = 1 | ✅ |
| 5 | 跨租户脏数据（会议-创建者、审计-操作者）为 0 | ✅ |
| 6 | 同一手机号在租户 A / B 分别注册成功 | ✅ |
| 7 | 负例：同租户第二个超管 → 被 `users_single_super_admin_key` 拒 | ✅ |
| 8 | 负例：同租户重复手机号 → 被 `users_tenant_id_phone_key` 拒 | ✅ |
| 9 | 回滚脚本可完整还原（列、索引、tenants 表） | ✅ |
| 10 | **反例**：把 `DROP INDEX` 改回 `DROP CONSTRAINT` 后重跑，迁移必须**失败回滚** | ✅ 见下 |

**演练抓到的一个真 bug（已修 + 已加防回归）**

草稿最初写的是 `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_phone_key"`。
但 `users_phone_key` 是 **`CREATE UNIQUE INDEX`** 建的索引，不是表约束
（[`switch_email_to_phone/migration.sql:38`](../backend/prisma/migrations/20261018181520_switch_email_to_phone/migration.sql#L38)）。
用它跑出来的实际输出是：

```text
NOTICE:  constraint "users_phone_key" of relation "users" does not exist, skipping
```

**只是一条 NOTICE**。Postgres 不把它当错误，`psql` 退出码是 0，CI 和部署流水线全绿。
紧接着的 `CREATE UNIQUE INDEX` 也不报错，最终"全局唯一"和"租户内唯一"两个索引并存——
**第二个企业永远装不进来，而日志里没有任何异常。**

修复分两层：

1. **改对语句**：`DROP INDEX IF EXISTS "users_phone_key";`
2. **让这一类错误再也藏不住**：迁移末尾加了 ⑦ 后置断言（`DO $$ ... RAISE EXCEPTION`），
   校验"全局唯一索引已消失、租户内唯一索引已存在、超管索引已按租户、回填无空值"，
   任何一条不满足整个事务回滚。

第 2 层才是真正的修复——**根因不是拼错了关键字，而是 DDL 的"静默无操作"特性**。

**反例回归（证明断言有效）**

拿一个故意改坏的版本（`DROP INDEX` 换回 `DROP CONSTRAINT`）跑同一套演练：

```text
NOTICE:  constraint "users_phone_key" of relation "users" does not exist, skipping
ERROR:   users_phone_key 仍然存在：DROP INDEX 没生效。全局手机号唯一会让第二个企业装不进来
```

退出码 1、容器删除。**没有第 2 层的话，这条 NOTICE 会被所有人忽略。**

**一条命令复现整套演练**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/db/rehearse-multitenant.ps1
```

它自己起容器、跑迁移、插种子、执行草稿、跑验收、删容器；任何一步不满足断言就返回 1。
验收断言独立成文件 [`0001_multitenant.verify.sql`](../backend/prisma/drafts/0001_multitenant.verify.sql)：
负例用 `BEGIN ... EXCEPTION WHEN unique_violation` 包住（**期望它失败**，成功了反而报错），
回滚演练在事务里做、结尾 `ROLLBACK`，不会把库改坏，可重复执行。

**另一个会让后续脚本踩坑的地方**

`users.updated_at` 在迁移里被 `DROP DEFAULT` 了（Prisma 的 `@updatedAt` 由客户端负责写）。
任何直接用 SQL 造用户数据的脚本（种子、演练、修数据）都必须显式给 `updated_at`，否则插入失败。

**回滚的前提**：若已出现"同一手机号存在于多个租户"，回滚前必须先删掉多出来的用户，
否则重建全局唯一索引会失败。这条已写进 SQL 草稿的回滚注释。
