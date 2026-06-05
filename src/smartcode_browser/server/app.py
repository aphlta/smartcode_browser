"""FastAPI 应用：把 CodeEngine 暴露成一组语言无关的 JSON 接口，并托管前端。

接口设计刻意保持最小且无状态——级联导航的「树状态」全部放在前端，
后端只回答三类问题：有哪些项目 / 搜什么符号 / 打开某个符号是什么内容。
这样后端可水平扩展，前端布局逻辑也不受后端约束。
"""

from __future__ import annotations

from pathlib import Path

import asyncio

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ..engine import CodeEngine
from .llm import chat_analyze, llm_configured, llm_settings

_STATIC_DIR = Path(__file__).resolve().parent / "static"


class AiChatRequest(BaseModel):
    project: str
    file: str
    function_name: str
    start_line: int
    end_line: int = 0
    signature: str = ""
    source: str = Field(..., max_length=120_000)
    selected_text: str = Field("", max_length=32_000)
    question: str = Field(..., min_length=1, max_length=16_000)
    history: list[dict[str, str]] = Field(default_factory=list)
    chat_id: str = ""


def create_app(engine: CodeEngine | None = None) -> FastAPI:
    """构造 FastAPI 应用。engine 可注入，便于测试。"""
    engine = engine or CodeEngine()
    app = FastAPI(title="SmartCode 代码浏览器", version="0.1.0")

    @app.get("/api/projects")
    def list_projects() -> list[dict]:
        """列出所有可浏览项目（供顶部下拉框）。"""
        return engine.list_projects()

    @app.get("/api/stats")
    def stats(project: str = Query(...)) -> dict:
        """返回项目索引统计（会触发惰性索引构建，首次可能较慢）。"""
        try:
            return engine.project_stats(project)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/search")
    def search(
        project: str = Query(...),
        q: str = Query(..., min_length=1),
        limit: int = Query(40, ge=1, le=200),
    ) -> list[dict]:
        """按名称模糊搜索符号；支持 ``in:<路径> <名>`` 限定文件范围。"""
        try:
            return engine.search(project, q, limit)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/symbol")
    def open_symbol(
        project: str = Query(...),
        file: str = Query(...),
        name: str | None = Query(None),
        line: int | None = Query(None),
    ) -> JSONResponse:
        """打开一个符号，返回 Panel 所需的源码与可点击引用。"""
        try:
            detail = engine.open_symbol(project, file, name=name, line=line)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if detail is None:
            raise HTTPException(status_code=404, detail="未找到符号或源码不可读")
        return JSONResponse(detail.to_dict())

    @app.get("/api/resolve")
    def resolve(
        project: str = Query(...),
        name: str = Query(...),
        from_file: str = Query(""),
    ) -> list[dict]:
        """把一个引用名解析为候选定义（同文件优先）。"""
        try:
            return engine.resolve(project, name, from_file)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/resolve_call")
    def resolve_call(
        project: str = Query(...),
        file: str = Query(...),
        name: str = Query(...),
        line: int = Query(..., ge=1),
        col: int = Query(0, ge=0),
        receiver: str = Query(""),
    ) -> list[dict]:
        """解析成员/函数指针调用，列出表初始化中的全部目标函数。"""
        try:
            return engine.resolve_call(project, file, line, col, name, receiver)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/resolve_at")
    def resolve_at(
        project: str = Query(...),
        file: str = Query(...),
        name: str = Query(...),
        line: int = Query(...),
        col: int = Query(0),
    ) -> list[dict]:
        """解析某文件某行的标识符（变量）：局部声明优先，再合并全局候选。"""
        try:
            return engine.resolve_at(project, file, name, line, col)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/usages")
    def usages(
        project: str = Query(...),
        name: str = Query(...),
        limit: int = Query(200, ge=1, le=1000),
    ) -> list[dict]:
        """查找标识符的所有使用位置（按所属函数聚合）。"""
        try:
            return engine.find_usages(project, name, limit)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/ai/config")
    def ai_config() -> dict:
        """前端用于判断是否展示 AI 功能及当前模型名。"""
        s = llm_settings()
        return {"configured": s["configured"], "backend": s["backend"], "model": s["model"]}

    @app.post("/api/ai/chat")
    async def ai_chat(req: AiChatRequest) -> JSONResponse:
        """对当前函数/选中代码发起 LLM 分析。"""
        if not llm_configured():
            raise HTTPException(
                status_code=503,
                detail="未配置 cursor-agent，请先安装并 login（cursor-agent login）",
            )
        try:
            project = engine.registry.get(req.project)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        try:
            text, chat_id = await asyncio.to_thread(
                chat_analyze, req.model_dump(), Path(project.root)
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return JSONResponse(
            {
                "reply": text,
                "chat_id": chat_id,
                "model": llm_settings()["model"],
            }
        )

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(_STATIC_DIR / "index.html")

    # 其余静态资源（app.js / style.css）
    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")

    return app


# 供 `uvicorn smartcode_analyzer.browser.server.app:app` 直接引用
app = create_app()
