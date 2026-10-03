# MeetMind

> 基于 Vue 3 + NestJS + Prisma + PostgreSQL + DeepSeek API 的 AI 智能会议纪要系统

MeetMind 是一个面向会议内容整理场景的全栈 AI 应用。用户输入会议内容后，系统调用 DeepSeek 大语言模型，将会议内容自动整理为**会议摘要、关键决策和待办事项**，并将结构化结果保存到 PostgreSQL 数据库中，支持后续历史会议管理与待办事项维护。

## ✨ 核心功能

### AI 会议纪要生成

- 输入会议原始内容
- 调用 DeepSeek API 进行内容分析
- 自动生成会议摘要
- 自动提取会议决策
- 自动提取待办事项
- 将 AI 输出转换为结构化 JSON 数据
- 生成结果保存到数据库

### 历史会议管理

- 查看历史会议列表
- 关键词搜索会议标题
- 按日期范围筛选会议
- 按会议状态筛选
- 按创建时间排序
- 重置筛选条件
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
```

> `.env` 只用于本地开发，**不要提交到 GitHub**。

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

### 会议

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/api/meetings` | 创建会议 / 生成 AI 纪要 |
| GET | `/api/meetings` | 获取历史会议 |
| GET | `/api/meetings/:id` | 获取会议详情 |
| PATCH | `/api/meetings/:id` | 编辑会议标题 |
| DELETE | `/api/meetings/:id` | 删除会议 |

### 待办事项

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/api/meetings/:id/todos` | 新增待办 |
| PATCH | `/api/meetings/todos/:id` | 编辑待办 |
| PATCH | `/api/meetings/todos/:id/status` | 修改待办状态 |
| DELETE | `/api/meetings/todos/:id` | 删除待办 |

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
