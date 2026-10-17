# MeetMind

> 基于 Vue 3 + NestJS + Prisma + PostgreSQL + DeepSeek API 的 AI 智能会议纪要系统

MeetMind 是一个面向会议内容整理场景的全栈 AI 应用。用户输入会议内容后，系统调用 DeepSeek 大语言模型，将会议内容自动整理为**会议摘要、关键决策和待办事项**，并将结构化结果保存到 PostgreSQL 数据库中，支持后续历史会议管理与待办事项维护。

## ✨ 核心功能

### 登录与权限分级

采用 JWT 认证 + 三级 RBAC + 资源级共享授权两层模型。

| 能力 | 用户 USER | 管理员 ADMIN | 超级管理员 SUPER_ADMIN |
|---|:---:|:---:|:---:|
| 会议读写 | 仅自己的 | 全部 | 全部 |
| 共享自己的会议 | ✅ | ✅ | ✅ |
| 删除任意会议 | ❌ | ✅ | ✅ |
| 查看用户列表 | ❌ | ✅ | ✅ |
| 创建/停用普通用户 | ❌ | ✅ | ✅ |
| 管理管理员账号 | ❌ | ❌ | ✅ |
| 提升他人为超管 | ❌ | ❌ | ❌ |
| 修改自己的姓名/密码 | ✅ | ✅ | ✅ |

> **超级管理员全局唯一**：该角色不可新建、不可提升、不可降级、不可停用、不可删除。
> 应用层（`UsersService`）与数据库层（部分唯一索引 `users_single_super_admin_key`）双重保证，
> 即使直接连库改数据也无法出现第二个超管。
> 代价：超管角色无法通过接口转移，需要换人时只能直接改库（有意为之的取舍）。

- **数据隔离**：每场会议有唯一归属者，普通用户只能看到自己的与被共享给自己的会议
- **共享授权**：会议拥有者可把会议共享给其他人，并选择「只读」或「可编辑」
- **权限即时生效**：守卫每次请求都回库校验用户状态，停用账号或降级角色后旧 token 立刻失效
- **防越权设计**：无权访问返回 404 而非 403，避免通过状态码差异探测会议是否存在；管理员看不到也管不到超管账号

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

### 历史会议管理

- 查看历史会议列表
- 关键词搜索会议标题
- 按日期范围筛选会议
- 按会议状态筛选
- 按创建时间排序
- 重置筛选条件
- **置顶 / 取消置顶**，支持同时置顶多条
- **在列表中直接修改会议状态**，无需进入详情页（只改状态，不影响内部待办）
- 查看会议详情
- 编辑会议标题
- 删除整条会议记录

### 待办事项管理

- 查看会议待办事项
- 新增待办
- 编辑待办内容、负责人和截止时间
- 删除待办
- 修改待办状态
- 支持状态：`OPEN`、`IN_PROGRESS`、`COMPLETED`、`CANCELLED`
- 数据修改后持久化到 PostgreSQL

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
│  │  ├─ router/             # Vue Router 路由配置
│  │  └─ views/              # 页面视图
│  │     ├─ HomeView.vue     # 首页 / AI 生成会议纪要
│  │     ├─ HistoryView.vue  # 历史会议管理
│  │     └─ ...
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
│  ├─ .env                   # 本地环境变量，不提交 Git
│  └─ package.json
│
├─ ai-service/               # Python AI 服务目录（扩展预留）
│
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
  ├─ audioUrl          # 录音相对路径，可为空
  ├─ audioDurationSec  # 录音时长（秒）
  ├─ decisions[]
  └─ todos[]

Decision
  └─ 属于 Meeting

Todo
  ├─ content
  ├─ assignee
  ├─ deadline
  ├─ status
  └─ 属于 Meeting
```

---

## 🚀 本地启动

### 快捷方式（Windows）

项目根目录提供两个启动脚本，**双击即可在独立的命令提示符窗口中运行**，
窗口里能直接看到日志，按 `Ctrl+C` 或关闭窗口即停止服务：

| 脚本 | 作用 | 地址 |
|---|---|---|
| `start-backend.cmd` | 启动 NestJS 后端 | http://127.0.0.1:3000/api |
| `start-frontend.cmd` | 启动前端开发服务器 | http://127.0.0.1:5173/ |

> 脚本用 `%~dp0` 定位项目目录，可放在任意路径；
> 内部保持纯 ASCII，避免中文代码页导致 cmd 解析异常。

### 手动启动

以下为分步说明。

## 1. 环境要求

建议准备：

- Node.js 18+
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

## 3. 配置后端环境变量

进入后端目录：

```bash
cd backend
```

创建 `.env` 文件：

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
邮箱：admin@meetmind.local
密码：kd64yyTNH62iix7G!
```

> ⚠️ **这是演示用的种子账号，密码写在迁移与本文档里，属于公开信息。**
> 任何能看到本仓库的人都能用它登录，所以**部署到公网前必须改掉密码**：
> 登录后在「用户管理」页点自己的行 →「修改密码」。
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

> 数据库只保存 bcrypt 哈希（cost=12），忘记密码需直接改库。

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

## 🔌 主要 API

> 除 `/api`（健康检查）、`/api/auth/login`、`/api/auth/register` 外，
> **所有接口都需要 `Authorization: Bearer <token>`**。

### 认证

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 登录，返回 JWT 与权限位（公开） |
| POST | `/api/auth/register` | 自助注册，固定为 USER 角色（公开） |
| GET | `/api/auth/me` | 当前登录用户信息与权限 |

### 用户管理（管理员及以上）

| Method | Endpoint | 说明 |
|---|---|---|
| GET | `/api/users` | 用户列表（管理员看不到超管） |
| POST | `/api/users` | 新建账号，不能创建高于自己的角色 |
| PATCH | `/api/users/:id` | 改资料 / 角色 / 启用状态 |
| DELETE | `/api/users/:id` | 删除账号 |

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
| PATCH | `/api/meetings/:id` | 编辑会议标题 |
| PATCH | `/api/meetings/:id/pin` | 置顶 / 取消置顶（`{"pinned": true}`） |
| PATCH | `/api/meetings/:id/completion-status` | 修改会议完成状态 |
| DELETE | `/api/meetings/:id` | 删除会议（仅归属者 / 管理员） |

### 待办事项

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/api/meetings/:id/todos` | 新增待办 |
| PATCH | `/api/meetings/todos/:id` | 编辑待办 |
| PATCH | `/api/meetings/todos/:id/status` | 修改待办状态 |
| DELETE | `/api/meetings/todos/:id` | 删除待办 |

### 会议录音

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/api/meetings/:id/audio` | 上传会议录音（multipart 字段 `audio`，可选 `durationSec`） |
| GET | `/uploads/:filename` | 播放录音；支持 HTTP Range，可拖动进度条跳转 |

录音文件不提交 Git（已在 `backend/.gitignore` 中忽略 `uploads/`），删除会议时会同步清理对应音频文件。

---

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
