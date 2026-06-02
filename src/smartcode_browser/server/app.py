"""FastAPI 应用：把 CodeEngine 暴露成一组语言无关的 JSON 接口，并托管前端。

接口设计刻意保持最小且无状态——级联导航的「树状态」全部放在前端，
后端只回答三类问题：有哪些项目 / 搜什么符号 / 打开某个符号是什么内容。
这样后端可水平扩展，前端布局逻辑也不受后端约束。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from ..engine import CodeEngine

_STATIC_DIR = Path(__file__).resolve().parent / "static"


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
        """按名称模糊搜索符号。"""
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

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(_STATIC_DIR / "index.html")

    # 其余静态资源（app.js / style.css）
    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")

    return app


# 供 `uvicorn smartcode_analyzer.browser.server.app:app` 直接引用
app = create_app()
