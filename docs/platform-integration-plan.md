# 平台应用接入方案（飞书 / 企业微信 / 腾讯会议）

> 前提：先完成 [多租户改造](multi-tenant-plan.md)。
> 应用市场模式下「一个应用服务 N 个企业」是硬前提，不做多租户就装不上第二个企业。
>
> 本文的平台接口细节会随平台版本变化，**上架前必须逐条对照官方文档**。
> 每个平台的关键未知数都收敛到了 §3 的一个接口方法里（`pullContent`），
> 这是本方案刻意的设计：**在拿到实测结论前，代码结构不为任何平台的假设买单。**

---

## 0. 推荐顺序与理由

| 顺序 | 平台 | 理由 | 预计工期 |
|---|---|---|---|
| 1 | **飞书** | 开放平台文档最完整、商店应用（ISV）模型最规范、事件订阅机制干净（验签 + AES 解密，实现统一）；网页应用 iframe 嵌入成熟 | 2 周（不含审核） |
| 2 | **企业微信** | 企业覆盖最广，但第三方应用的 Suite 授权模型最绕（suite_ticket → pre_auth_code → permanent_code → corp_access_token），加解密要自己实现 | 1.5–2 周 |
| 3 | **腾讯会议** | 内容获取最不确定（录制/转写依赖版本与开通项），且没有通讯录，只能做"会议"这一层 | 1–1.5 周 |

**先做飞书还有一个非技术理由**：飞书的示例代码和错误码文档质量最好，
把飞书跑通之后再接企微，你在飞书上踩过的"回调验签 / 幂等 / 免登映射"三个坑可以复用到后两个平台。

---

## 1. 目标架构

```
        飞书 / 企微 / 腾讯会议
                │
     ┌──────────┼──────────────┬─────────────────┐
     │  ①免登    │  ②事件回调    │  ③内容拉取（可选） │
     ▼          ▼              ▼                 │
┌────────────────────────────────────────────┐  │
│  backend/src/integrations/  （新增模块）      │  │
│  ├─ adapters/feishu.adapter.ts              │  │
│  ├─ adapters/wecom.adapter.ts               │  │
│  ├─ adapters/tencent.adapter.ts             │  │
│  ├─ platform-event.controller.ts  ← @Public │  │
│  ├─ platform-login.controller.ts  ← @Public │  │
│  ├─ identity.service.ts   外部身份 ↔ users   │  │
│  ├─ tenant.service.ts     安装 ↔ tenants     │  │
│  └─ content.service.ts    录制/转写 → 存储    │  │
└────────────────────────────────────────────┘  │
                │                                │
                ▼                                │
┌────────────────────────────────────────────┐  │
│  现有领域层 —— 一行不改                      │  │
│  meetings / ai / inbox / todo / audit       │  │
└────────────────────────────────────────────┘  │
```

**关键取舍：平台只做"壳"，不做"脑"。**
身份、组织架构、日程、待办推送这些"平台更擅长"的事交给适配层；
纪要生产（转写 → LLM → 结构化待办）留在自己的服务端，因为：

1. 三家的转写文本获取都不保证成功，不能作为产品能力的唯一来源
2. 自己的 ASR 才能**按分钟计量**，才有计费基础
3. 私有化客户要求数据不出内网，平台 SaaS 给不了

---

## 2. 为什么"AI 会议纪要"不能当卖点

飞书有妙记 + 会议智能纪要，腾讯会议有智能录制 + AI 小助手，企业微信会议也有智能总结。
在应用市场里，"我们能把会议转成纪要"是一个**已经被免费满足的需求**。

能收钱的是下面三件事，而且恰好是现有代码最厚的部分：

| 卖点 | 平台不会做 | 现有实现 |
|---|---|---|
| 纪要 → **可跟踪的待办**（负责人、截止、状态流转、超时提醒、收件箱） | ✅ 平台纪要读完就结束 | `meeting_todos` / `inbox` / `meeting_leaders` 已完整 |
| **跨平台统一**（飞书 + 企微 + 腾讯会议 的纪要进同一个库） | ✅ 谁都不接对手 | 本来就是独立系统 |
| **合规留档 + 私有化** | ✅ SaaS 给不了数据不出内网 | `audit_logs` / 单入口 Docker |

上架的文案、权限申请理由、定价页都应该围绕"会后闭环"，而不是"AI 生成"。

---

## 3. 统一适配层（把未知数关进一个方法）

```ts
// backend/src/integrations/adapters/platform-adapter.ts
export type Platform = 'feishu' | 'wecom' | 'tencent';

/** 平台侧的一个用户身份 */
export interface ExternalIdentity {
  platform: Platform;
  /** 平台侧企业标识：飞书 tenant_key / 企微 corpid / 腾讯会议企业 id */
  tenantExternalId: string;
  /** 平台侧用户标识：飞书 open_id / 企微 userid */
  externalUserId: string;
  /** 跨应用稳定 id（飞书 union_id），换应用不换人 */
  unionId?: string;
  name?: string;
  mobile?: string;
  email?: string;
}

/** 平台事件；验签解密后由适配器归一化成这个结构 */
export interface VerifiedEvent {
  platform: Platform;
  /** 平台事件的唯一 id，作为幂等键。平台没有提供时用 body 的 hash */
  eventId: string;
  /** 归一化后的类型：app_installed / user_added / meeting_started / meeting_ended / recording_ready */
  type: string;
  tenantExternalId?: string;
  payload: unknown;
}

export interface ExternalMeetingRef {
  meetingId: string;
  title?: string;
  startedAt?: Date;
  endedAt?: Date;
  /** 参会人（平台侧 id），用于把待办自动匹配到人 */
  participantIds?: string[];
}

export interface MeetingContent {
  /** 平台已经转写好的文本；拿不到就是 undefined */
  transcript?: string;
  /** 录制文件地址；通常带时效，必须立刻下载转存 */
  audioUrl?: string;
  expiresAt?: Date;
}

export interface PlatformAdapter {
  readonly platform: Platform;

  /** ① 回调入口：验签 + 解密 + 归一化。返回 challenge 时表示这是 URL 验证请求 */
  verifyEvent(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<VerifiedEvent | { challenge: string } | null>;

  /** ② 免登：平台给的 code 换身份 */
  exchangeLoginCode(code: string): Promise<ExternalIdentity>;

  /** ③ 通讯录：用于首次安装时批量建立 users */
  fetchContacts(tenantExternalId: string): Promise<ExternalIdentity[]>;

  /** ④ 会议列表：拉取"刚结束"的会议 */
  listRecentMeetings(
    tenantExternalId: string,
    since: Date,
  ): Promise<ExternalMeetingRef[]>;

  /**
   * ⑤ 内容获取 —— 整个方案最不确定的一步。
   * 返回 null 表示"这个平台这个客户拿不到"，调用方走降级链（§6），不是错误。
   * 腾讯会议/企微的实现初期可以直接 `return null`，产品仍然可用。
   */
  pullContent(
    tenantExternalId: string,
    meeting: ExternalMeetingRef,
  ): Promise<MeetingContent | null>;
}
```

> 这个接口的价值：**平台能力差异不会渗透进业务层**。
> 飞书能拿到转写、企微拿不到，都不影响 `meetings` / `ai` 模块的任何一行代码。

---

## 4. 飞书接入（先做这个）

### 4.1 应用类型选择

| 类型 | 用途 | 何时用 |
|---|---|---|
| 企业自建应用 | 只装在自己企业，**无需上架审核** | **第 1 步验证期**，1 周内可跑通 |
| 商店应用（ISV） | 上架应用市场，N 个企业安装 | 第 4 步，需要服务商入驻 + 应用审核 |

**强烈建议先用自建应用打样**：不审核权限理由、不需要软著，能最快拿到真实客户数据。
自建应用的代码有 90% 可以直接复用到商店应用（差别只在 app 凭证来源与安装授权流程）。

### 4.2 凭证与 token

```text
应用凭证        app_id / app_secret
app_access_token    POST /open-apis/auth/v3/app_access_token/internal
tenant_access_token POST /open-apis/auth/v3/tenant_access_token/internal   （有效期 2h）
```

`tenant_access_token` **必须缓存**（内存 + 过期前 5 分钟刷新），每次请求都去换会被限流。
自建应用只有一个 tenant；商店应用要按 `tenant_key` 分开缓存——这是最容易被忽略的一处。

### 4.3 免登（身份）

```
前端（iframe 内或跳转）
  → GET https://open.feishu.cn/open-apis/authen/v1/index
        ?app_id=<app_id>&redirect_uri=<回调>&state=<csrf>
  → 回到你的域名，带 code
  → 后端 POST /open-apis/authen/v1/oidc/access_token
        Authorization: Bearer <app_access_token>
        { grant_type: "authorization_code", code }
  → 得到 open_id / union_id / name / avatar
```

注意：

- `state` 必须校验，否则是登录 CSRF
- 网页应用在 iframe 内也可以用 JSAPI `tt.requestAuthCode({ appId })` 直接拿 code，不必跳转（体验更好，但需要 `h5sdk.config` 验签，配置成本更高）
- **回调地址必须和开放平台后台登记的一致**，包括 http/https 和末尾斜杠

### 4.4 事件订阅（回调）

飞书事件是**加密 + 签名**双保险：

```text
请求头：X-Lark-Request-Timestamp / X-Lark-Request-Nonce / X-Lark-Signature
签名：  sha256(timestamp + nonce + encrypt_key + rawBody)
请求体：{ "encrypt": "<base64>" }
解密：  key  = sha256(encrypt_key)
        iv   = buffer[0..16]
        data = buffer[16..]
        plain = AES-256-CBC.decrypt(key, iv, data)
```

解密后有两种形态：

```jsonc
// 1) URL 验证（配置事件订阅地址时先打这个）
{ "type": "url_verification", "challenge": "xxx", "token": "verification_token" }
// → 原样返回 { "challenge": "xxx" }

// 2) 真实事件
{ "schema": "2.0", "header": { "event_id": "...", "event_type": "..." }, "event": { ... } }
```

**必须用原始请求体验签**，所以 Nest 启动时要开 `rawBody`：

```ts
// backend/src/main.ts:15 现在是
const app = await NestFactory.create<NestExpressApplication>(AppModule);
// 需要改成
const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  rawBody: true,
});
```

然后在控制器里取 `req.rawBody`（Buffer）。**不开这个选项，验签永远失败**，
而且报错只会是"签名不匹配"，很难查。这是本项目接入前必须改的第一行。

### 4.5 通讯录

```text
POST /open-apis/contact/v3/users/batch_get_id?user_id_type=open_id
     { "mobiles": ["13800138000"] }
GET  /open-apis/contact/v3/users/:user_id?user_id_type=open_id
GET  /open-apis/contact/v3/users/find_by_department
```

用途：首次安装时把企业员工批量建成 `users`（`tenant_id` = 该企业），
避免"员工第一次打开应用时才发现没账号"的冷启动问题。

权限：`contact:user.base:readonly`、`contact:user.phone:readonly` 等，**审核会逐条问用途**。

### 4.6 会议与录制（验证期的核心问题）

```text
事件：会议开始 / 会议结束 / 录制完成（vc.meeting.* 系列）
接口：获取会议详情、获取录制文件、妙记（Minutes）转写文本
```

**这三个接口的可获得性必须在 3 天打点测试里实测**：

| 问题 | 影响 |
|---|---|
| 免费版/标准版企业能不能拿到录制？ | 决定目标客户层级 |
| 转写文本是"妙记"才有，还是录制就有？ | 决定是否必须自建 ASR |
| 权限审批要多久、会不会被拒？ | 决定上架时间线 |
| 录制下载地址有效期多久？ | 决定是否需要即时下载 + 对象存储 |

在拿到答案之前，`pullContent` 一律 `return null`，产品走 §6 的降级链。

### 4.7 前端要改的地方

| 项 | 问题 | 处理 |
|---|---|---|
| iframe 嵌入 | **现在是被主动禁止的**：nginx 写死了 `add_header X-Frame-Options SAMEORIGIN`（[`nginx.conf:33`](../frontend/nginx.conf#L33)），飞书 iframe 会直接白屏 | 去掉 `X-Frame-Options`，改用 `Content-Security-Policy: frame-ancestors https://*.feishu.cn https://*.feishu.net`。注意 `X-Frame-Options` 与 CSP 同时存在时老浏览器以 XFO 为准，**必须删掉 XFO** |
| token 存储 | 现在是 `localStorage`（[`http.ts:23`](../frontend/src/api/http.ts#L23)），iframe 内第三方存储受限，且不能依赖 cookie | 保留 Bearer，但入口 token 由父窗口 `postMessage` 传入；不要改成 cookie（会引入 CSRF 和第三方 cookie 问题） |
| 移动端 | 现有布局是桌面侧边栏（[`App.vue:67`](../frontend/src/App.vue#L67)），飞书/企微大量用户在手机上点开 | **至少要有移动端可用的"看纪要 + 勾待办"页面**，不要求全功能。这是上架前必须补的，不是可选项 |
| SPA 路由 | `createWebHistory` 在子路径部署会 404 | 根路径部署已覆盖（[`nginx.conf:66`](../frontend/nginx.conf#L66) 有回退）；若应用挂载到飞书的子路径，需给 `createRouter` 传 `base` |

> 移动端这一条容易被忽略，但它是应用市场审核和使用率的第一道门槛：
> 在飞书里点开应用，90% 的第一次访问发生在手机上。

---

## 5. 企业微信 / 腾讯会议的差异（不重复飞书的部分）

### 5.1 企业微信：Suite 授权模型

```
① 推送 suite_ticket（每 10 分钟，加密）
     → POST /cgi-bin/service/get_suite_token
       { suite_id, suite_secret, suite_ticket } → suite_access_token（缓存，2h）

② 管理员在应用市场点"添加"
     → 引导到授权页（带 pre_auth_code）
     → 回调带 auth_code
     → POST /cgi-bin/service/get_permanent_code → permanent_code（企业级，长期）

③ 换企业 token
     → POST /cgi-bin/service/get_corp_token
       { auth_corpid, permanent_code } → corp_access_token

④ 身份
     → OAuth2 scope=snsapi_base → code → /cgi-bin/auth/getuserinfo → UserId
```

坑位：

- **`suite_ticket` 必须持久化**。服务重启后如果没缓存，`get_suite_token` 会失败，
  所有企业的操作一起挂。建议存 `platform_installations` 表，不要只用内存。
- 企微的加解密与飞书不同（AES + SHA1 `msg_signature` + `WXBizMsgCrypt`），
  没有官方 Node SDK，要用社区实现或自己写，**务必先用官方测试用例验证解密正确**。
- 消息回调要求 **5 秒内返回 200**，且失败会重试。所以：**回调里只做"存事件 + 入队"，不做业务**。

### 5.2 腾讯会议：签名 + 无通讯录

```
请求头：AppId / SdkId / Timestamp / Nonce / Signature
Signature = HMAC-SHA256(SecretKey, AppId + SdkId + Timestamp + Nonce + Body)
```

- 没有通讯录接口 → `fetchContacts` 实现为空数组，用户首次进入时按需创建
- 会议/录制接口齐全，但**录制转写是否可得取决于版本与开通项**（实测）
- 录制下载地址有时效 → 必须"拿到就下载、下载即转存"到对象存储，不能把平台 URL 存进库
- 应用市场以**会中扩展应用**为主（iframe/小程序容器），和"会后纪要"的定位需要重新设计入口

---

## 6. 内容获取的三级降级链（产品可用性的关键）

```
第 1 级  平台已转写的文本        最省事，但三家都不保证
   ↓ 拿不到
第 2 级  平台录制文件 → 自己的 ASR   可控、可计量，需对象存储 + 队列 + ASR 供应商
   ↓ 拿不到（或客户未开录制）
第 3 级  用户手动上传录音 / 粘贴文本  永远可用，也是私有化客户的主路径
```

**为什么必须先做第 2、3 级**：如果产品只依赖第 1 级，
第一个客户没开云录制，整个应用就是空的——而这在实测之前无法排除。

第 2 级落地时需要的东西（都已在上一轮讨论过，这里只列清单）：

- 对象存储（S3/OSS/MinIO），替代本地 `uploads`（[`main.ts:12`](../backend/src/main.ts#L12)）
- 队列（BullMQ + Redis），替代进程内 `void this.runGeneration(...)`（[`ai.service.ts:585`](../backend/src/ai/ai.service.ts#L585)）
- ASR 供应商（阿里 Paraformer / 讯飞 / Whisper 自建），按分钟计价
- 用量计量表（`usage_records`），按租户累计分钟数与 token 数 → 计费与配额

---

## 7. 新增数据表

```prisma
/// 平台安装：一个企业装一次 = 一行。
/// 与 tenants 分开是因为"安装关系"有生命周期（授权/取消授权/欠费），
/// 而 tenant 是业务主体，取消授权后数据还要保留一段时间。
model PlatformInstallation {
  id           Int      @id @default(autoincrement())
  tenantId     String   @map("tenant_id") @db.Uuid
  platform     String   @db.VarChar(32)
  /// 平台侧企业 id（飞书 tenant_key / 企微 corpid / 腾讯会议企业 id）
  externalId   String   @map("external_id") @db.VarChar(120)
  /// 企微 suite_ticket 等长期凭证，加密存储
  credentials  Json?
  status       String   @default("ACTIVE") @db.VarChar(20)
  installedAt  DateTime @default(now()) @map("installed_at") @db.Timestamptz(3)
  revokedAt    DateTime? @map("revoked_at") @db.Timestamptz(3)

  @@unique([platform, externalId])
  @@map("platform_installations")
}

/// 外部身份映射：平台用户 ↔ 本地用户。
/// 手机号/邮箱不作为主键（平台常常不返回），只用于认领与展示。
model ExternalIdentity {
  id           Int      @id @default(autoincrement())
  tenantId     String   @map("tenant_id") @db.Uuid
  userId       Int      @map("user_id")
  platform     String   @db.VarChar(32)
  externalUserId String @map("external_user_id") @db.VarChar(120)
  unionId      String?  @map("union_id") @db.VarChar(120)
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  @@unique([platform, externalUserId])
  @@unique([tenantId, userId, platform])
  @@map("external_identities")
}

/// 平台事件（幂等 + 重放保护）。
/// 平台会重推，event_id 唯一是唯一可靠的去重手段。
model PlatformEvent {
  id             Int      @id @default(autoincrement())
  platform       String   @db.VarChar(32)
  eventId        String   @map("event_id") @db.VarChar(160)
  type           String   @db.VarChar(80)
  tenantId       String?  @map("tenant_id") @db.Uuid
  payload        Json
  receivedAt     DateTime @default(now()) @map("received_at") @db.Timestamptz(3)
  processedAt    DateTime? @map("processed_at") @db.Timestamptz(3)
  error          String?  @db.Text

  @@unique([platform, eventId])
  @@index([processedAt])
  @@map("platform_events")
}
```

---

## 8. 安全清单（每一条都对应过历史事故）

| 项 | 要求 |
|---|---|
| 回调端点 | `@Public()` 但**自己验签**；只接受 POST；必须校验时间戳在 5 分钟内（防重放） |
| 原始 body | `rawBody: true`，否则飞书/企微验签全失败 |
| 幂等 | `platform_events(platform, event_id)` 唯一键，冲突即跳过，返回 200 |
| 快速响应 | 回调里禁止调业务（不调 LLM、不下载录制），只写事件表 + 入队，5 秒内返回 |
| 限流 | 回调端点单独限流（按 IP + 平台），防止伪造事件打爆 |
| 平台 token | 按 `tenant_key` 分别缓存，过期前刷新，禁止每请求换 |
| 凭证存储 | `app_secret` / `suite_secret` / `encode_aes_key` 进环境变量，不进库；入库的部分（`permanent_code`）加密 |
| 越权 | 用外部身份登录后，**tenant 只能来自 `installation`，不能来自请求参数**（否则可伪造 `tenant_id` 跨租户登录） |
| 日志 | 回调日志不打印完整 body（含姓名/手机号），只打 event_id + type |

最后一条最容易被忽略：**任何"从请求里取 tenant_id"的实现都是漏洞**。
tenant 只能由服务端根据 `platform + external_tenant_id` 反查安装表得到。

---

## 9. 里程碑

| 阶段 | 交付物 | 工期 | 验证标准 |
|---|---|---|---|
| M0 | 权限打点报告：三家各"能不能拿到会议内容" | 3 天 | 有一张对照表，结论明确 |
| M1 | 多租户改造完成 | 2.5–3 周 | 双租户隔离用例全绿（见多租户方案 §7） |
| M2 | 飞书**自建应用**跑通：免登 + 通讯录 + 1 个真实客户产出纪要 | 1–2 周 | 客户能在飞书里点开、看到自己会议的纪要 |
| M3 | 服务端 ASR + 对象存储 + 队列 + 用量计量 | 2–3 周 | 一次真实会议能从录音端到端产出待办 |
| M4 | 飞书**商店应用**：安装/卸载/授权事件 + 权限申请材料 | 1–2 周 | 测试企业可安装 |
| M5 | 移动端"看纪要 + 勾待办"页面 | 1 周 | 飞书手机端可用 |
| M6 | 上架审核 + 整改 | 2–4 周（并行） | 审核通过 |
| M7 | 企微 / 腾讯会议适配 | 2–3 周 | 复用 M2–M6 的 90% |

**累计到"飞书上架可收费"约 8–11 周工程 + 资质并行。**

---

## 10. 上架前资质清单

| 项 | 说明 | 谁办 |
|---|---|---|
| 企业主体 + 对公账户 | 收费、开票、平台结算必需 | 工商 |
| 服务商入驻 + 企业认证 | 飞书 ISV / 企微服务商 | 运营 |
| 软件著作权 | 多数应用市场要求，办理约 1–2 个月 | 知产代理 |
| 隐私政策 + 个人信息处理规则 | 语音属敏感个人信息，要单独同意的交互设计 | 法务 |
| 数据出境评估 | 私有化客户必问；SaaS 版也要准备说明 | 法务 |
| 等保二级 | 政企客户投标常要求 | 测评机构 |
| 权限申请理由文案 | 通讯录 / 会议 / 录制 / 云文档都是高权限，驳回是常态 | 产品 |
| 应用截图 / 使用说明 / 定价 | 审核材料 | 产品 |

**时间陷阱**：软著和等保的办理周期比写代码长。**第一周就该启动**，不要等工程做完。

---

## 11. 止损条件

任何一条成立，就应该停下来重新评估，而不是继续投入：

1. **M0 打点结论：三家都拿不到会议内容，且客户也不愿意手动上传录音** → 「AI 纪要」在这个平台上是伪需求，退回私有化交付路线
2. **飞书商店应用权限申请连续两次被拒，且不给具体理由** → 先只做自建应用（客户会付部署费，也是收入）
3. **客户明确说"平台自带的纪要够用了"** → 立刻把产品定位收缩到"待办跟踪 + 合规留档"，砍掉纪要生成的重投入
4. **移动端在飞书 webview 里不可用且短期修不好** → 暂停上架，先补移动端

---

## 12. 进度与下一步

| 事项 | 状态 | 产物 |
|---|---|---|
| `main.ts` 开 `rawBody` | ✅ 已改并通过 tsc / lint / build / 单元测试 | [`backend/src/main.ts`](../backend/src/main.ts) |
| 多租户迁移演练 | ✅ 已在一次性 PG 16 容器跑通（含正例、负例、回滚） | [多租户方案 §10](multi-tenant-plan.md) |
| 打点脚本 | ✅ 三个平台各一个，只读探测 | [`scripts/spike/`](../scripts/spike/README.md) |
| 打点报告 | ⬜ 待填（需要你去开放平台建应用拿凭证） | [`docs/platform-spike-report.md`](platform-spike-report.md) |
| `integrations` 模块骨架 | ⬜ 未开始（等 M0 结论，避免为错误的假设写代码） | — |

接下来按顺序：

1. **去三个开放平台各建一个自建应用**，拿到凭证 → 跑 `scripts/spike/*.mjs` → 填打点报告。
   这一步不需要写任何业务代码，但它的结论决定后面所有投入的方向。
2. 结论出来后再决定：是否立刻做服务端 ASR、先上哪个平台、定价模型。
3. `integrations` 模块骨架 + `platform_events` 表（先只做幂等与验签框架，不做任何平台实现）。
