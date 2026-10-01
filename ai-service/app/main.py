"""MeetMind 的 OpenAI 兼容会议纪要生成接口。"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError

# 支持从 ai-service/.env 加载本地配置；部署环境也可直接注入环境变量。
load_dotenv()

APP_TITLE = "MeetMind AI Service"
DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_BASE_URL = "https://api.openai.com/v1"


class GenerateMeetingRequest(BaseModel):
    """纪要生成请求，接收前端填写的会议原文。"""

    content: str = Field(min_length=1, max_length=10_000)


class TodoItem(BaseModel):
    """结构化行动项；模型未识别出的负责人或截止时间返回 null。"""

    content: str
    assignee: str | None = None
    deadline: str | None = None


class GenerateMeetingResponse(BaseModel):
    """生成结果字段与 Vue 页面及 NestJS 持久化接口保持一致。"""

    summary: str
    decisions: list[str] = Field(default_factory=list)
    todos: list[TodoItem] = Field(default_factory=list)


# 前端开发服务器地址可通过 CORS_ORIGINS 增减。
allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://127.0.0.1:5173,http://localhost:5173",
    ).split(",")
    if origin.strip()
]

app = FastAPI(title=APP_TITLE, version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def parse_model_result(raw_content: str) -> GenerateMeetingResponse:
    """去除可选 Markdown 代码围栏，并校验模型返回的 JSON 结构。"""

    content = raw_content.strip()
    if content.startswith("```"):
        # 有些模型会把 JSON 包在 ```json ... ``` 代码块中。
        content = content.split("\n", 1)[-1]
        if content.rstrip().endswith("```"):
            content = content.rstrip()[:-3].strip()

    try:
        parsed: Any = json.loads(content)
        return GenerateMeetingResponse.model_validate(parsed)
    except (json.JSONDecodeError, ValidationError, TypeError) as exc:
        raise ValueError("模型返回内容不是有效的会议纪要 JSON") from exc


@app.get("/health")
async def health_check() -> dict[str, str | bool]:
    """健康检查不访问模型，可用于确认 FastAPI 进程正常运行。"""

    return {
        "status": "ok",
        "model_configured": bool(os.getenv("OPENAI_API_KEY", "").strip()),
        "model": os.getenv("OPENAI_MODEL", DEFAULT_MODEL),
    }


@app.post("/api/meetings/generate", response_model=GenerateMeetingResponse)
async def generate_meeting(
    request: GenerateMeetingRequest,
) -> GenerateMeetingResponse:
    """调用 OpenAI 兼容的 Chat Completions 接口并解析结构化纪要。"""

    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="未配置 OPENAI_API_KEY，请在 ai-service/.env 中添加模型 API 密钥",
        )

    base_url = os.getenv("OPENAI_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    model = os.getenv("OPENAI_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
    system_prompt = """
你是会议纪要助手。请阅读用户提供的会议原文，只返回一个 JSON 对象，不要添加 Markdown 代码围栏或额外说明。
JSON 格式必须为：
{
  "summary": "简明概括会议主题、讨论结论和背景",
  "decisions": ["已确认的决策"],
  "todos": [
    {"content": "待办任务", "assignee": "负责人或 null", "deadline": "截止时间原文或 null"}
  ]
}
没有明确决策或待办时返回空数组；不要把建议误写为已确认决策；不要猜测负责人和截止时间。
""".strip()

    # 通过标准 Chat Completions 路径发送请求，兼容支持该协议的模型服务商。
    endpoint = f"{base_url}/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}"}
    body = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": request.content.strip()},
        ],
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(endpoint, headers=headers, json=body)
            response.raise_for_status()
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="模型服务响应超时") from exc
    except httpx.HTTPStatusError as exc:
        # 只返回上游状态码，不透传可能包含请求信息的响应正文。
        raise HTTPException(
            status_code=502,
            detail=f"模型服务请求失败（HTTP {exc.response.status_code}）",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail="无法连接模型服务") from exc

    try:
        completion = response.json()
        raw_content = completion["choices"][0]["message"]["content"]
        if not isinstance(raw_content, str):
            raise ValueError("模型没有返回文本内容")
        return parse_model_result(raw_content)
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise HTTPException(
            status_code=502,
            detail="模型返回格式无效，请检查模型兼容性或提示词配置",
        ) from exc
