# MeetMind AI 服务

此 FastAPI 服务通过 OpenAI 兼容的 Chat Completions API 生成会议摘要、决策和待办。生成结果随后由前端保存到 NestJS 数据服务和 PostgreSQL。

## 本地运行

在 `ai-service` 目录执行：

```powershell
py -3.14 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
Copy-Item .env.example .env
# 在 .env 中填写 OPENAI_API_KEY，并按服务商调整 BASE_URL 和 MODEL
.venv\Scripts\python -m uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8000 --reload
```

服务地址为 `http://127.0.0.1:8000`，健康检查为 `/health`，交互式接口文档为 `/docs`。没有配置密钥时服务仍可启动和健康检查，但纪要生成接口会返回 503。

## 配置说明

- `OPENAI_API_KEY`：模型服务密钥；仅放在本地 `.env`，不要提交到代码仓库。
- `OPENAI_BASE_URL`：兼容 Chat Completions 的 API 根地址，默认为 OpenAI `/v1` 地址。
- `OPENAI_MODEL`：服务商支持的模型名称。
- `CORS_ORIGINS`：允许访问服务的前端来源，多个地址以逗号分隔。

生成接口：`POST /api/meetings/generate`，请求体为 `{"content":"会议原文"}`。
