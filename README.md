# MeetMind

> 基于 Vue 3 + NestJS + Prisma + PostgreSQL + DeepSeek API 的 AI 智能会议纪要系统

MeetMind 是一个面向会议内容整理场景的全栈 AI 应用。用户输入会议内容后，系统调用 DeepSeek 大语言模型，将会议内容自动整理为**会议摘要、关键决策和待办事项**，并将结构化结果保存到 PostgreSQL 数据库中，支持后续历史会议管理与待办事项维护。

## ✨ 核心功能

### 登录与权限分级

采用 **手机号 + 密码** 登录（JWT 认证），叠加三级 RBAC + 资源级共享授权两层权限模型。

| 能力 | 用户 USER | 管理员 ADMIN | 超级管理员 SUPER_ADMIN |
|---|:---:|:---:|:---:|
| 会议读写 | 仅自己的 | 全部 | 全部 |
| 共享自己的会议 | ✅ | ✅ | ✅ |
| 删除任意会议 | ❌ | ✅ | ✅ |
| 查看用户列表 | ❌ | ✅ | ✅ |
| 创建/停用普通用户 | ❌ | ✅ | ✅ |
| 管理管理员账号 | ❌ | ❌ | ✅ |
| 提升他人为超管 | ❌ | ❌ | ❌ |
| 切换身份（以他人账号浏览） | ❌ | ❌ | ✅ |
| 修改自己的姓名/密码 | ✅ | ✅ | ✅ |
| 控制会议录音开关 | 仅本人负责/创建的会议 | 否（见下） | 任意会议 |

> **超级管理员全局唯一**：该角色不可新建、不可提升、不可降级、不可停用、不可删除。
> 应用层（`UsersService`）与数据库层（部分唯一索引 `users_single_super_admin_key`）双重保证，
> 即使直接连库改数据也无法出现第二个超管。
> 代价：超管角色无法通过接口转移，需要换人时只能直接改库（有意为之的取舍）。

- **数据隔离**：每场会议有唯一归属者，普通用户只能看到自己的、自己负责的、被共享给自己或作为成员参与的会议
- **共享授权**：会议拥有者可把会议共享给其他人，并选择「只读」或「可编辑」
- **成员参与**：每场会议有负责人与成员，成员可读会议内容；待办状态由会议负责人、该待办负责人或超级管理员修改（详见「会议负责人与成员」）
- **权限即时生效**：守卫每次请求都回库校验用户状态，停用账号或降级角色后旧 token 立刻失效
- **防越权设计**：无权访问返回 404 而非 403，避免通过状态码差异探测会议是否存在；管理员看不到也管不到超管账号

### 切换身份（代登）

超级管理员可在「用户管理」里对任意账号点「切换身份」，直接以对方视角进入系统，
用于排查「他说看不到某场会议」这类问题。页面顶部会常驻一条提示条，可一键返回自己的账号。

安全约束：

- **仅超级管理员可用**，管理员即使能管账号也不能代登（代登能看到用户私有会议）
- 不能代登自己、不能代登已停用账号、不能代登超级管理员
- **代登会话不能再次代登**，避免形成权限链
- 代登令牌带 `imp` 声明记录真实操作者，有效期缩短为 **2 小时**
- 原账号会话保存在 `sessionStorage`，刷新页面仍可返回；关闭标签页即失效


**个人中心入口**：侧边栏导航只放业务功能（纪要 / 看板 / 历史 / 草稿箱）。
个人中心与用户管理不占导航项，入口是**左下角的头像与用户名** —— 点击即进入个人中心，
避免导航栏被账号类功能挤满。管理员的「用户管理」入口与**退出登录**都放在个人中心页内，
侧边栏不再放退出按钮，避免在导航区域误触。

### AI 会议纪要生成

- 输入会议原始内容
- 调用 DeepSeek API 进行内容分析
- 自动生成会议摘要
- 自动提取会议决策
- 自动提取待办事项
- 将 AI 输出转换为结构化 JSON 数据
- 生成结果保存到数据库

### 会议实时转写与录音

- 基于浏览器 SpeechRecognition 实时语音转文字
- 支持开始、**暂停 / 继续**、结束，暂停期间计时同步冻结
- 暂停瞬间的中间识别结果会落定，不会丢字
- 基于 MediaRecorder 同步录制会议音频，与转写同起同停
- 录音与会议记录绑定保存（默认存放于 `backend/uploads`）
- 会议详情页提供录音回听，支持进度跳转
- **录音可鉴权播放**：不再通过静态目录直出，统一走 `GET /api/meetings/:id/audio`，
  由负责人决定是否对成员开放（见下节）

### 上传录音与服务端转写

不用一边开会一边盯着浏览器识别：把手机录音或会议软件导出的录制文件传上来，
服务端转成文字，再一键生成纪要。

- 支持 mp3 / wav / m4a / aac / flac / ogg / amr / mp4，单个 ≤ 300MB
- 纯文本 txt / md 直接读原文，不花转写费用
- 上传立即返回任务，转写在后台跑，前端轮询状态（与 AI 生成同一套模式）
- 转写完可在页面上直接改文本，再点「生成纪要」走原有 AI 流程
- 文件通过**带签名的临时地址**给服务商拉取（jobId + 过期时间 + HMAC，1 小时失效），
  不暴露登录态，也不能拿 A 的链接去读 B 的文件

转写通道由 `ASR_PROVIDER` 决定：

| 值 | 行为 |
|---|---|
| `tencent` | 腾讯云录音文件识别（需 `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`） |
| `mock` | 不调外部服务，返回固定占位文本，**仅供本地调试** |
| 未设置 | 有腾讯云密钥就走 tencent，否则回落 mock（启动日志会打印实际通道） |

> mock 通道会把会议内容换成示例文本，页面上会显式提示。
> 换句话说：**没有 ASR 凭据时功能链路可跑通，但不能用于真实会议。**

### 收件箱

侧边栏「收件箱」汇总与我相关的动态，带未读数角标，分两个标签页：

- **通知**：我被加为会议负责人、被加为成员、有人把会议共享给我；
  未读高亮，支持「全部标记已读」，点击直达该会议
- **待办**：指派给我的待办（按负责人文本匹配）+ 我负责的会议里未完成的待办，
  标注「指派给我 / 我负责的会议」与处理状态，点击直达会议

通知分两类来源：

- **关系派生**：「负责人 / 成员 / 共享」三类直接由关系表推导，避免双写不一致
- **落库消息**：「会议信息变更」「会议即将开始」是一次性事件，写入 `meeting_notices`

提醒由服务端的**每分钟定时扫描**发出，`created_at` 就是消息实际发送到该账号的时间
（不是用户打开收件箱的时间）。同一会议对同一人只会有一条提醒（部分唯一索引保证）。

未读状态按条记录在 `inbox_reads`（点击即已读），另有 `users.inbox_seen_at` 支持「全部标记已读」。

### 会议负责人与成员

每场会议都有**负责人**与**成员**；负责人**可以有多个**，也可以同时是成员。

| 身份 | 权限 |
|---|---|
| 创建者（owner） | 全部权限：编辑、删除、管理成员、控制录音、共享 |
| 负责人（leader） | 编辑会议、管理成员、控制录音开关；不能删除会议。可多位，后续随时追加 |
| 成员（member） | 可读会议内容，可勾选验收要点；**不能修改待办状态**（该事项验收人或会议负责人可改）；不能改标题、不能管成员、不能控制录音 |
| 共享（只读 / 可编辑） | 沿用原有共享授权，可编辑共享等同于编辑权 |

- 创建会议时创建者自动成为首位负责人，之后可继续追加负责人
- **每场会议至少保留一位负责人**，移除最后一位会被拒绝
- 成员与负责人都能在历史列表里看到与自己相关的会议，无需额外共享
- **待办状态只能由会议负责人、该待办负责人或超级管理员修改**；
  其他成员与共享者只能看状态、勾验收要点
- 成员可勾选验收要点（清单），改待办内容、增删待办仍需编辑权限
- 删除用户时，其担任负责人的会议会先把创建者补为负责人，不会出现无负责人会议
- **超级管理员从通讯录隐藏**：普通用户选人时看不到超管账号，
  但超管本人仍保有全部权限

### 录音开放控制

负责人、创建者或超级管理员可以关闭会议录音：

- 关闭后**只有负责人、创建者与超级管理员**能收听
- 成员与共享者既看不到播放器，**也无法直接访问音频地址**（后端鉴权，不是前端隐藏）
- 音频流支持 HTTP Range，进度条可拖动跳转
- 为让 `<audio>` 能带凭证，音频接口是唯一允许通过 `?token=` 传令牌的路径（仅 GET）

### 历史会议管理

- 查看历史会议列表
- 关键词搜索**会议标题、摘要、原文、决策与待办**（命中任一即可，服务端过滤）
- 按日期范围筛选会议
- 按会议状态筛选
- 按创建时间排序
- 重置筛选条件
- **置顶 / 取消置顶**，支持同时置顶多条
- **在列表中直接修改会议状态**，无需进入详情页（只改状态，不影响内部待办）
- 查看会议详情
- 编辑会议标题
- 删除整条会议记录

### 上传转写

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/api/asr/jobs` | 上传录音/会议文件，返回转写任务（`multipart` 字段 `file`） |
| GET | `/api/asr/jobs` | 我最近的上传记录（20 条） |
| GET | `/api/asr/jobs/:id` | 任务状态与转写文本 |
| DELETE | `/api/asr/jobs/:id` | 删除任务并清理磁盘文件 |
| GET | `/api/asr/files/:id/:token` | 文件直出（**公开**，签名 1 小时有效，供服务商拉取） |

### 待办事项管理

- 查看会议待办事项
- 新增待办
- 编辑待办内容、负责人和截止时间
- 删除待办
- 修改待办状态（**该事项的验收人、会议负责人或超级管理员**；待办负责人本人与其他成员只能看）
- 支持状态：`OPEN`、`IN_PROGRESS`、`SUBMITTED`（待验收）、`COMPLETED`、`CANCELLED`
- 数据修改后持久化到 PostgreSQL

### 待办交付与验收

把「自己勾完成」升级为「提交 → 验收 → 打回」，**提交本身不算完成**。

- 待办可指定**验收人**；不指定则保持旧行为（成员一键完成）
- 负责人提交交付说明后，待办进入「待验收」，**会议状态不变** —— 待验收不属于完成，
  因此不会出现「提交后会议显示已完成、隔天被打回又退回进行中」的假状态
- 验收人通过 → 待办完成，会议按全部待办自动流转；打回 → 待办退回「进行中」，**原因必填（≥5 字）**
- 同一待办同时只允许一条待验收记录，由部分唯一索引 `todo_submissions_one_pending` 在数据库层保证
- **不能验收自己提交的交付**；验收人等于提交人时提交阶段自动通过，不制造「自己审自己」的空流程
- **「查看」页完成验收**：待办行点「查看」可看到交付说明、附件与验收要点（可就地勾选），
  通过 / 打回按钮也在该页，避免没看内容就点通过
- **提交只有该待办的负责人本人可以**（会议负责人也不能代交）；需要换人时先改派负责人
- **撤回只有提交人本人可以**（负责人也不行）；非提交人连按钮都不显示
- 负责人/管理员可代验收，但会写审计 `todo.accept_forced`
- 有验收人的待办**也可以直接勾「已完成」**：验收人勾完成等同给出结论；
  会议负责人 / 超管代完成会写审计 `todo.complete_forced`（流水里标 `forced`），
  且**不补造** `ACCEPTED` 提交记录 —— 没发生过交付，补造会污染返工次数与平均验收时长
- 状态不能直接改成 `SUBMITTED`，必须走提交接口，否则交付记录会缺失
- 每次流转写入 `todo_events`（谁、何时、从什么状态到什么状态），提交记录留在 `todo_submissions`，
  可用于统计返工次数与验收时长
- 收件箱新增「验收」标签页：**待我验收** 与 **被退回需重新提交**；待验收会计入未读角标
- **交付物附件**：单次提交最多 5 个、单文件 ≤20MB，扩展名白名单（PDF/Office/压缩包/图片）；
  下载走鉴权接口，**不做静态目录直出**；删除会议时同步清理文件，不留孤儿
- **提交内容只对相关人可见**：待办负责人、验收人、会议负责人/创建者、超管与提交人本人可看
  交付说明、附件、打回原因；其他成员只能看到「谁交的、第几次、提交时间、状态」，
  附件下载返回 403（服务端脱敏，不是前端隐藏）
- **24 小时未验收自动催办一次**（`todo_submissions.reminder_sent_at` 保证幂等，多实例也不会重复发）
- **截止时间支持自然语言**：`本周五`、`下周一`、`明天`、`3天内`、`10月30日`、`月底` 都能解析成
  UTC+8 当天 23:59:59 的时间点；解析不了（如「尽快」）只保留原文，不猜
- **逾期标记**：过了截止时间且未完成（含待验收）会在会议详情和收件箱标红；
  收件箱排序为「逾期 → 指派给我 → 截止时间近的」
- 看板新增「待验收」「逾期」计数，以及平均验收时长与返工次数：完成率只算验收通过，
  避免把「已提交」误读成「已完成」
- **验收要点（清单）**：待办可维护最多 20 条要点，验收时逐条勾选并记录勾选人与时间；
  未勾完也能通过，但接口会返回未勾数量、前端提示 —— 清单用来约束质量，不用来卡流程；
  **待验收期间禁止修改清单**，避免验收中移动球门

### 会议状态自动同步

会议完成状态与待办进度双向联动，无需手动维护：

- 待办全部处理完（`COMPLETED` 或 `CANCELLED`）→ 会议自动变为「已完成」
- 任意待办被改回 `OPEN` / `IN_PROGRESS`，或新增了待办 → 会议自动退回「进行中」
- 删除最后一项未完成待办 → 会议自动变为「已完成」
- 没有任何待办的会议保持原状态（不会因"0 项全部完成"被误判为已完成）
- 已被手动置为「已取消」的会议不参与自动流转，避免覆盖用户意图

状态同步与待办变更在同一数据库事务内完成，不会出现"待办已完成但会议仍显示进行中"的中间态。

### 历史会议置顶

- 支持同时置顶多条会议，不受"按创建时间排序"影响，置顶会议始终排在最前
- 多条置顶之间按**最近置顶优先**排列（后端记录 `pinnedAt` 时间戳而非布尔值）
- 重复点击置顶不会刷新置顶时间，顺序保持稳定
- 置顶卡片以左侧橙色色条 + 淡背景 + `已置顶` 标签区分
- 列表上方显示当前筛选结果中的置顶条数

### 首页置顶提醒

- 首页顶部用一条**紧凑提醒条**展示置顶会议，位于输入区之上，一眼能看到
- 只占一小块（约 170px 高，3 条为上限），不做成第二份会议列表
- 超过 3 条时提示「还有 N 场置顶会议」，并提供「查看全部」跳到历史页
- 每条显示标题与状态标签，点击直接进入会议详情
- 没有置顶会议时整块不显示，不占位

### 列表内联修改会议状态

- 历史会议列表的每张卡片上带状态下拉框，可直接切换「未开始 / 进行中 / 已完成 / 已取消」
- 只调用会议状态接口，**不触碰任何待办记录**，会议内部的待办内容与完成情况保持原样
- 采用乐观更新，接口失败自动回滚，不会出现界面与服务端不一致
- 若当前正按状态筛选，改完状态后卡片会按新状态即时进出筛选结果

---

## 🛠 技术栈

### Frontend

- Vue 3
- TypeScript
- Vite
- Element Plus
- Vue Router

### Backend

- NestJS
- TypeScript
- Prisma ORM
- PostgreSQL
- RESTful API

### AI

- DeepSeek API
- OpenAI SDK 兼容调用方式
- 结构化 JSON 输出

### Database / Infrastructure

- PostgreSQL
- Docker

---

## 🏗 项目架构

```text
MeetMind/
├─ frontend/                 # Vue 3 前端
│  ├─ src/
│  │  ├─ api/                # 前端 API 请求封装
│  │  ├─ components/         # 通用业务组件
│  │  ├─ composables/        # 组合式函数（计时 / 录音 / 语音识别 / 原文拼接）
│  │  ├─ router/             # Vue Router 路由配置
│  │  └─ views/              # 页面视图
│  │     ├─ HomeView.vue     # 首页 / AI 生成会议纪要
│  │     ├─ HistoryView.vue  # 历史会议管理
│  │     └─ ...
│  ├─ Dockerfile             # 前端镜像构建（含 nginx.conf）
│  ├─ package.json
│  └─ vite.config.*
│
├─ backend/                  # NestJS 后端
│  ├─ src/
│  │  ├─ ai/                 # AI 调用模块
│  │  ├─ meetings/           # 会议业务模块
│  │  ├─ prisma/             # Prisma 数据库服务
│  │  └─ app.module.ts       # 根模块
│  ├─ prisma/
│  │  └─ schema.prisma       # 数据库模型与枚举
│  ├─ Dockerfile             # 后端镜像构建
│  └─ package.json
│
├─ compose.yaml              # 单入口部署（--profile prod / db）
├─ .env.example              # 环境变量模板，复制成 .env 后填写
├─ .gitignore
└─ README.md
```

### 后端核心数据关系

```text
Meeting
  ├─ id
  ├─ title
  ├─ content
  ├─ summary
  ├─ status
  ├─ createdAt
  ├─ ownerId           # 创建者（数据归属）
  ├─ leaders[]         # 负责人（至少一位，可多位，默认创建者）
  ├─ audioUrl          # 录音相对路径，可为空
  ├─ audioDurationSec  # 录音时长（秒）
  ├─ audioOpen         # 录音是否对非负责人开放
  ├─ members[]         # 会议成员
  ├─ decisions[]
  └─ todos[]

Decision
  └─ 属于 Meeting

Todo
  ├─ content
  ├─ assignee           # 展示用的姓名文本（历史兼容）
  ├─ assigneeUserId     # 结构化负责人，归属判定以此为准
  ├─ reviewerId         # 验收人；为空表示这条待办不需要验收
  ├─ deadline           # 自然语言截止时间（如「本周五」）
  ├─ deadlineAt         # 结构化截止时间；解析不了时为空
  ├─ status             # OPEN / IN_PROGRESS / SUBMITTED / COMPLETED / CANCELLED
  ├─ submissions[]      # 每次交付（提交人、说明、打回原因、验收时间）
  └─ 属于 Meeting

TodoSubmission
  ├─ submitterId / reviewerId
  ├─ note / rejectReason
  ├─ status             # PENDING / ACCEPTED / REJECTED / WITHDRAWN
  ├─ attemptNo          # 第几次提交，用于统计返工
  └─ attachments[]
```

---

## 🚀 启动与部署

### 配置（唯一入口）

```bash
cp .env.example .env      # 填好 JWT_SECRET、DEEPSEEK_API_KEY
```

后端与 Docker 编排都读**仓库根目录的 `.env`**（后端按 `.env` → `../.env` 顺序查找），
不再需要维护多份环境变量文件。缺少 `DATABASE_URL` 或 `JWT_SECRET` 时服务启动即报错。

### 一条命令部署（Docker）

```bash
docker compose --profile prod up -d --build
```

启动顺序由编排保证：`db` → `migrate`（一次性跑完迁移并退出）→ `backend` → `frontend`。
前端 nginx 同时托管 SPA 与反向代理 `/api`，对外只暴露 `HTTP_PORT`（默认 80）。

### 本地开发

```bash
docker compose --profile db up -d     # 只起 PostgreSQL（仅监听 127.0.0.1）
cd backend && npm run start:dev       # 后端热重载
cd frontend && npm run dev            # 前端热重载（http://127.0.0.1:5173）
```

Windows 也可以直接双击根目录的 `start-backend.cmd` / `start-frontend.cmd`，
在独立命令提示符窗口中运行并查看日志。

> 基础镜像拉不动时，在 `.env` 里设置 `NODE_IMAGE` / `NGINX_IMAGE` 为国内镜像源。

## 1. 环境要求

建议准备：

- Node.js 24+（后端依赖的 NestJS 12 是纯 ESM 包，Jest 在 Node 22 上无法加载 `@nestjs/testing`）
- npm
- Docker Desktop
- PostgreSQL（项目使用 Docker 运行 PostgreSQL）
- DeepSeek API Key

---

## 2. 启动 PostgreSQL

先启动 Docker Desktop，然后启动 MeetMind 使用的 PostgreSQL 容器。

示例：

```bash
docker start meetmind-postgres
```

如果容器尚未创建，需要先创建 PostgreSQL 容器，再启动数据库。

确保 PostgreSQL 对外映射到：

```text
localhost:5432
```

---

## 3. 配置环境变量

在**仓库根目录**创建 `.env`（后端按 `.env` → `../.env` 查找，因此根目录一份即可同时供后端与 Docker 编排使用）：

```env
DATABASE_URL="postgresql://postgres:你的数据库密码@localhost:5432/meetmind?schema=public"

DEEPSEEK_API_KEY="你的 DeepSeek API Key"
DEEPSEEK_MODEL="deepseek-flash"

# JWT 签名密钥，必填，否则服务启动失败
# 生成：python -c "import secrets; print(secrets.token_urlsafe(48))"
JWT_SECRET="随机生成的强密钥"
```

> `.env` 只用于本地开发，**不要提交到 GitHub**。

### 初始账号

**全新部署时**，首次迁移会创建唯一的种子超级管理员（迁移 SQL 内固定 id=1）：

```text
手机号：13800000000
密码：kd64yyTNH62iix7G!
```

> 登录标识是**手机号**（11 位中国大陆号码），不再使用邮箱。
>
> ⚠️ **这是演示用的种子账号，手机号与密码都写在迁移与本文档里，属于公开信息。**
> 任何能看到本仓库的人都能用它登录，所以**部署到公网前必须改掉密码**：
> 登录后在「用户管理」页点自己的行 →「修改密码」。
> 手机号也需要改：由上级账号在用户管理中调整（自己不能改自己的手机号，避免误操作把自己锁在外面）。
>
> 也可以换成自己的账号做超管，步骤见下。

#### 更换超级管理员

由于超管唯一且不可通过接口转移，换人需要直接改库（先备份）：

```sql
BEGIN;
-- 1. 会议归属转给新账号（把 <new_id> 换成目标用户 id）
UPDATE meetings SET owner_id = <new_id> WHERE owner_id = 1;
-- 2. 解除旧账号的超管身份（必须先降级，否则唯一索引会挡住下一步）
UPDATE users SET role = 'ADMIN' WHERE id = 1;
-- 3. 提升新账号为超管
UPDATE users SET role = 'SUPER_ADMIN' WHERE id = <new_id>;
-- 4. 如不再需要旧账号则删除
DELETE FROM users WHERE id = 1;
COMMIT;
```

> 数据库只保存 bcrypt 哈希（cost=12）。普通账号忘记密码由管理员发一次性链接（见下），
> **超级管理员忘记密码仍然只能直接改库** —— 因为系统里没有比他更高的人能核实身份。

### 绑定邮箱与忘记密码

个人中心可绑定邮箱（唯一、可不填）。绑定后即可**全自助**找回：

```text
登录页「忘记密码？」→ /forgot-password 输入邮箱
        ↓
后端查邮箱对应账号 → 生成一次性令牌 → 发信（链接 30 分钟、只能用一次）
        ↓
点邮件里的链接 → /reset-password?token=...
        ↓
页面显示「正在为 张**（139****0082）设置」→ 本人设新密码 → 旧会话全部失效
```

**没绑定邮箱**的人仍然可以走管理员通道：管理员在「用户管理」点「重置链接」，
把链接直接发微信/企微给本人。

发信配置（不配也能跑，只是「邮件」会写进后端日志，便于本地调试）：

```env
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=你的邮箱
SMTP_PASS=授权码          # QQ/企业邮的授权码，不是登录密码
SMTP_FROM=你的邮箱
APP_PUBLIC_URL=http://你的域名或IP   # 邮件里的链接用它拼，上线不要留 localhost
```

> 未配置 SMTP 时，接口仍返回「已发送」，但响应里的 `delivered` 是 `false`，
> 前端会额外提示「本站暂未配置发信服务，请联系管理员」——宁可说清楚，也不要让用户干等邮件。

安全设计：

- 请求接口对**未绑定邮箱的地址也返回同一句话**，避免被用来枚举账号
- 同一邮箱 15 分钟内最多 3 次请求，挡住误点与脚本刷接口（进程内计数，多副本需换 Redis）
- 令牌 256 位随机，**只以 SHA-256 入库**，数据库被读走也拿不到可用链接
- 令牌一次性：密码重置成功后立即清空，重放返回「链接无效或已过期」
- 重置成功会让该账号的 **所有旧会话立即失效**（`users.token_version` 自增，守卫比对 JWT 里的 `tv`）
- 同样约束层级：管理员不能给同级或更高级账号发链接，也不能给自己发（自己走个人中心）
- 审计：`user.password_reset_request`（自助申请）/ `user.password_reset_issue`（管理员发链接）/ `user.password_reset`（重置成功）/ `user.self_update`（含 `emailChanged`）

---

## 4. 安装后端依赖

```bash
cd backend
npm install
```

---

## 5. 初始化 Prisma

```bash
npx prisma generate
```

如果数据库还没有同步，可以执行：

```bash
npx prisma migrate dev
```

如果 Prisma 提示数据库已经同步且没有待处理迁移，则无需重复迁移。

---

## 6. 启动 NestJS 后端

```bash
npm run start:dev
```

默认访问地址：

```text
http://localhost:3000
```

---

## 7. 启动 Vue 前端

打开新的终端窗口：

```bash
cd frontend
npm install
npm run dev
```

默认访问地址：

```text
http://localhost:5173
```

打开浏览器访问：

```text
http://localhost:5173/
```

即可使用 MeetMind。

---

## 🧱 接口约定

### 参数校验

所有写接口的入参结构由 DTO 定义，配合全局 `ValidationPipe` 统一校验：

- `whitelist`：DTO 未声明的字段直接丢弃
- `forbidNonWhitelisted`：出现未声明字段返回 400，避免拼错的参数被静默忽略
- `transform`：路径参数与查询参数按 DTO 类型转换

**业务规则**（手机号格式、密码强度、负责人至少一位等）仍留在 Service 层，
以便返回中文提示；DTO 只负责"结构对不对"。

### 列表分页与按需明细

`GET /api/meetings` 已改为**分页 + 服务端筛选**，并只返回列表摘要：

| 参数 | 说明 |
|---|---|
| `page` / `pageSize` | 分页，`pageSize` 上限 100 |
| `keyword` | 全文检索：标题、摘要、原文、决策、待办（命中任一即返回） |
| `status` | 按完成状态筛选 |
| `from` / `to` | 按创建日期范围（`YYYY-MM-DD`，含当天） |
| `pinned=true` | 只取置顶会议（首页用） |
| `upcoming=true` | 只取未开始的预约会议（首页用） |

返回 `{ items, total, page, pageSize, hasMore }`。

**列表项不再包含 `decisions` / `todos` 明细**，只给 `todoCount` / `decisionCount`；
明细由详情接口 `GET /api/meetings/:id` 提供。历史页在展开卡片时才拉取详情，
避免"打开列表就把所有会议的决策与待办全部读出来"。

默认列表**不含未开始的预约会议**（它们属于日程，由首页展示）。

历史页的**关键词、状态、日期、排序全部走服务端**：筛选条件变化就重新查询，
因此「第 2 页的第 3 条」这类结果不会因为只过滤当前页而缺失；
列表底部提供「加载更多」按需追加。

### 删除账号不删除会议

`meetings.owner_id` 的外键已从 `ON DELETE CASCADE` 改为 `ON DELETE RESTRICT`：

- 数据库层面禁止"直接删掉仍有会议的用户"
- 应用层在删除用户前，先把其名下的会议**转移给操作者**
- 删除接口会返回 `reassignedMeetings`，明确告知转移了多少场会议

> 之前删掉一个测试账号，会把该账号创建的全部会议（含决策、待办、录音）一起静默删除。
> 现在改为转移，属于数据安全修复。

### 审计日志

敏感操作会写入 `audit_logs`，由 `GET /api/audit-logs` 提供查询（需要 `audit:read`）。

已接入的动作：

| 分类 | 动作 |
|---|---|
| 认证 | `auth.login` |
| 账号 | `user.create` / `user.update` / `user.self_update` / `user.delete` / `user.impersonate` / `user.password_reset_issue` / `user.password_reset` |
| 会议 | `meeting.delete` |
| 共享 | `meeting.share` / `meeting.share_revoke` |

设计要点：

- `actor_id` 使用 `ON DELETE SET NULL` —— 账号删除后「谁做的」这条记录仍然保留
- 代登场景额外记录 `impersonated_by`，能区分「超管以某人身份操作」
- 写入失败只记日志，不影响主流程
- 前端入口在**个人中心**（仅 `audit:read` 可见），页面为只读表格 + 操作/资源筛选 + 翻页

### 统一错误响应

```json
{
  "code": "VALIDATION_FAILED",
  "message": "property extraField should not exist",
  "statusCode": 400,
  "path": "/api/meetings/scheduled",
  "requestId": "9f1c...",
  "timestamp": "2026-10-20T14:23:30.325Z"
}
```

- `message` 保持原有中文业务提示，前端现有代码无需改动
- `code` 供程序判断（`VALIDATION_FAILED` / `NOT_FOUND` / `FORBIDDEN` / `INTERNAL_ERROR` 等）
- 每个响应都带 `X-Request-Id` 头，日志与错误体用同一个 ID 关联

后端日志统一使用 Nest `Logger`（按级别输出），已移除 `console.log`。

---
## 🔌 主要 API

> 除 `/api`（健康检查）、`/api/auth/login`、`/api/auth/register` 外，
> **所有接口都需要 `Authorization: Bearer <token>`**。

### 认证

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 手机号 + 密码登录，返回 JWT 与权限位（公开） |
| POST | `/api/auth/register` | 手机号自助注册，固定为 USER 角色（公开） |
| GET | `/api/auth/me` | 当前登录用户信息与权限 |
| PATCH | `/api/auth/me` | 修改自己的姓名 / 密码 / 头像（个人中心，仅需登录） |
| POST | `/api/auth/password-reset/request` | 自助找回：给绑定邮箱发一次性链接（公开） |
| POST | `/api/auth/password-reset/inspect` | 校验一次性重置链接（公开） |
| POST | `/api/auth/password-reset/confirm` | 用一次性链接设置新密码（公开） |

登录标识为**手机号**（11 位中国大陆号码），不接受邮箱。
后端会先归一化再校验：自动去掉空格、短横线、括号与 `+86` 前缀，
所以 `+86 138-0013-8000` 与 `13800138000` 视为同一个账号。

`PATCH /api/auth/me` 与管理用户的 `PATCH /api/users/:id` 的区别：

- 只允许改**姓名**与**密码**，不能改手机号、角色、启停状态
- 改密码必须同时提供原密码
- 不要求 `user:manage` 权限 —— 普通用户也需要能维护自己的账号

### 用户管理（管理员及以上）

| Method | Endpoint | 说明 |
|---|---|---|
| GET | `/api/users` | 用户列表（管理员看不到超管） |
| POST | `/api/users` | 新建账号，不能创建高于自己的角色 |
| PATCH | `/api/users/:id` | 改资料 / 角色 / 启用状态 |
| DELETE | `/api/users/:id` | 删除账号 |
| POST | `/api/users/:id/impersonate` | 切换身份：以该账号 token 返回（仅超级管理员） |
| POST | `/api/users/:id/password-reset` | 生成一次性密码重置链接（返回明文令牌，仅此一次） |
| GET | `/api/users/contacts` | 通讯录（只含姓名 + 手机号，任何登录用户可调用，用于选负责人/成员） |

### 上传录音与服务端转写

不用一边开会一边盯着浏览器识别：把手机录音或会议软件导出的录制文件传上来，
服务端转成文字，再一键生成纪要。

- 支持 mp3 / wav / m4a / aac / flac / ogg / amr / mp4，单个 ≤ 300MB
- 纯文本 txt / md 直接读原文，不花转写费用
- 上传立即返回任务，转写在后台跑，前端轮询状态（与 AI 生成同一套模式）
- 转写完可在页面上直接改文本，再点「生成纪要」走原有 AI 流程
- 文件通过**带签名的临时地址**给服务商拉取（jobId + 过期时间 + HMAC，1 小时失效），
  不暴露登录态，也不能拿 A 的链接去读 B 的文件

转写通道由 `ASR_PROVIDER` 决定：

| 值 | 行为 |
|---|---|
| `tencent` | 腾讯云录音文件识别（需 `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`） |
| `mock` | 不调外部服务，返回固定占位文本，**仅供本地调试** |
| 未设置 | 有腾讯云密钥就走 tencent，否则回落 mock（启动日志会打印实际通道） |

> mock 通道会把会议内容换成示例文本，页面上会显式提示。
> 换句话说：**没有 ASR 凭据时功能链路可跑通，但不能用于真实会议。**

### 收件箱

| Method | Endpoint | 说明 |
|---|---|---|
| GET | `/api/inbox` | 通知 + 待办提醒 + 未读数 |
| GET | `/api/inbox/unread-count` | 只取未读数（侧边栏角标） |
| POST | `/api/inbox/read` | 通知全部标记已读 |

### 会议负责人与成员

| Method | Endpoint | 说明 |
|---|---|---|
| GET | `/api/meetings/:id/leaders` | 负责人列表 |
| POST | `/api/meetings/:id/leaders` | 追加负责人 `{userId}`（可多位，幂等） |
| DELETE | `/api/meetings/:id/leaders/:userId` | 移除负责人（至少保留一位） |
| GET | `/api/meetings/:id/members` | 成员列表 |
| POST | `/api/meetings/:id/members` | 添加成员 `{userId}`（可重复调用，幂等） |
| DELETE | `/api/meetings/:id/members/:userId` | 移除成员 |

### 会议共享

| Method | Endpoint | 说明 |
|---|---|---|
| GET | `/api/meetings/:id/shares` | 共享名单（仅归属者 / 管理员） |
| POST | `/api/meetings/:id/shares` | 共享给某人 `{userId, permission}` |
| PATCH | `/api/meetings/:id/shares/:userId` | 修改共享权限 |
| DELETE | `/api/meetings/:id/shares/:userId` | 撤销共享 |

### 会议

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/api/meetings` | 创建会议 / 生成 AI 纪要 |
| GET | `/api/meetings` | 获取历史会议（按数据隔离过滤） |
| GET | `/api/meetings/:id` | 获取会议详情 |
| GET | `/api/meetings/:id/export` | 导出 Markdown 纪要（返回 `{ filename, content }`，前端造 Blob 下载） |
| PATCH | `/api/meetings/:id` | 编辑会议标题 |
| PATCH | `/api/meetings/:id/pin` | 置顶 / 取消置顶（`{"pinned": true}`） |
| PATCH | `/api/meetings/:id/completion-status` | 修改会议完成状态 |
| DELETE | `/api/meetings/:id` | 删除会议（仅归属者 / 管理员） |

### 上传转写

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/api/asr/jobs` | 上传录音/会议文件，返回转写任务（`multipart` 字段 `file`） |
| GET | `/api/asr/jobs` | 我最近的上传记录（20 条） |
| GET | `/api/asr/jobs/:id` | 任务状态与转写文本 |
| DELETE | `/api/asr/jobs/:id` | 删除任务并清理磁盘文件 |
| GET | `/api/asr/files/:id/:token` | 文件直出（**公开**，签名 1 小时有效，供服务商拉取） |

### 待办事项

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/api/meetings/:id/todos` | 新增待办 |
| PATCH | `/api/meetings/todos/:id` | 编辑待办 |
| PATCH | `/api/meetings/todos/:id/status` | 修改待办状态（该事项验收人 / 会议负责人 / 超管；其余 403） |
| DELETE | `/api/meetings/todos/:id` | 删除待办 |

### 待办交付与验收

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/api/meetings/todos/:id/submissions` | 提交交付 `{note}`；有验收人时进入待验收，否则直接完成 |
| GET | `/api/meetings/todos/:id/submissions` | 提交时间线（含打回原因与附件元信息） |
| GET | `/api/meetings/todos/:id/events` | 流转流水（created / submitted / rejected / accepted / status_changed …） |
| PUT | `/api/meetings/todos/:id/checklist` | 覆盖式设置验收要点 `{items: string[]}`（最多 20 条，待验收期间 409） |
| PATCH | `/api/meetings/todos/:id/checklist/:itemId` | 勾选 / 取消一条要点 `{done}` |
| POST | `/api/meetings/submissions/:id/accept` | 验收通过（提交人不能验自己） |
| POST | `/api/meetings/submissions/:id/reject` | 打回，`{reason}` 必填且 ≥5 字 |
| POST | `/api/meetings/submissions/:id/withdraw` | 撤回提交（仅提交人本人，且仅待验收状态） |
| POST | `/api/meetings/submissions/:id/attachments` | 上传交付物（multipart 字段 `file`，单文件 ≤20MB） |
| GET | `/api/meetings/todos/:id/submissions/:sid/attachments/:aid` | 鉴权下载交付物（`Content-Disposition: attachment`） |

`PATCH /api/meetings/todos/:id` 新增 `assigneeUserId`、`reviewerId`、`deadlineAt` 三个字段；
指定验收人时会自动把该用户加入会议成员，否则他点开待办只会拿到 404。

### 会议录音

| Method | Endpoint | 说明 |
|---|---|---|---|
| POST | `/api/meetings/:id/audio` | 上传会议录音（multipart 字段 `audio`，可选 `durationSec`） |
| GET | `/api/meetings/:id/audio` | 收听录音（鉴权，支持 HTTP Range 与 `?token=`） |
| PATCH | `/api/meetings/:id/audio-open` | 控制录音是否对非负责人开放 |

> ⚠️ **行为变更**：录音不再通过静态目录 `/uploads/:filename` 直接访问。
> 静态暴露会让「录音不开放」形同虚设 —— 知道文件名即可绕过权限。
> 若有旧的前端或外部系统在使用 `/uploads/...`，需要改为调用鉴权接口。

录音文件不提交 Git（已在 `backend/.gitignore` 中忽略 `uploads/`），删除会议时会同步清理对应音频文件。

---

## 🔄 AI 生成改为异步任务

生成不再是同步长请求，而是「建任务 → 后台执行 → 前端轮询」：

```text
POST /api/ai/generate          立即返回 { id, status: PENDING }
        ↓
后台生成（进程内执行，不阻塞响应）
        ↓
GET /api/ai/generations/:id    轮询状态
        ↓
SUCCEEDED（带 meetingId）/ FAILED（带 error）
```

- **重复提交自动复用**：同一用户 + 同一段内容 + 正在运行的任务，直接返回原任务，不会重复烧额度
- **失败可追踪**：任务表保留 `error`，前端能显示具体原因
- **重启自愈**：服务启动时把残留的 `PENDING/RUNNING` 任务标记为失败，对应会议置为 FAILED
- 前端 `generateMeeting()` 内部完成启动与轮询，调用方签名不变

> 单实例假设：进程内执行 + 启动清理；多副本部署需要改成独立 Worker 或队列。

## 🔄 AI 处理流程

```text
用户输入会议内容
        ↓
Vue 3 前端提交请求
        ↓
NestJS Controller
        ↓
Meeting Service
        ↓
AI Service
        ↓
DeepSeek API
        ↓
生成结构化 JSON
        ↓
解析 summary / decisions / todos
        ↓
Prisma 写入 PostgreSQL
        ↓
返回结构化会议结果
        ↓
Vue 页面展示
```

AI 输出主要包含：

```json
{
  "summary": "会议内容总结",
  "decisions": [
    "第一版产品支持邮箱登录"
  ],
  "todos": [
    {
      "content": "完成首页 UI 设计",
      "assignee": "张三",
      "deadline": "本周五"
    }
  ]
}
```

---

## 💡 技术亮点

### 1. LLM + 业务数据结构化

不是简单调用大模型返回一段文本，而是要求 AI 按固定 JSON 结构输出，将自然语言会议内容转换成：

- `summary`：摘要
- `decisions`：决策
- `todos`：待办

随后由后端进行解析并持久化，形成从**非结构化文本 → AI 分析 → 结构化业务数据 → 数据库**的完整链路。

### 2. 前后端职责分离

Vue 3 负责页面交互和数据展示，NestJS 负责业务逻辑、接口和 AI 调用，Prisma 负责数据库访问，使前后端模块边界更加清晰。

### 3. Prisma + PostgreSQL 数据建模

通过 Prisma 建立 `Meeting`、`Decision`、`Todo` 等业务模型，并利用关系模型保存会议与决策、待办之间的关联关系。

### 4. 完整 CRUD 业务闭环

项目不仅实现 AI 生成，还补充了实际业务系统常见的数据管理能力：

- 会议新增
- 会议查询
- 会议标题编辑
- 会议删除
- 待办新增
- 待办编辑
- 待办删除
- 待办状态修改

### 5. 历史会议多条件筛选

前端对历史会议支持：

- 关键词搜索
- 日期范围筛选
- 状态筛选
- 创建时间排序
- 条件重置

可以组合使用多个筛选条件。

### 6. AI 服务与业务服务解耦

将 DeepSeek 调用封装在独立 AI Service 中，由会议业务模块负责调用和结果落库，后续可以替换不同模型或扩展 Prompt，而不需要大范围修改页面逻辑。

### 7. 敏感配置隔离

DeepSeek API Key 和数据库连接信息通过 `.env` 管理，并通过 `.gitignore` 排除敏感配置，避免将密钥直接提交到 GitHub。

---

## 📌 项目当前能力

当前版本已经形成完整 MVP：

```text
Vue 3 前端
   ↓
REST API
   ↓
NestJS 后端
   ↓
DeepSeek AI
   ↓
Prisma
   ↓
PostgreSQL
```

用户可以从**输入会议内容 → AI 自动生成纪要 → 保存数据库 → 查看历史会议 → 管理待办**完成完整业务闭环。

---

## 📄 简历项目描述

**MeetMind｜AI 智能会议纪要系统**

技术栈：Vue 3、TypeScript、Element Plus、NestJS、Prisma、PostgreSQL、DeepSeek API

- 基于 Vue 3 + TypeScript 开发 AI 会议纪要前端，实现会议创建、结果展示及历史会议管理。
- 基于 NestJS + Prisma + PostgreSQL 构建后端，实现会议、决策及待办事项的数据持久化与 CRUD。
- 接入 DeepSeek 大语言模型，将会议文本自动提炼为摘要、决策和待办，并通过结构化 JSON 与业务数据模型完成落库。
- 实现待办事项新增、编辑、删除及状态流转，以及会议标题修改和整条会议删除。
- 实现历史会议关键词搜索、日期筛选、状态筛选和创建时间排序，形成完整的会议管理闭环。
