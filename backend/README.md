# MeetMind 数据服务

该 NestJS 服务负责会议记录的持久化与历史查询；FastAPI 继续提供 AI 纪要生成接口。数据库使用 PostgreSQL，Prisma 管理数据模型和迁移。

## 本地启动

在 `backend` 目录执行：

```powershell
Copy-Item .env.example .env
# 先启动 Docker Desktop，再执行下面两条 Docker 命令
docker compose up -d postgres
npm install
npm run db:generate
npm run db:deploy
npm run start:dev
```

服务默认监听 `http://localhost:3000`。`DATABASE_URL` 配置在 `.env` 中；请将示例凭据替换为适合当前环境的值。日后已有迁移时，部署环境使用 `npm run db:deploy`。

修改 Prisma 数据模型后，在开发环境使用 `npm run db:migrate -- --name <迁移名称>` 创建并应用迁移。

前端在 `frontend/.env.example` 中分别配置 AI 服务和本数据服务地址。默认 AI 地址为 `http://127.0.0.1:8000/api`，数据服务地址为 `http://127.0.0.1:3000/api`。

## 数据模型

- `Meeting`：原始会议文本、标题、纪要、状态和创建时间。
- `Decision`：会议关键决策，按 `sortOrder` 排序。
- `Todo`：行动项、负责人、自然语言截止时间及处理状态。

会议删除时，关联的决策与待办事项会由外键级联删除。截止时间保留为可空字符串，以兼容模型提取出的自然语言时间描述。

## API

- `POST /api/meetings`：保存 AI 生成结果，提交 `content`、`summary`、`decisions` 和 `todos`。
- `GET /api/meetings`：按创建时间倒序获取历史记录。
- `GET /api/meetings/:id`：获取会议详情。
- `DELETE /api/meetings/:id`：删除会议及其决策、待办项。

`POST /api/meetings/generate` 仍由 FastAPI 提供。前端先调用 FastAPI 生成纪要，再调用 NestJS 保存结果。
