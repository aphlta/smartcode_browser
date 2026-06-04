"""浏览器内 AI 分析：直接调用 cursor-agent CLI（复用 Cursor 登录态，无需额外 API Key）。

环境变量：
  SMARTCODE_CURSOR_CLI_BIN   默认 cursor-agent（PATH 中查找）
  SMARTCODE_CURSOR_MODEL     默认 composer-2.5
  SMARTCODE_CURSOR_TIMEOUT   单次分析超时秒数，默认 600
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

_SYSTEM_PROMPT = """你是 Linux 内核与系统软件代码分析助手。用户正在阅读源码，并选中了一段代码或整个函数。

请基于提供的**完整函数上下文**和**选中片段**回答，重点：
1. 若用户问时序/并发/多核/cache：列出几种可能情况（触发条件 → 路径 → 现象 → 如何验证）
2. 引用具体变量、锁、barrier、per-CPU 语义
3. 不确定处明确标注假设，不要编造不存在的符号
4. 可用 mermaid flowchart/sequenceDiagram 辅助（语法正确）
5. 回答使用中文，结构清晰，适度简洁"""


def _cli_bin() -> str:
    return (
        os.environ.get("SMARTCODE_CURSOR_CLI_BIN", "").strip()
        or shutil.which("cursor-agent")
        or "cursor-agent"
    )


def llm_configured() -> bool:
    bin_path = _cli_bin()
    return bool(shutil.which(bin_path) or Path(bin_path).is_file())


def llm_settings() -> dict[str, str | bool]:
    return {
        "configured": llm_configured(),
        "backend": "cursor-agent",
        "model": os.environ.get("SMARTCODE_CURSOR_MODEL", "composer-2.5"),
        "bin": _cli_bin(),
    }


def _build_full_prompt(payload: dict[str, Any]) -> str:
    """首条消息：附带函数上下文与系统说明。"""
    parts = [_SYSTEM_PROMPT, ""]
    parts.append(
        f"## 位置\n- 项目: {payload.get('project', '')}\n"
        f"- 文件: {payload.get('file', '')}\n"
        f"- 函数: {payload.get('function_name', '')} "
        f"({payload.get('start_line', '')}-{payload.get('end_line', '')})\n"
    )
    if payload.get("signature"):
        parts.append(f"- 签名: {payload['signature']}\n")
    if payload.get("selected_text"):
        parts.append(f"\n## 用户选中的代码\n```c\n{payload['selected_text']}\n```\n")
    parts.append(f"\n## 完整函数源码\n```c\n{payload.get('source', '')}\n```\n")
    parts.append(f"\n## 用户问题\n{payload.get('question', '').strip()}\n")
    return "\n".join(parts)


def _create_chat(bin_path: str, timeout: int) -> str:
    proc = subprocess.run(
        [bin_path, "create-chat"],
        capture_output=True,
        text=True,
        timeout=min(timeout, 120),
        check=False,
    )
    if proc.returncode != 0:
        err = proc.stderr.strip() or proc.stdout.strip() or "unknown error"
        raise RuntimeError(f"cursor-agent create-chat 失败: {err}")
    chat_id = proc.stdout.strip()
    if not chat_id:
        raise RuntimeError("cursor-agent create-chat 未返回 chat id")
    return chat_id


def chat_analyze(payload: dict[str, Any], workspace: Path) -> tuple[str, str]:
    """调用 cursor-agent 完成分析，返回 (回复文本, chat_id)。"""
    bin_path = _cli_bin()
    if not shutil.which(bin_path) and not Path(bin_path).is_file():
        raise RuntimeError(
            f"未找到 cursor-agent（{_cli_bin()}）。请安装并 login，或设置 SMARTCODE_CURSOR_CLI_BIN"
        )

    model = os.environ.get("SMARTCODE_CURSOR_MODEL", "composer-2.5")
    timeout = int(os.environ.get("SMARTCODE_CURSOR_TIMEOUT", "600"))

    chat_id = (payload.get("chat_id") or "").strip()
    if not chat_id:
        chat_id = _create_chat(bin_path, timeout)
        prompt = _build_full_prompt(payload)
    else:
        # 同一会话后续轮次：cursor-agent 已记住上下文，只发新问题
        prompt = payload.get("question", "").strip()

    if not prompt:
        raise RuntimeError("问题不能为空")

    if not workspace.is_dir():
        raise RuntimeError(f"项目根目录不存在: {workspace}")

    cmd = [
        bin_path,
        "--print",
        "--trust",
        "-f",
        "--workspace",
        str(workspace.resolve()),
        "--model",
        model,
        "--output-format",
        "text",
        "--resume",
        chat_id,
        prompt,
    ]

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"cursor-agent 超时（>{timeout}s）") from exc

    if proc.returncode != 0:
        err = proc.stderr.strip() or proc.stdout.strip() or "unknown error"
        raise RuntimeError(f"cursor-agent 失败 (exit {proc.returncode}): {err}")

    output = proc.stdout.strip()
    if not output:
        raise RuntimeError("cursor-agent 返回空响应")
    return output, chat_id
