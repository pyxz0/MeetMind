# MeetMind 多租户改造方案 v2

> 平台模式：一个部署服务 N 个企业，账号全局唯一，个人空间与企业空间并存。
>
> 本文取代 [`multi-tenant-plan.md`](./multi-tenant-plan.md)（v1）。
> v1 保留作为历史记录 —— 它的迁移 SQL 演练、DDL 静默失败那一节仍然有效，不要删。
>
> 状态：设计稿，未改任何代码。行号核验时间 2026-11-24。

---

## 0. 先看结论：v2 与 v1 差在哪

| 项目 | v1 | v2 | 影响 |
|---|---|---|---|
| 产品形态 | ISV 多实例（每个企业独立安装） | **SaaS 平台**（一站多企业） | 决定了下面的所有差异 |
| 手机号唯一性 | 按租户唯一 `(tenant_id, phone)` | **保持全局唯一** | v1 的 §5⑤ 整段作废，不用 `DROP INDEX` |
| 超管唯一性 | 每租户一个 | **保持全局一个**（平台超管） | v1 的 §2.3 后半段、§5⑥ 作废 |
| 用户归属 | `users.tenant_id` 单值外键 | **`memberships` 关系表 + `users.active_tenant_id`** | 新增一张表，`tenant_id` 语义收窄 |
| 个人用户 | 存量全进"默认组织"，无个人空间 | **注册即建 PERSONAL 租户** | 新增 `tenants.type` |
| 会议归属 | 隐含 = 用户所属租户，无法选择 | **创建时可选企业空间 / 个人空间** | 新增表单选择器 + 接口参数 |
| 邀请范围 | 无限制，任何活跃账号都能拉进会 | **企业会议=本企业成员；个人会议=好友** | 新增 `friendships` 表 + 选人组件分源 |
| 访问边界 | `tenant_id` 即边界 | **`tenant_id` 只是归属；边界 = 成员身份 + 参与者关系** | `resolveMeetingAccess` 逻辑重写（§6.2） |
| 个人升级企业 | 无此路径 | **原地改 type**，数据不动 | 零数据迁移 |
| `TENANT_SCOPED` | 含 `User` | **必须移除 `User`** | 照抄 v1 代码会直接报错 |
| 迁移风险 | 高（重建两个唯一索引） | 中（只加列加表） | 少一次不可逆的 DDL |

一句话：**v2 把 v1 里最危险的两步（拆手机号唯一键、按租户建超管索引）整个删掉了**，代价是新增 `memberships` 一张表。

---

## 1. 两个决策怎么推导出这套结构

你选的两条是「一个账号只能属于一个企业」和「个人也是租户，原地升级」。把它们放在一起，会逼出一个 v1 没考虑的问题。

### 1.1 为什么不能继续用 `users.tenant_id` 单值

如果沿用 v1 的 `users.tenant_id NOT NULL`，那这一列到底表示什么？

- 表示**归属**：那个人加入企业 B 时，`tenant_id` 改成 B，他原来个人空间里的会议就再也看不到（租户不匹配），而个人租户变成没人能访问的孤儿。
- 表示**当前上下文**：那个人一改就丢了"他还是哪几个租户的成员"这个信息，企业成员列表、离职处理、审计归属全部无从判定。

两个语义都需要，挤在一列里必然有一个出错。所以：

```
归属    →  memberships 关系表（可多行）
上下文  →  users.active_tenant_id（单值，可切换）
```

`users.active_tenant_id` 是**当前在哪个空间操作**，不是他属于谁。这是 v2 与 v1 最根本的差异。

### 1.2 「只允许一个企业」变成应用层约束，不是表结构

关系表本身支持多企业，但产品上限制：

```
一个用户：最多 1 个 PERSONAL membership + 最多 1 个 COMPANY membership
```

这条约束写在 `MembershipService.join()` 里，不在数据库。理由：将来要放开（外包、集团子公司）时只改一个 `if`，不用再改表。而这恰恰是 v1 最贵的地方 —— 它的表结构把"一人一租户"焊死了。

### 1.3 手机号为什么保持全局唯一

v1 拆唯一键的理由是「企业 A 和 B 都可能有 13800138000」。这个场景在平台模式下不成立 —— **同一个手机号就是同一个人**，他在 A 公司和 B 公司都应该用同一个账号，只是分别加入两个租户的 membership。

真正的冲突只发生在「两个不同的人共用一个手机号」（前台公用号、行政代管号），这是极少数，用邮箱登录可以兜底。

所以手机号保持 `@unique`：

- 迁移里不用 `DROP INDEX users_phone_key`，不用重建
- 存量用户不需要因为唯一键冲突做数据清洗
- 上架应用市场时，用 `UserIdentity(provider, externalId)` 做平台账号绑定，**同样不需要动手机号唯一性**

> 唯一要记住的前提：**一个自然人 = 一个账号**。如果将来业务要求"同一个人在两家公司各有一个独立账号"，那是 v1 的模型，得重做。

---

## 2. 产品模型

### 2.1 三种空间

| 类型 | 怎么产生 | 谁能进来 | 可见性 |
|---|---|---|---|
| `PERSONAL` | 注册时自动创建，一人一个 | 只有本人 | 私有 |
| `COMPANY` | 手动创建，或被邀请加入 | 被邀请/被创建的人 | 租户内共享 |
| （平台层） | 不属于任何租户 | `SUPER_ADMIN` | 只能开租户、运维 |

前端不叫"租户"，叫**空间**或**团队**。用户看到的只有：`我的空间` / `XX 公司`。

### 2.2 关键动作

**创建企业**（`POST /api/tenants`）
- 建 `COMPANY` 租户 + `membership(OWNER)`
- 校验：该用户当前没有 COMPANY membership
- `active_tenant_id` 切到新租户
- 他个人空间里的会议**不迁移**（见 2.4）

**邀请成员**（Phase 3，最小可用方案见 §7.3）
- 生成 `tenant_invites` 行（token + 过期 + 次数）
- 受邀人接受后建 `membership(MEMBER)`
- 校验：受邀人当前没有 COMPANY membership

**切换空间**（`PATCH /api/auth/active-tenant`）
- 校验目标租户在 `memberships` 里
- 改 `users.active_tenant_id`
- 不需要换 token（守卫每次回库读，见 §4.1）
- 前端收到响应后整体刷新

**移除成员**（`DELETE /api/tenants/:id/members/:userId`）
- 删 membership
- 该成员 `active_tenant_id` 若指向本租户，回落到他的 PERSONAL 租户
- 他创建的会议**留在企业**（`meeting.tenant_id` 不变），不跟着人走

### 2.3 个人 → 企业：原地升级

「原地升级」有两种可能，v2 只支持第一种，因为第二种会把协作关系搞乱：

| 做法 | 结果 | 是否支持 |
|---|---|---|
| 把 PERSONAL 租户 `type` 改成 `COMPANY` | `tenant_id` 不变，会议全在，零迁移 | ✅ 推荐 |
| 新建 COMPANY 再迁移会议 | 会议里的其他参与者可能不属于新企业，要逐个处理 | ❌ 不做 |

代价是升级后那个人**没有个人空间了**（原来那个变成公司了）。所以升级接口要提示：升级后你的私人会议会变成公司可见的会议。

> 这个取舍要在产品文案里说清楚。替代方案是升级时自动给他补建一个新的空 PERSONAL 空间 —— 建议这么做，成本一行代码。

### 2.4 存量数据怎么安放

这是唯一需要业务确认的地方。

**做法：全部归入一个 `COMPANY` 租户「默认组织」**，不按 owner 拆到各人的个人空间。

理由：现在就有的共享、成员、负责人关系是真实的协作关系。按 owner 拆到个人空间后，A 的会议分到 A 的个人租户，B 作为成员就跨租户了 —— 一夜之间所有协作关系断裂。

同时给每个存量用户**补建一个空的 PERSONAL 空间**（不迁会议），这样每个人都有"私人空间"可用，产品形态统一。

```
存量：所有会议 / 待办 / 审计 → 默认组织（COMPANY）
      每个用户 → membership(默认组织) + 一个空 PERSONAL 空间
      active_tenant_id → 默认组织（行为与今天完全一致）
```

**需要你确认的**：生产上那 7 个账号是不是同一家公司的？如果混了多个不相干的客户，得先按公司拆，否则他们会互相看到彼此的会议。这一步代码替代不了。

### 2.5 创建会议时选空间（决定会议归属）

这是 v2 里唯一新增的产品交互，也是「企业数据入企业空间」这条要求的落点。

**归属由创建时决定，不由当前浏览的空间决定。**

`active_tenant_id` 的语义因此收窄为「我现在在看哪个空间」，它只是**默认值**，
不是归属判定依据。同一个用户在企业空间浏览时，完全可以创建一场归到个人空间的会议。

#### 交互

创建/准备会议的表单里加一个空间选择器：

```
保存到：  [ 企业空间 · 某某科技 ]  [ 个人空间 ]
```

- 用户只有 1 个空间（纯个人用户）→ **不显示**选择器，直接进个人空间
- 用户有 2 个空间 → 显示，默认选中当前浏览的空间
- 记住上次选择（`localStorage`），但默认值仍以当前空间为准 —— 避免"上次选了个
  人，这次在企业里开会忘了改"，把公司会议存进私人空间

#### 接口

```ts
POST /api/meetings
{
  title, content, ...,
  tenantId?: string      // 缺省 = 当前 active_tenant_id
}
```

**关键：后端必须校验 `tenantId ∈ 当前用户的 memberships`**，不能信前端。
校验失败返回 404（不泄露该租户是否存在），不是 403。

也可以设计成传语义化的 `scope: 'PERSONAL' | 'COMPANY'`，后端自己解析成 tenantId。
两者都行，但**推荐 `tenantId`**：将来放开「一人多企业」时不用改接口，前端也不用
知道"哪个是我的个人空间"这种业务规则。

#### 创建后看不到的问题

用户在企业空间选了「个人空间」，创建完成后列表里没有这场会议 —— 因为他还在企业空间。

处理方式（按推荐度）：

1. **提示 + 一键跳转**（推荐）：toast「已保存到个人空间」+ 一个「去看看」按钮
2. 自动切换空间：少一次点击，但连开几场会时上下文容易丢
3. 列表显示「全部空间」：不推荐，投屏时把私人会议暴露出来的事故就是这么来的

#### 要改的创建路径（不止一处）

| 路径 | 位置 | 说明 |
|---|---|---|
| 文字/上传创建会议 | [`meetings.service.ts:230`](../backend/src/meetings/meetings.service.ts#L230) | 主路径 |
| 预约会议 | [`meetings.service.ts:405`](../backend/src/meetings/meetings.service.ts#L405) | 同样要传 |
| 草稿 | [`meetings.service.ts:772`](../backend/src/meetings/meetings.service.ts#L772) | 草稿也要归属 |
| AI 生成纪要 | [`ai.service.ts:62`](../backend/src/ai/ai.service.ts#L62) | 生成入口也要给这个选项 |

四处都是 `ownerId: user.id` 的地方，**同时补 `tenantId`**。

#### 编辑时能不能改空间

建议**允许，但限制严格**：

- 只有会议 owner 能操作
- 只能「个人 → 企业」（把私人会议归档到公司）
- 反向「企业 → 个人」不允许 —— 那等于把公司数据搬走私藏，企业客户不会接受
- 操作要写审计，且会议里的其他参与者必须是目标企业成员，否则先清人

这一条可以放到 Phase 3，不在第一版迁移里。

### 2.6 会议类型同时决定「能邀请谁」

这是这条需求里最关键的一层：**企业/个人的选择不只是数据归属，还是邀请范围的开关。**

| 会议类型 | 数据归属（`tenant_id`） | 可邀请的人 | 谁能访问 |
|---|---|---|---|
| 企业会议 | 企业空间 | **只能是本企业成员**（`memberships`） | 参与者 + 本企业 OWNER/ADMIN |
| 个人会议 | 个人空间 | **只能是好友** | 仅参与者（含好友） |

两条硬规则：

1. **企业会议不能拉外部人**。企业会议的纪要、录音、待办都是公司资产，
   一个外部账号进来就能看到全部历史。这不是体验问题，是企业采购时的必问项。
2. **个人会议不能拉企业成员之外的"通讯录任意人"**。个人空间只有你一个人，
   拉进来的人如果不属于任何共同空间，那他凭什么是"可信任的"？必须有好友关系做凭据。

#### 校验入口：`assertUsersUsable`

现在唯一的校验点是 [`meetings.service.ts:739`](../backend/src/meetings/meetings.service.ts#L739)，
它只检查「账号存在 + 未停用」，**没有任何范围限制**。改成带会议上下文：

```ts
private async assertInvitable(ids: number[], meeting: { tenantId: string; tenantType: 'COMPANY' | 'PERSONAL' }, user: AuthenticatedUser) {
  if (!ids.length) return;

  if (meeting.tenantType === 'COMPANY') {
    // 必须都是本企业成员
    const count = await this.prisma.membership.count({
      where: { tenantId: meeting.tenantId, userId: { in: ids }, user: { isActive: true } },
    });
    if (count !== ids.length) {
      throw new BadRequestException('只能邀请本企业成员');
    }
    return;
  }

  // 个人会议：必须都是我的好友
  const count = await this.prisma.friendship.count({
    where: { userId: user.id, friendId: { in: ids } },
  });
  if (count !== ids.length) {
    throw new BadRequestException('只能邀请好友');
  }
}
```

**错误信息不要区分「不存在」与「不是你企业的人」** ——
两种情况都回同一句话，否则可以用来枚举"某个手机号是不是在这家公司"。

调用点有三处，都要改：

| 位置 | 场景 |
|---|---|
| [`meetings.service.ts:338`](../backend/src/meetings/meetings.service.ts#L338) `createScheduled` | 创建预约会议时指定负责人/成员 |
| [`meetings.service.ts:1560`](../backend/src/meetings/meetings.service.ts#L1560) `addMember` | 会后加人 |
| [`meetings.service.ts:1454`](../backend/src/meetings/meetings.service.ts#L1454) 附近 | 改负责人 |

#### 前端：选人组件按会议类型切数据源

创建表单里「企业 / 个人」的选择一旦变化，下方选人组件的数据源要跟着换：

```
企业会议 → GET /api/users/contacts   （已按当前空间过滤，只返回本企业成员）
个人会议 → GET /api/friends          （我的好友）
```

不要在前端做过滤（把全量通讯录拉下来再筛）—— 那等于把不该给的数据先发出去。

**不要给 contacts 加 `?scope=` 参数**：能返回哪些人只由服务端按 `active_tenant_id` 决定，
让前端传范围等于把权限判断交给客户端。

#### 「好友」的定义（已定：显式好友表）

系统现在**没有好友关系**。`listContacts` 返回的是全平台活跃用户（除超管），
多租户后按 §6.3 还要收紧成"本企业成员"。所以"好友"必须单独定义。
**已确定采用显式好友表**（2026-11-24 决定）：

```prisma
model Friendship {
  id        Int      @id @default(autoincrement())
  userId    Int      @map("user_id")
  friendId  Int      @map("friend_id")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  user   User @relation("FriendOwner", fields: [userId], references: [id], onDelete: Cascade)
  friend User @relation("FriendTarget", fields: [friendId], references: [id], onDelete: Cascade)

  @@unique([userId, friendId])
  @@index([friendId])
  @@map("friendships")
}
```

规则：

- **双向存两行**（A→B 和 B→A）。查「我的好友」是一句 `where: { userId: me }`，
  不用 `OR`；加好友、删好友都在同一事务里写/删两行，不会出现单向脏数据。
- **加好友按手机号精确查找**，不做模糊搜索 —— 否则等于开放全平台用户枚举。
- **不做「申请-同意」审批**：会议邀请本身就是一次告知，再加一层审批是双重摩擦。
  将来真的出现骚扰，加一个 `status` 字段即可，表结构不用改。
- **好友可以跨企业、跨个人空间**。这正是好友关系的价值所在 ——
  企业会议不允许拉外部人，个人会议允许，区别就在这道关系上。

前端第一版不单独做「好友管理」页：在创建个人会议的选人框里输手机号添加，
加完立刻出现在好友列表里。等用户量起来再补独立的加好友入口。

---

## 3. 数据模型

### 3.1 新增 / 修改的 Prisma 定义

```prisma
enum TenantType {
  PERSONAL
  COMPANY
}

/// 租户内角色。与平台角色 users.role 是两个维度，不要合并。
enum TenantRole {
  OWNER   // 创建者/所有者：可转让、可解散、可管 ADMIN
  ADMIN   // 管理员：可管成员、可看租户内全部会议
  MEMBER  // 成员：只能看自己相关的会议
}

/// 租户 = 一个工作空间。企业是 COMPANY，个人空间是 PERSONAL。
///
/// id 用 UUID 而不是自增：租户 id 会出现在 URL、日志、审计里，
/// 自增会暴露平台上有多少客户。
model Tenant {
  id         String     @id @default(uuid()) @db.Uuid
  name       String     @db.VarChar(120)
  type       TenantType @default(COMPANY)
  /// feishu / wecom / tencent / standalone
  platform   String     @default("standalone") @db.VarChar(32)
  /// 平台侧企业标识（飞书 tenant_key、企微 corpid）；standalone 为空
  externalId String?    @map("external_id") @db.VarChar(120)
  /// ACTIVE / SUSPENDED
  status     String     @default("ACTIVE") @db.VarChar(20)
  plan       String     @default("free") @db.VarChar(32)
  createdAt  DateTime   @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt  DateTime   @updatedAt @map("updated_at") @db.Timestamptz(3)

  memberships Membership[]
  meetings    Meeting[]
  activeUsers User[]       @relation("ActiveTenant")
  invites     TenantInvite[]

  /// 同一平台的企业只能装一次；standalone 的 external_id 为 NULL，
  /// PG 唯一索引允许多个 NULL，不影响自建租户
  @@unique([platform, externalId])
  @@index([type])
  @@map("tenants")
}

/// 用户与租户的归属关系。
///
/// 产品约束（应用层，不在库里）：一个用户最多一条 COMPANY membership。
/// 放在应用层是为了将来放开"一人多企业"时只改一个判断，不用改表。
model Membership {
  id        Int        @id @default(autoincrement())
  tenantId  String     @map("tenant_id") @db.Uuid
  userId    Int        @map("user_id")
  role      TenantRole @default(MEMBER)
  createdAt DateTime   @default(now()) @map("created_at") @db.Timestamptz(3)

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([tenantId, userId])
  @@index([userId])
  @@map("memberships")
}

/// 邀请链接。Phase 3 才用；建表放在第一版迁移里，
/// 避免后面再动一次 tenants 相关的外键。
model TenantInvite {
  id        Int       @id @default(autoincrement())
  tenantId  String    @map("tenant_id") @db.Uuid
  /// 邀请令牌的 SHA-256（只存哈希，与 password_reset_token 一致）
  tokenHash String    @unique @map("token_hash") @db.VarChar(64)
  /// 指定手机号时，只有该号能接受；为空表示任何拿到链接的人都能用
  phone     String?   @db.VarChar(20)
  role      TenantRole @default(MEMBER)
  maxUses   Int       @default(1) @map("max_uses")
  usedCount Int       @default(0) @map("used_count")
  expiresAt DateTime  @map("expires_at") @db.Timestamptz(3)
  createdBy Int       @map("created_by")
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@map("tenant_invites")
}

/// 好友关系。个人会议只能邀请好友，这张表就是依据。
///
/// 双向存两行：A→B 和 B→A。查询「我的好友」是一句
/// `where: { userId: me }`，不用 OR，也不用担心单向数据不一致 ——
/// 加好友和删好友都在同一个事务里写两行。
///
/// 目前不做"申请-同意"审批：会议邀请本身就是一次告知，再加审批是双重摩擦。
/// 如果以后出现骚扰问题，加一个 status 字段即可，表结构不用改。
model Friendship {
  id        Int      @id @default(autoincrement())
  userId    Int      @map("user_id")
  friendId  Int      @map("friend_id")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  user   User @relation("FriendOwner", fields: [userId], references: [id], onDelete: Cascade)
  friend User @relation("FriendTarget", fields: [friendId], references: [id], onDelete: Cascade)

  @@unique([userId, friendId])
  @@index([friendId])
  @@map("friendships")
}
```

`User` 增加：

```prisma
  /// 当前浏览的空间，也是创建会议时的**默认**归属（可在表单里改，见 §2.5）。
  /// 它不是"归属"——归属看 memberships；也不是"会议归属"——那由 meeting.tenantId 决定。
  /// 每次请求由守卫回库读出，不进 JWT，理由见 §4.1。
  activeTenantId String @map("active_tenant_id") @db.Uuid
  activeTenant   Tenant @relation("ActiveTenant", fields: [activeTenantId], references: [id], onDelete: Restrict)

  memberships Membership[]

  /// 好友（双向各存一行，见 Friendship）
  friendshipsGiven    Friendship[] @relation("FriendOwner")
  friendshipsReceived Friendship[] @relation("FriendTarget")

  @@index([activeTenantId])
```

`Meeting` 增加：

```prisma
  /// 会议归属的租户。**必须显式存在**，不能靠 owner.activeTenantId 推导：
  /// 用户离职后会议留在企业，推导会跟着人跑。
  /// 取值来自创建时选择的 tenantId（缺省为 active_tenant_id），见 §2.5。
  tenantId String @map("tenant_id") @db.Uuid
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  @@index([tenantId, createdAt(sort: Desc)])
  @@index([tenantId, ownerId, createdAt(sort: Desc)])
  @@index([tenantId, pinnedAt(sort: Desc)])
  @@index([tenantId, scheduledAt])
```

### 3.2 哪些表加 `tenant_id`（与 v1 一致）

| 表 | 加 | 理由 |
|---|:--:|---|
| `meetings` | ✅ | 数据归属的根 |
| `audit_logs` | ✅ **可空** | 审计要能按企业导出（企业采购的硬要求）；但系统动作没有归属企业，所以允许 NULL |
| `meeting_generations` | ✅ | 后台任务按租户恢复/清理 |
| `meeting_notices` | ✅ | 收件箱按租户推送 |
| `inbox_reads` | ✅ | 同上 |
| `asr_jobs` | ✅ **v2 新增** | v1 漏了。见 §6.10，不加这列会出越权 |
| `users` | ❌ **v2 变化** | 用户是全局实体，靠 membership 关联 |
| `meeting_decisions` / `meeting_todos` / `meeting_leaders` / `meeting_members` / `meeting_shares` | ❌ | 全部经会议访问，开会话时已校验 |
| `conversations` / `messages` | ❌ | 私信按人；发起时校验同租户（§6.8） |

> 不加子表 `tenant_id` 的前提：**所有子表操作必须先解析出 `meetingId` 并过 `assertCan*`**。
> 当前代码是这模式，但它是约定不是约束 —— 见 §6.4 的 `loadTodoOrThrow` 建议。

---

## 4. 租户上下文怎么传

### 4.1 JWT 不用改（沿用 v1 结论）

`JwtAuthGuard` 每个请求都回库读用户（[`jwt-auth.guard.ts:81`](../backend/src/auth/jwt-auth.guard.ts#L81)）。
把 `activeTenantId` 和租户角色一起 join 出来即可，**不需要往 token 里加声明**：

```ts
const user = await this.prisma.user.findUnique({
  where: { id: userId },
  select: {
    id: true, phone: true, name: true, role: true,
    isActive: true, tokenVersion: true,
    activeTenantId: true,
    memberships: {
      where: { tenantId: /* 见下 */ },
      select: { role: true },
    },
  },
});
```

`memberships` 的 `where` 没法引用同一行刚读出来的 `activeTenantId`，两种写法：

```ts
// 写法 A：两次查询（简单，但每请求多一次 round-trip）
const user = await this.prisma.user.findUnique({ ... });
const membership = await this.prisma.membership.findUnique({
  where: { tenantId_userId: { tenantId: user.activeTenantId, userId: user.id } },
  select: { role: true, tenant: { select: { type: true, status: true } } },
});

// 写法 B：一次查询，用 relation 全取再在内存里挑（成员数少，成本可忽略）
const user = await this.prisma.user.findUnique({
  where: { id: userId },
  include: { memberships: { select: { tenantId: true, role: true } } },
});
const membership = user.memberships.find(m => m.tenantId === user.activeTenantId);
```

推荐 **B**：一次查询，且顺带能校验"membership 是否还存在"（被移出企业后立即失效，与 `tokenVersion` 的设计理念一致）。

**必须处理的异常分支**：`activeTenantId` 指向的 membership 不存在（刚被移出）→ 直接 401，提示重新登录。不要静默回落到个人空间，那会让用户困惑"我的数据怎么没了"。

### 4.2 `AuthenticatedUser` 扩字段

```ts
// backend/src/auth/auth.decorators.ts
export interface TenantMembership {
  tenantId: string;
  role: TenantRole;
  type: 'PERSONAL' | 'COMPANY';
}

export interface AuthenticatedUser {
  id: number;
  phone: string;
  name: string;
  /** 平台角色：SUPER_ADMIN 或 USER。ADMIN 已废弃，见 §5 迁移 */
  role: AppRole;
  isActive: boolean;
  /** 当前浏览的空间 */
  activeTenantId: string;
  /** 当前空间里的角色（由 memberships 派生，省得每处 find） */
  tenantRole: TenantRole | null;
  tenantType: 'PERSONAL' | 'COMPANY';
  /**
   * 全部空间。权限判定要用它回答「这个人是不是这场会议所属空间的成员」
   * （§6.2），仅靠 activeTenantId 答不了 —— 他可能正浏览个人空间，
   * 同时在访问一场企业会议。
   */
  memberships: TenantMembership[];
  impersonatedBy?: number;
}
```

这次是**纯增字段**，现有所有 `user.id` / `user.role` 的用法不受影响。

`memberships` 一次全取（一个人最多 2 条），守卫里不需要额外查询。
守卫的异常分支仍是：`activeTenantId` 不在 `memberships` 里 → 401（刚被移出）。

### 4.3 Prisma 扩展（v1 代码要改三处）

v1 §3.3 的方案整体成立，但有三处必须改：

**改动 1：`TENANT_SCOPED` 移除 `User`**

```ts
const TENANT_SCOPED = new Set([
  // 'User'  ← 必须删掉。users 表在 v2 里没有 tenant_id，
  //            留着会让所有 user 查询拼出 where tenantId，直接报列不存在。
  'Meeting', 'AuditLog', 'MeetingGeneration', 'MeetingNotice', 'InboxRead',
  'AsrJob',   // ← v1 漏了，见 §6.10
]);
```

用户维度的隔离改用显式 join（§6.3），不能靠扩展自动注入。

**改动 2：注入来源是 `activeTenantId`**

```ts
const tenantExtension = (tenantId: string) => Prisma.defineExtension({ ... });
// TenantContext.get() 返回当前请求的 activeTenantId
```

**改动 3（新增）：`Meeting.create` 的注入顺序必须是「调用方优先」**

v1 写的是：

```ts
if (operation === 'create') {
  a.data = { ...a.data, tenantId };   // ← 租户在后，会覆盖调用方传的值
}
```

v2 有了「创建时选空间」（§2.5），这个顺序会**直接吃掉用户的选择** ——
在个人空间表单里选的值被当前的 `active_tenant_id` 覆盖，功能静默失效，而且不报错。

正确写法是默认值在前、调用方在后：

```ts
if (operation === 'create') {
  a.data = { tenantId, ...(a.data ?? {}) };          // 调用方显式传的优先
}
if (operation === 'createMany') {
  const rows = Array.isArray(a.data) ? a.data : [a.data];
  a.data = rows.map((r: any) => ({ tenantId, ...r }));
}
```

**代价**：调用方传什么就写什么，所以 §6.11 的 membership 校验**不能省**。
扩展只负责"没传时填默认值"，不负责鉴权 —— 鉴权永远在 service 层。

本项目的会议创建散在四处
（[`meetings.service.ts:230`](../backend/src/meetings/meetings.service.ts#L230)、
[:405](../backend/src/meetings/meetings.service.ts#L405)、
[:772](../backend/src/meetings/meetings.service.ts#L772)、
[`ai.service.ts:62`](../backend/src/ai/ai.service.ts#L62)），
建议四处都**显式写** `tenantId`，不要把安全性寄托在代理层。

其余要点（按 tenantId 缓存扩展客户端、`$executeRaw` 不被拦截、`$transaction` 要在扩展客户端上开）见 v1 §3.3，仍然有效。

---

## 5. 权限模型

### 5.1 两个维度

| 维度 | 字段 | 取值 | 决定 |
|---|---|---|---|
| 平台角色 | `users.role` | `SUPER_ADMIN` / `USER` | 开租户、看租户清单、运维 |
| 租户角色 | `memberships.role` | `OWNER` / `ADMIN` / `MEMBER` | 租户内管人、看租户内全部会议 |
| 资源关系 | 关系表 | owner / leader / member / share | 单场会议能不能读写（逻辑不变） |

`users.role` 里的 `ADMIN` **废弃但保留枚举值**（Prisma 删枚举值要单独迁移，收益为零）。
迁移时把存量 ADMIN 转成对应租户的 `membership.ADMIN`，同时 `users.role` 降为 `USER`。

### 5.2 权限位映射

`permissions.ts` 的权限目录基本不动，只改映射来源：

```ts
/** 租户内的角色 → 权限集合 */
const TENANT_ROLE_PERMISSIONS: Record<TenantRole, Permission[]> = {
  MEMBER: USER_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  OWNER: [...ADMIN_PERMISSIONS, PERMISSIONS.USER_MANAGE_ADMIN],
};

/** 平台角色只管平台能力，不授予任何 MEETING_* */
const PLATFORM_PERMISSIONS: Record<AppRole, Permission[]> = {
  SUPER_ADMIN: [PERMISSIONS.TENANT_MANAGE, PERMISSIONS.TENANT_READ],
  ADMIN: [],   // 废弃
  USER: [],
};

export const hasPermission = (user: AuthenticatedUser, p: Permission): boolean => {
  if (PLATFORM_PERMISSIONS[user.role]?.includes(p)) return true;
  return user.tenantRole
    ? (TENANT_ROLE_PERMISSIONS[user.tenantRole] ?? []).includes(p)
    : false;
};
```

**语义变化（重要）**：`MEETING_READ_ALL` 从"全平台"改成"**本租户内全部**"。名字建议一并改掉：

```ts
export const hasTenantWideMeetingAccess = (user: AuthenticatedUser) =>
  hasPermission(user, PERMISSIONS.MEETING_READ_ALL);
```

`hasGlobalMeetingAccess` 这个名字在 9 个文件、14 处调用里出现，留着它，后来的人一定会以为它能跨租户。

### 5.3 平台超管能不能看企业数据

**建议：默认不能。**

理由：企业客户一定会问"你们员工能看到我们的会议纪要吗"。答"能"会直接丢单。

需要排查时的正确做法是**显式进入**，而且留痕：

- 复用现有的超管代登机制（`imp` 声明 + `audit_logs.impersonated_by`）
- 进入前要求填原因，写审计
- 前端顶部常驻提示条（现有 `impersonation-banner` 已有）

这样"能看"是有条件、有记录、可追责的，而不是默认敞着。

> 迁移注意：现网超管 `19507074669` 是实际在用系统的人。迁移时把他设为默认组织的 `OWNER`，
> 他的日常使用不受影响；他的"平台超管"身份仍然保留，用于开租户。

---

## 6. 代码改动点清单

> 行号核验于 2026-11-24。v1 文档里的行号已整体漂移（v1 说 747 行，实际 1130），
> 以本文为准。改完逐条打勾。

### 6.1 ⭐⭐⭐⭐⭐ 可见范围的三份副本

v1 说"只改 `meetings.service.ts:747` 一处就全好"，**这个结论现在不成立**。当前状态：

| 位置 | 现状 | 改法 |
|---|---|---|
| [`meetings.scope.ts:15`](../backend/src/meetings/meetings.scope.ts#L15) | 主实现，管理员分支 `return {}` | `return { tenantId: user.activeTenantId }` |
| [`meetings.service.ts:1130`](../backend/src/meetings/meetings.service.ts#L1130) | 已改为代理 `visibleMeetingScope` | 不用改 ✅ |
| [`todos.service.ts:52`](../backend/src/meetings/todos.service.ts#L52) | 已改为代理 `visibleMeetingScope` | 不用改 ✅ |
| [`inbox.service.ts:822`](../backend/src/inbox/inbox.service.ts#L822) | **独立实现了一份** | 删掉，改调 `visibleMeetingScope` |
| [`users.service.ts:183`](../backend/src/users/users.service.ts#L183) | **内联了一份** | 同上 |

后两处是真正的隐患：`meetings.scope.ts` 改对了，它们不会跟着对。

### 6.2 ⭐⭐⭐⭐⭐ `resolveMeetingAccess` 的入口查询

> **修正**：本节初稿写的是「`findUnique` 加 `tenantId` 过滤」，**那是错的**。
> 个人会议的参与者本来就不是该空间的成员（见 §2.6），加了租户过滤会把他们全部挡在门外 ——
> 一场个人会议只有创建者能打开，邀请的人全部 404。

`meeting.tenant_id` 是**数据归属**，不是访问边界。访问边界由「租户成员身份 + 参与者关系」共同决定。

正确改法：

```ts
// meetings.access.ts:126
const meeting = await prisma.meeting.findUnique({
  where: { id: meetingId },                      // ← 不加租户条件
  select: {
    id: true, ownerId: true, audioOpen: true,
    tenantId: true,
    tenant: { select: { type: true } },          // ← 新增：需要知道是企业还是个人
    leaders: { select: { userId: true } },
  },
});

if (!meeting) return null;

const isCompany = meeting.tenant.type === 'COMPANY';
const membership = user.memberships.find((m) => m.tenantId === meeting.tenantId);

/**
 * 企业会议：非本企业成员一律拒绝。
 * 这一条同时解决「员工离职后还能看公司会议」——membership 删了，这里立刻 false。
 * 个人会议：参与者关系本身就是授权，不看 membership。
 */
if (isCompany && !membership) return null;

// 租户管理员看本企业全部会议
if (membership && (membership.role === 'OWNER' || membership.role === 'ADMIN')) {
  return finish(meeting.ownerId === user.id ? 'owner' : 'edit');
}

// 参与者（个人会议的受邀好友也走这里）
if (meeting.ownerId === user.id) return finish('owner');
if (leaderIds.includes(user.id)) return finish('leader');
```

`user.memberships` 从守卫带进来（§4.2），不额外查库。

**安全性没有下降**：不带租户条件意味着拿到别人的 meetingId 能查到行，但后续
owner / leader / member / share 全部不匹配、管理员分支要求 membership 存在，
最终仍然返回 `null` → 404。多一次查询，不泄露任何内容。

**这里有个容易搞反的点**：`isCompany && !membership` 的判断必须放在 owner 之前。
否则一个离职员工仍然是 `meeting.owner_id`，会先命中 owner 分支拿到权限。

### 6.3 ⭐⭐⭐⭐ 通讯录与用户列表

[`users.service.ts:78`](../backend/src/users/users.service.ts#L78)：

```ts
const where: Record<string, unknown> = {};   // 超管分支 = 全库
```

改成从 `{ memberships: { some: { tenantId: operator.activeTenantId } } }` 起步。
[`listContacts`](../backend/src/users/users.service.ts#L131)（第 133 行 `where: { isActive: true, role: { not: 'SUPER_ADMIN' } }`）同样要加。

漏了这一处 = 企业员工名单泄露，而且是最容易被发现的那种。

### 6.4 ⭐⭐⭐⭐ 子表操作的间接性

v1 说这里有 3 处（`meetings.service.ts:634/1164/1323`）。**代码结构已经变了**：
待办逻辑整体搬到了 `todos.service.ts`，现在那里有 **9 处** `todo.findUnique({ where: { id } })`：

`todos.service.ts` 第 69、459、602、733、825、1141、1237、1446、1861 行。

模式本身安全（都是先查到 `todo.meetingId`，再 `assertCan*(meetingId)`；只要 6.2 修好，
`assertCanRead` 查不到跨租户的会议就会 404）。但它是"约定"不是"约束"：
新增待办接口时很容易写成裸 `todo.update({ where: { id } })`，而 `Todo` 表没有 `tenant_id`，
扩展拦不住。

建议加一个私有方法把"查 + 鉴权"合并成不可绕过的入口：

```ts
// todos.service.ts
private async loadTodoOrThrow(id: number, user: AuthenticatedUser) {
  const todo = await this.prisma.todo.findUnique({ where: { id } });
  if (!todo) throw new NotFoundException('待办事项不存在');
  await assertCanEditTodos(this.prisma, user, todo.meetingId);  // 或 assertCanRead
  return todo;
}
```

9 处逐个替换，以后新增接口只有一个正确写法可抄。

### 6.5 ⭐⭐⭐⭐ 删除用户时的会议转移

[`users.service.ts:596`](../backend/src/users/users.service.ts#L596)：

```ts
await this.prisma.meeting.updateMany({
  where: { ownerId: targetId },
  data: { ownerId: operator.id },       // ← 会议可能被转到另一个租户的人名下
});
```

多租户后：

- 先校验 target 与 operator 同租户（不同租户直接 403）
- 转移后会议的 `tenantId` **不变**（仍留在原租户）
- 若 operator 已被移出该租户，不允许删除，提示先转交

### 6.6 ⭐⭐⭐⭐ 邀请与共享的范围校验

> **修正**：本节初稿写的是「`target` 必须是同租户成员，跨租户一律拒绝」。
> 那会把个人会议邀请好友的路径一起堵死 —— 好友本来就不在任何共同空间里。
> 正确的规则按**会议类型**分（§2.6）。

[`meeting-share.service.ts`](../backend/src/meetings/meeting-share.service.ts) 现在可以把会议共享给任何用户。
加一道按类型区分的校验：

```ts
// 企业会议 → 必须是本企业成员
// 个人会议 → 必须是我的好友
```

统一入口应该是 `assertInvitable(ids, meeting, user)`（§2.6），**不是** `assertSameTenant`。
后者是初稿的思路，现在不成立。

这些"指向用户"的外键，每个都要按同一规则校验：

| 外键 | 会议类型 | 校验 |
|---|---|---|
| `meeting_leaders.user_id` | 企业 | 本企业成员 |
| | 个人 | 我的好友 |
| `meeting_members.user_id` | 企业 | 本企业成员 |
| | 个人 | 我的好友 |
| `meeting_shares.user_id` | 企业 | 本企业成员 |
| | 个人 | 我的好友 |
| `todos.assignee_user_id` | 企业 | 本企业成员 |
| | 个人 | 我的好友（待办指派给外部人是可以接受的） |
| `todos.reviewer_id` | 同上 | 同上 |
| `todo_submissions.submitter_id` | — | 不用校验，提交人必须是能访问该会议的人，上游已经拦住了 |

**企业会议的额外规则（离职失效）**：参与者关系不是永久的。
成员离职后 `meeting_members` 里的行还在，但 §6.2 的 `isCompany && !membership` 会拦住他。
所以不需要在离职时清理 `meeting_members`，**留着反而有利于审计**（谁参加过）。
只有他自己看不到，其他人看到的参会名单仍然完整。

**超管代登的边界**：平台超管以某成员身份进入时，`memberships` 是那个人的，
所以他的邀请范围也跟着那个人走 —— 这是对的，避免超管代登时能把外部人拉进企业会议。

### 6.7 ⭐⭐⭐ 后台任务的跨租户行为（行号已按 2026-11-24 修正）

| 位置 | 现象 | 处理 |
|---|---|---|
| [`ai.service.ts:543`](../backend/src/ai/ai.service.ts#L543) `onModuleInit` | 启动时把全库 `PENDING/RUNNING` 标失败（第 545 行） | 上队列后删掉；过渡期加 `instanceId` 过滤 |
| [`asr.service.ts:48`](../backend/src/asr/asr.service.ts#L48) `onModuleInit` | 同上，转写任务（第 62 行） | 同上。v1 漏了这一处 |
| [`inbox.service.ts:151`](../backend/src/inbox/inbox.service.ts#L151) `onModuleInit` | 每分钟全表扫（`setInterval` 在 157 行） | 短期靠唯一索引幂等（已有），长期改队列 |
| [`notifications.service.ts:48`](../backend/src/notifications/notifications.service.ts#L48) | 同上（`setInterval` 在 81 行） | 同上 |
| [`overdue-reminder.service.ts:81`](../backend/src/notifications/overdue-reminder.service.ts#L81) | 同上（`setInterval` 在 117 行） | 同上 |
| [`platform-event.service.ts:213`](../backend/src/platforms/platform-event.service.ts#L213) | **平台回调建会议时没有登录上下文**，Prisma 扩展不会注入 `tenantId`，而该列 NOT NULL → 腾讯会议同步全线失败 | 见下 |

**平台回调这条必须显式传租户**，否则上线当天就会发现"腾讯会议同步不进来"：

```ts
// platform-event.service.ts upsertMeeting()
const ownerId = await this.resolveOwnerId();
// ...
const created = await this.prisma.meeting.create({
  data: {
    ...,
    ownerId,
    tenantId: owner.activeTenantId,   // ← 显式。扩展在这里帮不上忙
  },
});
```

`resolveOwnerId()` 目前只返回 id，要改成同时返回 `activeTenantId`（`findUnique` 多选一列）。
平台的 `TENCENT_MEETING_OWNER_PHONE` 指向谁，会议就归谁当前所在的空间 ——
如果那个人后来换了企业，新同步的会议会进新企业，历史会议留在原企业。这个行为是对的。

已有 `worker-role.ts` 保证定时任务只由 0 号 worker 执行（见 `2026-11-24` 日志），
所以"多副本重复扫描"这一条已经解决了，**剩下的只是跨租户扫描本身**——
这是故意的（提醒必须扫全库），但要显式标注，且不允许从 HTTP 请求路径调到无租户上下文的客户端。

### 6.8 ⭐⭐⭐ 私信与实时消息

`conversations` 的唯一约束是 `(user_a_id, user_b_id)`。多租户后：

- 发起会话时校验双方同租户，否则不同企业的人能私聊
- 或者更严格：`conversations` 也加 `tenant_id`

建议先做前者（校验），因为加列要改的地方比校验多。

### 6.9 ⭐⭐ 审计的租户归属

`AuditService.record(actor, entry)` 靠 `actor` 隐式归属。
系统级动作（平台回调、定时任务）没有 actor，这类记录要**显式传 tenantId**，
否则会出现 `tenant_id = null` 的孤儿审计，按租户导出时丢掉。

### 6.10 ⭐⭐⭐⭐ `asr_jobs` 的越权（v1 漏掉的真漏洞）

[`asr.service.ts:219`](../backend/src/asr/asr.service.ts#L219)：

```ts
const job = await this.prisma.asrJob.findUnique({ where: { id } });

if (job.userId !== user.id && !hasGlobalMeetingAccess(user)) {
  throw new ForbiddenException('无权查看该转写任务');
}
```

`hasGlobalMeetingAccess` 改造后语义是"本租户内的管理员"，看起来没问题 ——
但 `asr_jobs` 表**没有 `tenant_id`**，所以这句话拦不住：
A 企业的管理员拿到 B 企业的任务 id，`job.userId !== user.id` 为真、
`hasGlobalMeetingAccess` 为真，直接放行。

同一模式在 `remove`（第 251 行）也有，删的是别人的录音文件。

修法（两条一起做）：

1. `asr_jobs` 加 `tenant_id`，进 `TENANT_SCOPED`，`findUnique` 带租户条件
2. 把判断从"是不是管理员"改成"是不是同租户成员"：

```ts
if (job.userId !== user.id && job.tenantId !== user.activeTenantId) {
  throw new NotFoundException('转写任务不存在');
}
```

顺带说：ASR 是按分钟计费的，加 `tenant_id` 之后才能按企业统计成本 ——
这条不是纯安全考虑，也是计费的前提。

### 6.11 ⭐⭐⭐ 创建会议时的空间解析（§2.5 的落地）

产品交互在 §2.5，这里只列实现要点和一个容易错的连带关系。

**校验顺序**（不能省）：

```ts
// meetings.service.ts create()
const tenantId = input.tenantId ?? user.activeTenantId;

const membership = await this.prisma.membership.findUnique({
  where: { tenantId_userId: { tenantId, userId: user.id } },
  select: { role: true },
});
if (!membership) throw new NotFoundException('空间不存在');   // 404，不是 403

const meeting = await this.prisma.meeting.create({
  data: { ..., ownerId: user.id, tenantId },
});
```

**连带关系（容易漏）**：`meeting_generations` 也有 `tenantId`。
AI 生成的流程是「先建任务 → 后台跑 → 跑完建会议」（[`ai.service.ts:543`](../backend/src/ai/ai.service.ts#L543) 附近），
如果任务按 `active_tenant_id` 记、会议按用户选的 `tenantId` 记，两者会不一致 ——
后面按租户恢复任务时就会错。

所以 `createGeneration` 要接收同一个 `tenantId` 并原样传给会议创建。

**前端**：创建表单的空间选择器只在 `memberships.length > 1` 时渲染；
提交后如果返回的 `tenantId !== activeTenantId`，弹「已保存到个人空间」+ 跳转（§2.5）。

前端要拿到"我有哪些空间"，需要新增一个只读接口：

```
GET /api/tenants/mine
→ [{ id, name, type, role }, ...]     // 只返回当前用户的 memberships
```

不要复用 `GET /api/tenants`（平台超管看全部租户的那个），两者权限完全不同。

### 6.12 ⭐⭐⭐ 注册流程：插入顺序有个循环依赖

`users.active_tenant_id` 是 NOT NULL，但新用户注册时要先建个人空间、再建用户 ——
而空间的默认名字又想用用户的姓名。三张表互相等，直接写会撞外键。

正确顺序（一个事务内，先建不依赖别人的）：

```ts
// auth.service.ts register()
await this.prisma.$transaction(async (tx) => {
  // 1) 先建空间：此刻还不知道 userId，所以只能靠入参的姓名命名
  const tenant = await tx.tenant.create({
    data: { name: `${input.name} 的空间`, type: 'PERSONAL' },
  });

  // 2) 再建用户，active_tenant_id 有值可填
  const user = await tx.user.create({
    data: { ..., activeTenantId: tenant.id },
  });

  // 3) 最后建归属关系
  await tx.membership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'OWNER' },
  });
});
```

注意 `tenant` 表**不要**加 `owner_user_id` 外键 —— 那会把循环依赖搬到表结构里，
就只能用可空外键或延迟约束来解。归属统一由 `memberships` 表达，一张表一个来源。

**存量迁移不受这个影响**：§7.2 的 SQL 是先插 `memberships` 再回填 `active_tenant_id`，
顺序天然正确。

---

## 7. 迁移步骤

### 7.1 与 v1 的差异

v1 的第 ⑤ 步（拆手机号唯一键）和第 ⑥ 步（按租户建超管索引）**整段不做**。
这让整个迁移从"两个不可逆 DDL"降级成"加表加列"，回滚也简单得多。

### 7.2 迁移 SQL（可直接落地成 `drafts/0002_multitenant_v2.sql`）

```sql
BEGIN;

-- ① 枚举（与 Prisma 命名保持一致）
DO $$ BEGIN
  CREATE TYPE "TenantType" AS ENUM ('PERSONAL', 'COMPANY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "TenantRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ①b 租户主表
CREATE TABLE IF NOT EXISTS "tenants" (
-- id 与 updated_at 都**不设 DEFAULT**：Prisma 的 @default(uuid()) 与 @updatedAt
-- 由客户端生成/维护，数据库若有默认值，migrate diff 会一直报差异，
-- 下次 migrate dev 就会生成一个"删掉默认值"的无意义迁移。
-- 代价：任何直接用 SQL 插 tenants 的脚本都必须显式给 id 和 updated_at。
  "id"          UUID PRIMARY KEY,
  "name"        VARCHAR(120) NOT NULL,
  "type"        "TenantType" NOT NULL DEFAULT 'COMPANY',
  "platform"    VARCHAR(32)  NOT NULL DEFAULT 'standalone',
  "external_id" VARCHAR(120),
  "status"      VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  "plan"        VARCHAR(32)  NOT NULL DEFAULT 'free',
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenants_platform_external_id_key"
  ON "tenants" ("platform", "external_id");
CREATE INDEX IF NOT EXISTS "tenants_type_idx" ON "tenants" ("type");

-- ② 归属关系表
CREATE TABLE IF NOT EXISTS "memberships" (
  "id"         SERIAL PRIMARY KEY,
  "tenant_id"  UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "user_id"    INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "role"       "TenantRole" NOT NULL DEFAULT 'MEMBER',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_tenant_id_user_id_key"
  ON "memberships" ("tenant_id", "user_id");
CREATE INDEX IF NOT EXISTS "memberships_user_id_idx" ON "memberships" ("user_id");

-- ③ 邀请表（Phase 3 用，先建好避免二次动表）
CREATE TABLE IF NOT EXISTS "tenant_invites" (
  "id"         SERIAL PRIMARY KEY,
  "tenant_id"  UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "token_hash" VARCHAR(64) NOT NULL UNIQUE,
  "phone"      VARCHAR(20),
  "role"       "TenantRole" NOT NULL DEFAULT 'MEMBER',
  "max_uses"   INTEGER NOT NULL DEFAULT 1,
  "used_count" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_by" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "tenant_invites_tenant_id_idx" ON "tenant_invites" ("tenant_id");

-- ③b 好友关系（§2.6）
CREATE TABLE IF NOT EXISTS "friendships" (
  "id"         SERIAL PRIMARY KEY,
  "user_id"    INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "friend_id"  INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "friendships_user_id_friend_id_key"
  ON "friendships" ("user_id", "friend_id");
CREATE INDEX IF NOT EXISTS "friendships_friend_id_idx" ON "friendships" ("friend_id");

-- ④ 默认组织：承接现有全部数据
-- 固定 uuid，便于迁移脚本与验收断言引用。
-- updated_at 没有 DEFAULT（见 ①b 的说明），必须显式给。
INSERT INTO "tenants" ("id", "name", "type", "platform", "updated_at")
VALUES ('00000000-0000-4000-8000-000000000001', '默认组织', 'COMPANY', 'standalone', now())
ON CONFLICT ("id") DO NOTHING;

-- ⑤ 六张根表加 tenant_id（先可空）
ALTER TABLE "meetings"            ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "audit_logs"          ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "meeting_generations" ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "meeting_notices"     ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "inbox_reads"         ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "asr_jobs"            ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

-- ⑥ 回填：现有数据全部归入默认组织
UPDATE "meetings"            SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "audit_logs"          SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "meeting_generations" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "meeting_notices"     SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "inbox_reads"         SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "asr_jobs"            SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;

-- ⑦ 非空 + 外键 + 索引
ALTER TABLE "meetings"            ALTER COLUMN "tenant_id" SET NOT NULL;
-- audit_logs 刻意**允许为空**：系统级动作（定时任务、平台回调）没有操作者，
-- 本来就不属于任何企业。强制 NOT NULL 会让这类记录要么写不进去、
-- 要么被迫污染某家企业的审计导出。
ALTER TABLE "audit_logs"          ALTER COLUMN "tenant_id" DROP NOT NULL;
ALTER TABLE "meeting_generations" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "meeting_notices"     ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "inbox_reads"         ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "asr_jobs"            ALTER COLUMN "tenant_id" SET NOT NULL;

ALTER TABLE "meetings" ADD CONSTRAINT "meetings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "meeting_generations" ADD CONSTRAINT "meeting_generations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_notices" ADD CONSTRAINT "meeting_notices_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inbox_reads" ADD CONSTRAINT "inbox_reads_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asr_jobs" ADD CONSTRAINT "asr_jobs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "meetings_tenant_id_created_at_idx"
  ON "meetings" ("tenant_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "meetings_tenant_id_owner_id_created_at_idx"
  ON "meetings" ("tenant_id", "owner_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "meetings_tenant_id_pinned_at_idx"
  ON "meetings" ("tenant_id", "pinned_at" DESC);
CREATE INDEX IF NOT EXISTS "meetings_tenant_id_scheduled_at_idx"
  ON "meetings" ("tenant_id", "scheduled_at");
CREATE INDEX IF NOT EXISTS "audit_logs_tenant_id_created_at_idx"
  ON "audit_logs" ("tenant_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "meeting_generations_tenant_id_status_idx"
  ON "meeting_generations" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "meeting_notices_tenant_id_user_id_created_at_idx"
  ON "meeting_notices" ("tenant_id", "user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "inbox_reads_tenant_id_user_id_idx"
  ON "inbox_reads" ("tenant_id", "user_id");
CREATE INDEX IF NOT EXISTS "asr_jobs_tenant_id_user_id_idx"
  ON "asr_jobs" ("tenant_id", "user_id");

-- ⑧ 用户侧：active_tenant_id + 归属关系
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "active_tenant_id" UUID;

-- 存量用户全部进默认组织；原 ADMIN 保留其管理能力（转到 membership）
INSERT INTO "memberships" ("tenant_id", "user_id", "role", "created_at")
SELECT
  '00000000-0000-4000-8000-000000000001',
  u."id",
  CASE u."role"
    WHEN 'SUPER_ADMIN' THEN 'OWNER'
    WHEN 'ADMIN'       THEN 'ADMIN'
    ELSE 'MEMBER'
  END,
  now()
FROM "users" u
WHERE NOT EXISTS (
  SELECT 1 FROM "memberships" m
   WHERE m."tenant_id" = '00000000-0000-4000-8000-000000000001'
     AND m."user_id" = u."id"
);

-- 平台角色收窄：ADMIN 废弃，降为 USER（租户内的 ADMIN 由 membership 承担）
UPDATE "users" SET "role" = 'USER' WHERE "role" = 'ADMIN';

UPDATE "users"
   SET "active_tenant_id" = '00000000-0000-4000-8000-000000000001'
 WHERE "active_tenant_id" IS NULL;

ALTER TABLE "users" ALTER COLUMN "active_tenant_id" SET NOT NULL;
ALTER TABLE "users" ADD CONSTRAINT "users_active_tenant_id_fkey"
  FOREIGN KEY ("active_tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "users_active_tenant_id_idx" ON "users" ("active_tenant_id");

-- ⑨ 给每个存量用户补一个空的个人空间
--    注意：会议**不迁移**，仍留在默认组织，保持现有协作关系。
--
-- 用临时映射表而不是「按 name 反查」：重名用户会串号，而 name 本来就不是唯一键。
DROP TABLE IF EXISTS "tmp_personal_tenant";
CREATE TEMP TABLE "tmp_personal_tenant" (
  "user_id"   INTEGER PRIMARY KEY,
  "tenant_id" UUID NOT NULL
) ON COMMIT DROP;

INSERT INTO "tmp_personal_tenant" ("user_id", "tenant_id")
SELECT u."id", gen_random_uuid()
FROM "users" u
WHERE NOT EXISTS (
  SELECT 1
  FROM "memberships" m
  JOIN "tenants" t ON t."id" = m."tenant_id"
  WHERE m."user_id" = u."id" AND t."type" = 'PERSONAL'
);

INSERT INTO "tenants" ("id", "name", "type", "platform", "updated_at")
SELECT t."tenant_id", u."name" || ' 的空间', 'PERSONAL', 'standalone', now()
FROM "tmp_personal_tenant" t
JOIN "users" u ON u."id" = t."user_id";

INSERT INTO "memberships" ("tenant_id", "user_id", "role", "created_at")
SELECT t."tenant_id", t."user_id", 'OWNER', now()
FROM "tmp_personal_tenant" t;
```

> `ON COMMIT DROP` 在 Prisma migrate 的事务里是有效的：整个迁移文件在一个事务内执行，
> COMMIT 时临时表自动消失，不会污染 schema。
> 开头那句 `DROP TABLE IF EXISTS` 只是为了让手工重跑也不报错。

**与 v1 相比少掉的风险**：
- 不 `DROP INDEX users_phone_key` → 不会踩"索引 vs 约束"那个静默失败
- 不动 `users_single_super_admin_key` → 超管唯一性一行没碰
- 回滚只需 `DROP COLUMN` + `DROP TABLE`，没有唯一键要重建

### 7.3 后置断言（v2 版）

v1 §10 记录的那次演练证明了一件事：**DDL 的静默无操作只能靠断言兜住**。
v2 的 DDL 风险低了，但断言不能省：

```sql
DO $$
DECLARE
  bad int;
BEGIN
  SELECT count(*) INTO bad FROM "meetings" WHERE "tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'meetings 有 % 行 tenant_id 为空', bad; END IF;

  SELECT count(*) INTO bad FROM "users" WHERE "active_tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'users 有 % 行 active_tenant_id 为空', bad; END IF;

  SELECT count(*) INTO bad FROM "asr_jobs" WHERE "tenant_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'asr_jobs 有 % 行 tenant_id 为空', bad; END IF;

  -- 每个用户的 active 空间必须有对应 membership，否则一登录就是 401
  SELECT count(*) INTO bad
    FROM "users" u
   WHERE NOT EXISTS (
     SELECT 1 FROM "memberships" m
      WHERE m."user_id" = u."id" AND m."tenant_id" = u."active_tenant_id"
   );
  IF bad > 0 THEN RAISE EXCEPTION '有 % 个用户的当前空间没有 membership', bad; END IF;

  -- 会议与创建者必须同租户（默认组织场景下天然成立）
  SELECT count(*) INTO bad
    FROM "meetings" m JOIN "users" u ON u."id" = m."owner_id"
   WHERE m."tenant_id" <> u."active_tenant_id";
  IF bad > 0 THEN RAISE EXCEPTION '会议与创建者跨租户：% 行', bad; END IF;

  -- 平台超管仍然只能有一个（这条索引 v2 没动，验证它还在）
  SELECT count(*) INTO bad FROM "users" WHERE "role" = 'SUPER_ADMIN';
  IF bad > 1 THEN RAISE EXCEPTION '平台超管不唯一：% 个', bad; END IF;

  RAISE NOTICE 'OK: v2 迁移断言全部通过';
END $$;
```

### 7.4 发布节奏

v2 的 DDL 都是加表加列，**可以一次执行**，不需要 v1 那样的两阶段发布。
但代码要分两次上：

1. **第一次发布**：只改 schema + 迁移 SQL + 守卫/上下文/权限函数，**不改任何业务查询**
   - 这一步上线后行为与今天完全一致（所有人都在默认组织）
   - 验证：`docker logs` 无异常、`meetings` 列表条数与迁移前一致
2. **第二次发布**：改 §6 的隔离点 + 企业/空间相关接口
   - 这一步才真正开始隔离

拆两次的价值：出错时能明确知道是"地基"还是"隔离逻辑"的问题。

---

## 8. 测试清单（验收的唯一标准）

放在 `backend/test/tenant-isolation.e2e-spec.ts`，每个用例前用固定种子重建两个企业。
不要依赖生产数据。

| # | 用例 | 断言 |
|---|---|---|
| 1 | A 企业 MEMBER 按 id 访问 B 企业会议 | 404（不是 403） |
| 2 | A 企业 ADMIN 按 id 访问 B 企业会议 | 404 |
| 3 | A 企业 ADMIN 的会议列表 / 统计 | 只含 A 的数据 |
| 4 | A 企业 ADMIN 的通讯录 | 不含 B 的员工 |
| 5 | A 企业 ADMIN 的用户列表（带 keyword 搜 B 的人） | 空结果 |
| 6 | A 用户把会议共享给 B 的人 | 403 |
| 7 | A 用户把 B 的人设为会议成员 / 负责人 | 403 |
| 8 | A 用户把待办指派给 B 的人 | 403 |
| 9 | A 用户勾选 B 的待办 | 404 |
| 10 | A 的审计日志 | 不含 B 的动作 |
| 11 | 同一手机号注册两次 | 第二次 409（全局唯一） |
| 12 | 同一人加入第二个企业 | 400（单企业约束） |
| 13 | 被移出企业后，旧 token 访问 | 401 或 404，不能是 200 |
| 14 | 个人空间升级为企业，原有会议 | 全部还在，可访问 |
| 15 | 平台超管不带 membership 访问任意会议 | 403 |
| 16 | 平台超管代登某企业成员 | 能看该企业，仍不能看其他企业 |
| 17 | A 企业的 ADMIN 按 id 查 B 企业的转写任务 | 404（对应 §6.10） |
| 18 | A 企业的 ADMIN 删除 B 企业的转写任务 | 404，且文件没被删 |
| 19 | 在企业空间创建会议时选「个人空间」 | `meeting.tenant_id` = 个人空间；企业 ADMIN 列表里看不到 |
| 20 | 创建会议时传别人的 tenantId | 404，且没有创建任何行 |
| 21 | AI 生成时选个人空间 | `meeting_generations` 与 `meetings` 的 `tenant_id` 一致 |
| 22 | 个人会议邀请另一个企业的好友 | 成功；该好友能打开会议详情、看到纪要 |
| 23 | 企业会议邀请非本企业的人 | 400「只能邀请本企业成员」 |
| 24 | 企业会议邀请我的好友（但好友不在本企业） | 400，同上 —— 好友关系不能突破企业边界 |
| 25 | 个人会议邀请非好友 | 400「只能邀请好友」 |
| 26 | 企业会议成员被移出企业后访问该会议 | 404（§6.2 的 `isCompany && !membership`） |
| 27 | 删好友后，该好友此前受邀的会议 | 仍可访问 —— 邀请是独立动作，不因删好友静默撤销 |
| 28 | 企业会议的 owner 离职后，企业 ADMIN 访问 | 200（会议留在企业，管理员接管） |
| 29 | 企业会议的 owner 离职后，他本人访问 | 404 |
| 30 | 腾讯会议回调建会议（无登录上下文） | `tenant_id` = owner 的 `active_tenant_id`，不是 NULL |

**有效性验证**：故意把 `visibleMeetingScope` 的管理员分支改回 `return {}`，
用例 2、3、4 必须变红。**测试不变红的隔离用例是假的** —— 这是 v1 §9 提的那条，非常重要。

---

## 9. 工期

| 任务 | 人日 |
|---|---|
| schema 变更 + 迁移 SQL + 本地/CI 验证 | 2–3 |
| `TenantContext` + 拦截器 + `PrismaService` 改造 | 2 |
| 守卫 / `AuthenticatedUser` / 权限函数拆分 | 1–2 |
| §6 隔离点改造（6.1–6.6 + 6.10，重点在 1877 行的 meetings.service） | 4–6 |
| 租户与成员接口（创建、邀请、移除、切换） | 2–3 |
| 创建会议的空间选择（§2.5 + §6.11，后端 4 处 + 前端表单） | 1–2 |
| 邀请范围校验（§2.6，企业=成员 / 个人=好友，3 处调用点） | 1–2 |
| 好友关系（表 + 加/删好友接口 + 前端选人） | 3–4 |
| 双租户隔离测试套件 | 2–3 |
| 前端：空间切换器、企业成员页、创建表单选择器、好友列表 | 5–7 |
| 现有单测修复 + 回归 | 1–2 |
| **合计** | **23–33 人日（4.5–6.5 周）** |

比 v1 的 13–18 人日多，原因不是迁移变复杂（反而简单了），而是 v1 漏算了五块：
`memberships` 这一层、租户/成员接口、创建时的空间选择、邀请范围与好友、前端。

### 9.1 演练记录（2026-11-24，已跑通）

环境：一次性 `postgres:16-alpine` 容器（Docker 29.8.0），端口 55433。
流程：32 个既有迁移 → 种子（3 用户 / 1 会议 / 1 待办 / 1 决策 / 负责人 / 成员 / 共享 / 审计 / 生成任务 / 通知 / 已读）→ 执行 `0002_multitenant_v2.sql` → 执行 `0002_multitenant_v2.verify.sql` → 迁移后归属自检。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/db/rehearse-multitenant-v2.ps1
```

**通过的断言**

| # | 断言 | 结果 |
|---|---|---|
| 1 | 4 张新表、6 张根表的 `tenant_id` 均为 NOT NULL | ✅ |
| 2 | `users` 没有 `tenant_id`（确认没叠加 v1） | ✅ |
| 3 | 枚举 `TenantType` / `TenantRole` 类型与取值齐全 | ✅ |
| 4 | `users_phone_key` 仍然存在（v2 刻意不改） | ✅ |
| 5 | `users_single_super_admin_key` 仍是全局唯一（未含 tenant_id） | ✅ |
| 6 | 六张根表 NULL 租户数全为 0 | ✅ |
| 7 | 每个用户恰好一个 PERSONAL 空间 | ✅ |
| 8 | 每个用户的 `active_tenant_id` 都有对应 membership | ✅ |
| 9 | 会议与创建者同租户 | ✅ |
| 10 | 一个账号可同时存在于多个空间（2 条 membership） | ✅ |
| 11 | 负例：重复 membership → 被唯一索引拒 | ✅ |
| 12 | 负例：好友自环 → 被 CHECK 拒 | ✅ |
| 13 | 负例：同手机号重复注册 → 被全局唯一拒 | ✅ |
| 14 | 负例：第二个平台超管 → 被拒 | ✅ |
| 15 | 回滚往返可完整还原（列/表/枚举，且唯一索引未受影响） | ✅ |
| 16 | 迁移后会议全在默认组织，`users.role` 无残留 ADMIN | ✅ |

**反例回归（证明断言不是摆设）**

把 ⑪ 步的 `'PERSONAL'` 改成 `'COMPANY'` 后重跑，迁移在断言处中断：

```text
ERROR:  有 3 个用户没有个人空间
CONTEXT: PL/pgSQL function inline_code_block line 42 at RAISE
```

退出码 1，容器删除，事务未提交。**如果没这条断言，三个人的"个人空间"会全是企业类型，
而迁移看起来完全成功。**

**首次跑挂掉的两次（都已修）**

1. 种子插 `13800000000` 作为超管 → 撞 `users_single_super_admin_key`。
   原因：迁移 `20261017163009` 已经内置了种子超管，`20261018181520` 把它改成了这个手机号。
   **v1 的 seed 只补两个员工，是对的；我一开始误判成"v1 有盲区"，那是错的。**
2. verify 第 3 节建了个新用户，期望他有 2 个空间 —— 但迁移已经跑完，
   不会再给新用户补个人空间。改成在测试数据里按 §6.12 的顺序手动建（先 tenant 后 user）。

**schema 与 SQL 的一致性验证（这一步最容易漏，但最值得做）**

手写迁移和 Prisma schema 是两份独立维护的真相，极容易漂移。漂移的后果不是报错，
而是**下次 `migrate dev` 生成一堆"修正迁移"**，而且没人知道该不该接受。

用 `migrate diff` 把"迁移后的真实库"和"schema 定义"对撞：

```bash
npx prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --script --exit-code
```

首次运行抓出四类差异，全是真问题：

| 差异 | 原因 | 后果 |
|---|---|---|
| 5 张表要 `DROP COLUMN tenant_id` | 我改 schema 时只加了 `Meeting`，漏了 `AuditLog` / `AsrJob` / `MeetingGeneration` / `MeetingNotice` / `InboxRead` | `migrate dev` 会把它们真的删掉 |
| 5 个外键 DROP + ADD | 内联 `REFERENCES` 没写 `ON UPDATE CASCADE`（默认 NO ACTION） | 约束行为与 schema 不符 |
| 9 个索引要 `RENAME` | 我用的是 v1 风格的缩写名（`meetings_tenant_created_idx`），Prisma 7 的约定是完整列名（`meetings_tenant_id_created_at_idx`） | 每次 diff 都报重命名 |
| `tenants.id` / `updated_at` 要 `DROP DEFAULT` | Prisma 的 `@default(uuid())` 与 `@updatedAt` 由**客户端**生成，DB 不该有默认值 | 同样的无意义迁移 |

全部修完后重跑，输出：

```text
-- This is an empty migration.
EXIT=0
```

**结论：schema 与手写 SQL 严格一致，`migrate dev` 不会产生任何多余迁移。**

代价是 `tenants` 表不能靠 DB 默认值生成 id 和 updated_at，
任何直接用 SQL 插入租户的脚本都必须显式给这两个值（迁移脚本与 verify 已按此处理）。

### 9.2 代码层落地进度（2026-11-24）

| 模块 | 状态 | 说明 |
|---|---|---|
| schema + 迁移 SQL | ✅ 完成 | 演练与 `migrate diff` 均通过 |
| `TenantType` / `TenantRole` 枚举、4 张新表 | ✅ 完成 | |
| `AuthenticatedUser` 扩字段 + 守卫加载 memberships | ✅ 完成 | 当前空间无 membership → 401 |
| 权限拆两层（`hasPermission` / `permissionsOf`） | ✅ 完成 | 平台超管不含任何 `MEETING_*` |
| `resolveMeetingAccess` 判定顺序重写 | ✅ 完成 | 企业会议非成员在 owner 之前拦 |
| `visibleMeetingScope` 按空间隔离 | ✅ 完成 | 所有分支带 tenantId |
| 创建会议可选空间（DTO + 服务端校验） | ✅ 完成 | `tenantId` 不传 = 当前空间 |
| AI 生成入口可选空间 | ✅ 完成 | 任务与会议同租户 |
| 邀请范围校验（企业=成员 / 个人=好友） | ✅ 完成 | `assertInvitable`，4 个调用点 |
| 好友 API（列表 / 加 / 删） | ✅ 完成 | `GET|POST|DELETE /api/friends` |
| 通讯录与用户列表按空间过滤 | ✅ 完成 | 修掉了最直接的跨企业泄露 |
| 租户管理：创建企业 / 我的空间 / 切换空间 | ✅ 完成 | `POST /tenants`、`GET /tenants/mine`、`PATCH /tenants/active` |
| 租户管理：成员列表 / 移除成员 | ✅ 完成 | `GET|DELETE /tenants/:id/members` |
| 邀请链接（生成 / 撤销 / 接受） | ✅ 完成 | `POST|GET|DELETE /tenants/:id/invites`、`POST /invites/inspect|accept` |
| 成员管理页（前端） | ✅ 完成 | `/settings/members`，仅企业 OWNER/ADMIN 可见 |
| 前端（空间切换器、创建表单选择器、成员管理页） | ✅ 完成 | 邀请接受页 `/join/:token` |
| 迁移正式纳入 `prisma/migrations/` | ✅ 完成 | `20261125130000_multi_tenant_v2`，详见 §9.5 |
| 生产库执行迁移 | ⬜ 待做 | 上线前必须先备份，见 §9.5 末尾 |
| 配额与计费 | ⬜ 待做 | `tenants.plan` 已预留 |

**测试**：`meetings.access.spec.ts`（21 例）+ `meetings.invite.spec.ts`（13 例）
+ `tenants.service.spec.ts`（14 例），覆盖跨租户管理员、离职 owner、
个人会议受邀好友、平台超管无会议能力、邀请范围的两个分支、
创建者不需要是自己的好友、移除成员后的空间回落。全量 221 个测试通过。

### 9.3 端到端验证（2026-11-25）

单测只能证明函数逻辑对，证明不了"接口真的能用" —— DI 装配、DTO 校验、
路由顺序、真实 SQL 都只有在跑起来的应用上才暴露。

**方法**：一次性 PG 容器（`postgres:16-alpine`）+ 编译产物 `node dist/main`
+ 真实 `curl`，用完即删，不碰本地开发库。

验证过的链路（括号内是实际结果）：

| # | 场景 | 结果 |
|---|---|---|
| 1 | 注册新用户 | 201，自动建个人空间，`tenantRole=OWNER`，14 个权限位 |
| 2 | `GET /tenants/mine` | 1 个 PERSONAL，`isActive=true` |
| 3 | `POST /tenants` 建企业 | 201，返回 OWNER，`memberCount=1` |
| 4 | **同一个 token** 调 `/auth/me` | 立即变成 COMPANY 空间 —— 守卫回库读生效 |
| 5 | 重复建企业 | 400「你已经属于企业「测试科技有限公司」」 |
| 6 | `PATCH /tenants/active` 切回个人 | 200，`/auth/me` 跟着变 |
| 7 | 切别人（默认组织）的空间 | 404「空间不存在」（不是 403） |
| 8 | 个人会议邀请非好友 | 400「只能邀请好友」 |
| 9 | 加好友后再邀请 | 201，成员 1 人 |
| 10 | **好友按 id 打开该个人会议** | 200，`access=member` —— 跨空间受邀可行 |
| 11 | 好友的会议列表 | 0 条 —— 列表按空间隔离（符合 §2.6 的取舍） |
| 12 | 企业会议邀请非本企业的人 | 400「只能邀请本企业成员」 |

**这轮抓到两个真 bug**（单测都没覆盖到）：

1. **默认组织的 id 不是合法 UUID**。`00000000-0000-0000-0000-000000000001`
   看着像 UUID，但第 4 组 variant 位是 0（RFC 4122 要求 8/9/a/b），
   `validator.isUUID` 判它非法 → 存量用户切回自己企业时吃 400。
   PostgreSQL 的 `uuid` 类型不校验版本位，所以这个坑只在应用层暴露。
   已换成 `00000000-0000-4000-8000-000000000001`（合规 v4），
   迁移 SQL / verify / 演练脚本 / 文档 / DTO 注释全部同步。
   DTO 也从 `@IsUUID('4')` 放宽到 `@IsUUID('all')` —— 权限由服务层校验，不该由格式拦住。

2. **创建者被当成"被邀请人"校验**。创建会议时创建者默认成为首位负责人，
   `assertInvitable` 拿到 `[自己, 好友]` 就去查"这些是不是我的好友"，
   而没人能把自己加为好友 → **个人会议永远建不起来**。
   修法：校验前排除自己（他本来就在这个空间里，不需要满足邀请条件）。

> 这两个都不是"写错了逻辑"，而是"两段正确的代码接在一起时假设不一致"。
> 单测按函数边界写，天然看不到这类问题。

### 9.4 邀请链接的验证（2026-11-25）

设计上有三个刻意选择：

1. **明文令牌只返回一次**，库里只有 SHA-256。管理员事后想看链接只能重新生成 ——
   一个永远能查到的邀请链接等于一个永久后门。
2. **inspect 是公开接口**。未登录就要能看到"你被邀请加入某某公司"，
   否则用户得先注册才知道这个链接是干什么的，那一步会流失大半。
   代价是它只能返回展示所需的最小信息：企业名、角色、脱敏手机号、是否可用，
   不返回企业 id（避免被用来探测空间）。
3. **次数用原生 SQL 原子扣减**（`WHERE used_count < max_uses AND expires_at > now()`）。
   先 SELECT 判断再 UPDATE 的写法，两个请求同时点一个单次链接会双双通过。

验证过的链路：

| # | 场景 | 结果 |
|---|---|---|
| 1 | 生成邀请 | 201，token 43 字符（32 字节 base64url），7 天有效 |
| 2 | **未登录** inspect | 返回企业名 / MEMBER / valid=true |
| 3 | 新用户接受 | 201，`alreadyMember=false`，当前空间自动切到企业 |
| 4 | 同一链接再点一次 | `alreadyMember=true`，不扣次数 |
| 5 | 定向邀请（指定手机号）被别的号接受 | 403「这个邀请是发给其他手机号的」 |
| 6 | 非成员用已用尽的链接 | 400「邀请链接已被使用」 |

**抓到的问题：幂等检查放晚了。**

第一版把「已是成员」的判断放在过期/用尽校验**之后**，结果是：
加入成功后刷新一下页面，提示就变成「邀请链接已被使用」—— 用户会以为自己没进去。

修法是把幂等检查提到最前（invite 存在之后、其他校验之前）：
他已经是成员了，这条链接是什么状态都不重要。
补充了一条测试用例锁住这个顺序。

### 9.5 迁移正式纳入 `prisma/migrations/`（2026-11-25）

在此之前，0002 一直躺在 `prisma/drafts/` 里，靠 psql 手工执行。这在开发期没问题，
但它意味着**生产库永远不会有这张表结构** —— 部署脚本跑的是 `migrate deploy`，
而 Prisma 只认 `migrations/` 目录。

落地方式：

```
prisma/migrations/20261125130000_multi_tenant_v2/migration.sql
```

由 `drafts/0002_multitenant_v2.sql` 原样复制，**唯一的改动是删掉首尾的 `BEGIN;` / `COMMIT;`**。

原因必须记牢：Prisma migrate 自己会把每个迁移包在一个事务里执行。文件里再写 `BEGIN`
会变成嵌套事务，那行 `COMMIT` 会**提前提交外层事务** —— 后面的语句一旦失败，
Prisma 无法整体回滚，却已经把它记成"执行成功"。这是最坏的一种失败：
数据库处在半迁移状态，而 `_prisma_migrations` 说一切正常。

`drafts/` 下的版本保留 `BEGIN/COMMIT`，用于两件事：psql 手工演练、反例回归
（故意改坏一处，验证后置断言能拦住）。它现在是**从属版本**，改动要同步两边。

#### 验证做了什么

| 检查 | 结果 |
|---|---|
| 全新库 `migrate deploy`（33 个迁移） | 一次建起，无报错 |
| `migrate diff` 对比 schema | 空（零漂移） |
| `migrate status` | 33 migrations，database schema is up to date |
| 存量超管数据 | 落在「默认组织」，租户角色 OWNER |
| 每人空间数 | 1 个 PERSONAL + 1 个 COMPANY（符合 §6.10 的断言） |

#### 演练脚本也跟着改了

原来的 rehearse 脚本是「deploy 32 个 → 灌种子 → psql 跑 drafts 的 SQL」。
0002 进入 `migrations/` 之后这个顺序会坏掉：`migrate deploy` 会连 v2 一起跑完，
再灌种子时 `users.active_tenant_id` 已经是 NOT NULL，种子的 INSERT 会失败。

新流程（`scripts/db/rehearse-multitenant-v2.ps1`）：

```
1. 暂时把 v2 目录移出 prisma/migrations/
2. migrate deploy        → 32 个旧迁移，造出"上线前"的真实结构
3. 灌种子
4. 把 v2 目录移回
5. migrate deploy        → 只跑 v2，走真实迁移路径
6. verify + post 检查
7. migrate diff 对齐检查
```

第 5 步是关键差异：v2 现在由 **Prisma 执行**（会写 `_prisma_migrations`），
和生产上线走的是同一条路。之前是 psql 直接跑，Prisma 根本不知道它发生过。

脚本用 `try/finally` 保证无论成败都把目录移回去 ——
目录少一个迁移的后果很隐蔽：`migrate deploy` 会当作"这个版本本来就没有它"，
生产漏跑 v2，而本地一切正常。

#### 生产上线流程（未执行）

```bash
# 1. 备份（必须）
docker exec meetmind-db-1 pg_dump -U meetmind -d meetmind -Fc \
  > /opt/meetmind/backups/pre-multitenant-$(date +%m%d%H%M).dump

# 2. 迁移
cd /opt/meetmind && docker compose --profile prod run --rm migrate

# 3. 验收
docker exec -it meetmind-db-1 psql -U meetmind -d meetmind \
  -f /tmp/0002_multitenant_v2.verify.sql

# 4. 重启后端
docker compose --profile prod up -d backend frontend
```

**注意**：这次上线会让所有存量用户被放进「默认组织」企业空间，
平台超管从"能看全部会议"变成"读不到任何企业会议"（符合 §5.3 的设计）。
上线前应当先告知用户，尤其是正在用超管账号的人。

---

---

## 10. 待确认

1. **生产上那 7 个账号是不是同一家公司？**
   如果混了多个客户，迁移前必须先拆租户，否则他们会互相看到彼此的会议。
   这是唯一无法用代码决定的事。

2. **原 ADMIN 是谁，他该在新结构里拿什么角色？**
   迁移脚本默认 `membership.ADMIN`（等价于现在的"看全部会议 + 管普通用户"）。
   如果他的实际职责只是 HR 或行政，可能更适合 `MEMBER` + 单独授权。

3. **是否现在就做配额？**
   `tenants.plan` 列已预留。真正要做时，在 `POST /api/meetings` 和
   `POST /api/ai/generate` 两处校验（AI 是唯一真金白银的成本）。

4. **个人会议拉同事，算不算绕过企业管理？**
   按 §2.6 的设计，只要对方是好友就行 —— 哪怕是同企业的同事。
   也就是说两个员工可以用个人空间开一场企业看不到的会。

   技术上没问题，但中大型企业采购时会问这个。如果想堵，加一条限制：
   **个人会议不能邀请与我同企业的人**（先转成企业会议再拉人）。
   代价是"我和同事私下聊两句"这个场景做不了。

   建议先不加限制。等真有企业客户提，再作为可配置项（`tenants.policy`）加上。

5. **已经在企业空间的用户，历史上那些"私人开的小会"怎么办？**
   存量数据全部归入默认组织（§2.4），所以那些人过去的私人会议现在都是企业可见的。
   如果里面有敏感内容，迁移前要提醒用户，或者提供一次"把这些会议挪到我的个人空间"的工具。
   这取决于那 7 个账号的实际使用情况。

6. ~~**"好友"用方案 A 还是方案 B？**~~ 已定 **方案 A**（显式 `friendships` 表，
   2026-11-24）。加好友免审批、按手机号精确查找、第一版不做独立好友管理页。

---

## 附：与 v1 文件的关系

| 文件 | 处理 |
|---|---|
| `docs/multi-tenant-plan.md` | 保留，标注"已被 v2 取代"。§3.3 Prisma 扩展、§6 RLS、§10 演练记录仍然有效 |
| `backend/prisma/drafts/0002_multitenant_v2.sql` | **v2 的迁移脚本，待演练验证后落地** |
| `backend/prisma/drafts/0002_multitenant_v2.verify.sql` | **v2 的验收脚本**，与上面配套 |
| `backend/prisma/drafts/0001_multitenant.sql` | **不再执行**。它的第 ⑤⑥ 步与 v2 冲突（拆手机号唯一键、按租户建超管索引） |
| `backend/prisma/drafts/0001_multitenant.verify.sql` | **不再使用**。它的断言 1、3、4、6、7、8 与 v2 正好相反（v2 要求那两条唯一索引保持全局） |
| `scripts/db/rehearse-multitenant.ps1` | 演练框架可复用，把输入的 SQL 换成 0002 的两个文件即可 |

> 两个 verify 脚本**互斥**，别在同一库上先后跑：v1 断言"全局手机号唯一索引已消失"，
> v2 断言"它仍然存在"。
