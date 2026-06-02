"""命令行启动入口： python -m smartcode_analyzer.browser.server

环境变量：
- SMARTCODE_BROWSER_HOST  监听地址（默认 127.0.0.1）
- SMARTCODE_BROWSER_PORT  端口（默认 8765）
- SMARTCODE_BROWSER_REGISTRY  自定义项目注册表 YAML 路径
"""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.environ.get("SMARTCODE_BROWSER_HOST", "127.0.0.1")
    port = int(os.environ.get("SMARTCODE_BROWSER_PORT", "8765"))
    # 用导入字符串而非 app 对象，避免 reload 模式下的重复构建
    uvicorn.run(
        "smartcode_browser.server.app:app",
        host=host,
        port=port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
