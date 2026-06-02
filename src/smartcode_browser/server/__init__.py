"""代码浏览器的 Web 层（FastAPI 后端 + 原生前端静态资源）。"""

from __future__ import annotations

from .app import create_app

__all__ = ["create_app"]
