# SmartCode Browser · 级联代码浏览器

语言无关的 Web 代码导航工具：点击函数里的**蓝色调用**，在右侧级联展开其定义，形成可视化调用树。专为跨文件追踪调用链设计。

## 功能

| 操作 | 说明 |
|------|------|
| 调用 → 定义 | 点击蓝色 `.ref`，级联打开被调函数（多实现时真实现优先） |
| 变量 → 声明 | 点击标识符，局部变量在本面板闪烁，全局/字段/枚举打开声明 |
| 查找用法 | Alt/Ctrl+点击 或 右键，弹出用法列表 |
| 多 arch 消歧 | 配置编译数据库后，同名定义优先跳到**实际编译**的那一份（见下） |
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
| `SMARTCODE_BROWSER_CACHE` | `~/.cache/smartcode-browser` | 符号索引磁盘缓存目录；设为 `off` 禁用 |

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

## 编译数据库（可选，提升跳转准确度）

纯静态解析只能按**名字**找定义，遇到内核 / NEMU 这类**多 arch / 多 ISA 同名**
（如 `isa_reg_display` 在 x86 / riscv32 / mips32 / loongarch32r 各有一份）或
`#ifdef` 条件编译时只能靠启发式猜。配置编译器生成的 `compile_commands.json` 后，
工具会识别「本次实际编译了哪些翻译单元」，让跳转**稳定命中真正被编译的那一份**。

特性：

- **纯增量、可缺省**：不配置时行为完全不变；只在「同名候选里确实有一份被编译过」
  时才消歧，故编译库即使只覆盖部分子工程也不会误伤其它目录的唯一定义。
- 同时利用每个 TU 的 `-I` 搜索路径，让头文件里的宏/inline 优先选当前 TU 可达的那个头。
- 按 `compile_commands.json` 的 mtime/size 做磁盘缓存，数万条目也不会拖慢启动。

在项目里加一行 `compile_commands`（相对 `root` 或绝对路径）即可启用：

```yaml
  - id: ysyx-workbench
    root: /home/alex/ysyx-workbench
    language: c
    extra_languages: [asm]
    compile_commands: nemu/compile_commands.json   # 可选
```

生成 `compile_commands.json`（任选其一）：

```bash
# 通用：pip 安装，无需 root
pip install compiledb
cd <子工程> && make clean && compiledb make

# 通用：bear（需 apt/brew 安装）
cd <子工程> && make clean && bear -- make

# Linux 内核自带目标（生成在仓库根）
make ARCH=arm64 <你的配置> && make compile_commands.json

# U-Boot
make <board>_defconfig && make && make compile_commands.json
```

启用后重启服务即可（符号索引缓存无需清；编译库是查询期叠加的）。可用
`curl "http://127.0.0.1:8765/api/stats?project=<id>"` 查看 `compile_db` 字段确认已编译 TU 数。

> 注：编译数据库随**配置**变化。如 NEMU 切换 ISA（`make menuconfig`）后需重新生成，
> 跳转才会指向新 ISA 的实现。

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
  compile_db.py       编译数据库（compile_commands.json）解析，按实际编译消歧
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
