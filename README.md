# SmartCode Browser · 级联代码浏览器

语言无关的 Web 代码导航工具：点击函数里的**蓝色调用**，在右侧级联展开其定义，形成可视化调用树。专为跨文件追踪调用链设计。

## 功能

| 操作 | 说明 |
|------|------|
| 调用 → 定义 | 点击蓝色 `.ref`，级联打开被调函数（多实现时真实现优先） |
| 变量 → 声明 | 点击标识符，局部变量在本面板闪烁，全局/字段/枚举打开声明 |
| 查找用法 | Alt/Ctrl+点击 或 右键，弹出用法列表 |
| 会话恢复 | 刷新后自动恢复上次代码树 |
| 命名标签 | 顶栏「保存到标签」，一键恢复探索路径 |

## 支持语言

C/C++ · Python · Java · Scala/Chisel（新增语言 = 实现一个 tree-sitter 适配器）

## 快速开始

```bash
git clone https://github.com/<your-username>/smartcode-browser.git
cd smartcode-browser

python3.11 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install -e .

# 配置要浏览的代码库
cp projects/registry.example.yaml projects/registry.yaml
# 编辑 projects/registry.yaml，把 root 改成你的代码库绝对路径

# 启动（默认 127.0.0.1:8765）
.venv/bin/smartcode-browser

# 或指定端口
SMARTCODE_BROWSER_PORT=8780 .venv/bin/smartcode-browser
```

浏览器打开 `http://127.0.0.1:8765`。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `SMARTCODE_BROWSER_HOST` | `127.0.0.1` | 监听地址 |
| `SMARTCODE_BROWSER_PORT` | `8765` | 端口 |
| `SMARTCODE_BROWSER_REGISTRY` | 见 README | 项目注册表 YAML |
| `SMARTCODE_CURSOR_CLI_BIN` | `cursor-agent` | cursor-agent 可执行文件路径 |
| `SMARTCODE_CURSOR_MODEL` | `composer-2.5` | cursor-agent 使用的模型 |
| `SMARTCODE_CURSOR_TIMEOUT` | `600` | 单次 AI 分析超时（秒） |

AI 分析依赖 **cursor-agent** 及其登录态，请先安装 CLI 并执行 `cursor-agent login`（无需配置 OpenAI API Key）。

注册表查找顺序：`SMARTCODE_BROWSER_REGISTRY` → `./projects/registry.yaml` → 包旁 `projects/registry.yaml` → `/etc/smartcode/registry.yaml` → 内置演示（浏览本包源码）。

## 添加项目

编辑 `projects/registry.yaml`：

```yaml
projects:
  - id: my-kernel
    name: "Linux cpuidle"
    root: /data/linux-stable        # 绝对路径
    language: c
    include_paths:                  # 限定索引范围（大库必填）
      - drivers/cpuidle
      - kernel/sched
      - include/linux
    exclude_dirs: [.git, tools, Documentation]
```

被浏览的代码库需**单独 clone** 到服务器；本仓库只包含浏览器工具本身。

## 服务器部署

```bash
# 1. 安装
git clone ... /opt/smartcode-browser
cd /opt/smartcode-browser && python3.11 -m venv .venv
.venv/bin/pip install -e .

# 2. 配置（勿提交含本机路径的文件）
sudo mkdir -p /etc/smartcode
sudo cp projects/registry.example.yaml /etc/smartcode/registry.yaml
sudo vim /etc/smartcode/registry.yaml

# 3. systemd（见 deploy/smartcode-browser.service）
sudo cp deploy/smartcode-browser.service /etc/systemd/system/
sudo systemctl enable --now smartcode-browser
```

**依赖**：Python 3.11+、系统 `grep`（全局符号回退与查用法）。

**安全**：服务无内置鉴权，能读注册表指向的任意源码。公网暴露请加 VPN / Nginx 反代 + 认证，或 SSH 隧道：

```bash
ssh -L 8780:127.0.0.1:8780 user@server
```

## 架构

```
smartcode_browser/
  models.py           语言无关数据模型
  adapters/           tree-sitter 语言适配器（可插拔）
  registry.py         多项目注册表
  index.py            符号索引 + grep 全局回退
  engine.py           引擎
  server/             FastAPI + 原生前端
projects/
  registry.example.yaml
```

## 开发

```bash
.venv/bin/pip install -e .
SMARTCODE_BROWSER_PORT=8780 .venv/bin/python -m smartcode_browser.server

# 自检
curl http://127.0.0.1:8780/api/projects
curl "http://127.0.0.1:8780/api/stats?project=self"
```

## License

MIT
