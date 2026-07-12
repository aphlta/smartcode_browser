# -*- coding: utf-8 -*-
"""
生成《SmartCode Browser 项目介绍》PDF 预览版（与 docs/build_ppt.py 内容一致）。

叙事主线：缝隙 → 级联交互（demo）→ 用 AI「聊」出来的（重点）
        → 踩过的坑（注意事项）→ 这不是玩具（设计取舍）→ 路线图。

本机无 LibreOffice，用 reportlab（内置中文 CID 字体）按同一套配色 / 文案重绘 PDF。

运行：.venv/bin/python docs/build_pdf.py
产物：docs/SmartCode_Browser_介绍.pdf
"""

from __future__ import annotations

from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

FONT = "STSong-Light"
pdfmetrics.registerFont(UnicodeCIDFont(FONT))

BG_DARK = HexColor("#0E1627")
BG_PANEL = HexColor("#172238")
BG_PANEL2 = HexColor("#1F2D47")
ACCENT = HexColor("#4D9CFF")
ACCENT2 = HexColor("#32D6C0")
WARN = HexColor("#FFB14D")
TEXT = HexColor("#ECF1F8")
MUTED = HexColor("#93A1B5")
LINE = HexColor("#2A3A57")

IN = 72.0
PAGE_W, PAGE_H = 13.333 * IN, 7.5 * IN
OUT = Path(__file__).resolve().parent / "SmartCode_Browser_介绍.pdf"

c = canvas.Canvas(str(OUT), pagesize=(PAGE_W, PAGE_H))


def _yb(y_in, h_in):
    return PAGE_H - (y_in + h_in) * IN


def box(x, y, w, h, fill=None, stroke=None, sw=1.0, radius=0.10):
    c.saveState()
    if fill is not None:
        c.setFillColor(fill)
    if stroke is not None:
        c.setStrokeColor(stroke); c.setLineWidth(sw)
    xb, yb = x * IN, _yb(y, h)
    if radius and radius > 0:
        c.roundRect(xb, yb, w * IN, h * IN, radius * IN,
                    stroke=1 if stroke is not None else 0, fill=1 if fill is not None else 0)
    else:
        c.rect(xb, yb, w * IN, h * IN,
               stroke=1 if stroke is not None else 0, fill=1 if fill is not None else 0)
    c.restoreState()


def _w(text, size):
    return pdfmetrics.stringWidth(text, FONT, size)


def _draw_runs_line(x_pt, baseline, runs, align, max_w_pt):
    total = sum(_w(t, st["size"]) for t, st in runs)
    if align == "center":
        start = x_pt + (max_w_pt - total) / 2
    elif align == "right":
        start = x_pt + (max_w_pt - total)
    else:
        start = x_pt
    cx = start
    for t, st in runs:
        c.saveState()
        c.setFillColor(st["color"])
        size = st["size"]
        tobj = c.beginText(cx, baseline)
        tobj.setFont(FONT, size)
        if st.get("bold"):
            c.setStrokeColor(st["color"]); c.setLineWidth(size * 0.035)
            tobj.setTextRenderMode(2)
        tobj.textOut(t)
        c.drawText(tobj)
        c.restoreState()
        cx += _w(t, size)


def paragraphs(x_in, y_top_in, w_in, paras):
    x_pt = x_in * IN
    max_w = w_in * IN
    cur_top = y_top_in
    for pa in paras:
        segs = pa["segs"]
        align = pa.get("align", "left")
        sa = pa.get("space_after", 6)
        chars = []
        for t, st in segs:
            for ch in t:
                chars.append((ch, st))
        size_max = max((st["size"] for _, st in segs), default=12)
        leading = pa.get("leading", size_max * 1.32)
        lines = []
        line = []; lw = 0.0
        for ch, st in chars:
            if ch == "\n":
                lines.append(line); line = []; lw = 0.0; continue
            cw = _w(ch, st["size"])
            if lw + cw > max_w and line:
                lines.append(line); line = []; lw = 0.0
            line.append((ch, st)); lw += cw
        if line:
            lines.append(line)
        if not lines:
            lines = [[]]
        for ln in lines:
            runs = []
            for ch, st in ln:
                if runs and runs[-1][1] is st:
                    runs[-1] = (runs[-1][0] + ch, st)
                else:
                    runs.append((ch, st))
            baseline = _yb(cur_top, 0) - leading * 0.78
            _draw_runs_line(x_pt, baseline, runs, align, max_w)
            cur_top += leading / IN
        cur_top += sa / IN
    return cur_top


def S(size, color=TEXT, bold=False):
    return dict(size=size, color=color, bold=bold)


def header(kicker, title, accent=ACCENT):
    box(0.7, 0.62, 0.10, 0.55, fill=accent, radius=0)
    paragraphs(0.97, 0.5, 11.6, [
        {"segs": [(kicker, S(13, accent, True))], "space_after": 3},
        {"segs": [(title, S(26, TEXT, True))], "space_after": 0},
    ])


def footer(idx, total):
    paragraphs(0.7, 7.02, 8.0, [{"segs": [
        ("SmartCode Browser", S(9, MUTED, True)),
        ("   ·   一个用 Cursor「聊」出来的代码导航工具", S(9, MUTED)),
    ], "space_after": 0}])
    paragraphs(10.0, 7.02, 2.6, [{"segs": [(f"{idx:02d} / {total:02d}", S(9, MUTED))],
                                  "align": "right", "space_after": 0}])


def bg():
    box(0, 0, 13.333, 7.5, fill=BG_DARK, radius=0)


def card(x, y, w, h, title, lines, accent=ACCENT, title_size=16, body_size=12):
    box(x, y, w, h, fill=BG_PANEL, stroke=LINE, sw=1.0)
    box(x, y, 0.09, h, fill=accent, radius=0)
    paras = [{"segs": [(title, S(title_size, TEXT, True))], "space_after": 8}]
    for ln in lines:
        paras.append({"segs": [("·  ", S(body_size, accent, True)), (ln, S(body_size, MUTED))],
                      "space_after": 5, "leading": body_size * 1.25})
    paragraphs(x + 0.28, y + 0.16, w - 0.5, paras)


def table(x, y, w, headers, rows, ratios, row_h=0.5, head_h=0.55,
          head_fill=BG_PANEL2, body_size=13, head_size=14):
    total = sum(ratios)
    cols = [w * r / total for r in ratios]
    cx = x
    for j, ht in enumerate(headers):
        box(cx, y, cols[j], head_h, fill=head_fill, stroke=BG_DARK, sw=1.5, radius=0)
        paragraphs(cx + 0.14, y + (head_h - head_size / 72) / 2 - 0.02, cols[j] - 0.2,
                   [{"segs": [(ht, S(head_size, ACCENT if j == 0 else TEXT, True))], "space_after": 0}])
        cx += cols[j]
    ry = y + head_h
    for i, row in enumerate(rows):
        cx = x
        rfill = BG_PANEL if i % 2 == 0 else BG_PANEL2
        for j, cell in enumerate(row):
            box(cx, ry, cols[j], row_h, fill=rfill, stroke=BG_DARK, sw=1.5, radius=0)
            col = TEXT if j == 0 else MUTED
            est_lines = max(1, int(_w(cell, body_size) / ((cols[j] - 0.28) * IN)) + 1)
            text_h = est_lines * body_size * 1.2 / 72
            paragraphs(cx + 0.14, ry + (row_h - text_h) / 2, cols[j] - 0.28,
                       [{"segs": [(cell, S(body_size, col, j == 0))], "space_after": 0,
                         "leading": body_size * 1.2}])
            cx += cols[j]
        ry += row_h
    return ry


def arrow(x, y, w, h, color=ACCENT2):
    c.saveState(); c.setFillColor(color)
    xb = x * IN; yc = _yb(y, h) + h * IN / 2
    bw = w * IN * 0.55; bh = h * IN * 0.34
    c.rect(xb, yc - bh / 2, bw, bh, stroke=0, fill=1)
    p = c.beginPath()
    p.moveTo(xb + bw, yc - h * IN / 2)
    p.lineTo(xb + w * IN, yc)
    p.lineTo(xb + bw, yc + h * IN / 2)
    p.close()
    c.drawPath(p, stroke=0, fill=1)
    c.restoreState()


def chev(x, y, h, color=MUTED):
    """主线页用的小箭头 ›。"""
    c.saveState(); c.setFillColor(color)
    xb = x * IN; yc = _yb(y, h) + h * IN / 2
    p = c.beginPath()
    p.moveTo(xb, yc - h * IN / 2)
    p.lineTo(xb + h * IN * 0.6, yc)
    p.lineTo(xb, yc + h * IN / 2)
    p.lineTo(xb + h * IN * 0.18, yc)
    p.close()
    c.drawPath(p, stroke=0, fill=1)
    c.restoreState()


def band(zh, x, y, w, accent, h_band=0.7, zh_size=18):
    box(x, y, w, h_band, fill=accent, radius=0.10)
    box(x, y + h_band / 2, w, h_band / 2, fill=accent, radius=0)
    paragraphs(x, y + (h_band - zh_size / 72) / 2 - 0.02, w,
               [{"segs": [(zh, dict(size=zh_size, color=BG_DARK, bold=True))], "align": "center", "space_after": 0}])


def stat(x, y, w, number, label, accent=ACCENT):
    box(x, y, w, 1.25, fill=BG_PANEL, stroke=LINE)
    paragraphs(x, y + 0.22, w, [
        {"segs": [(number, S(30, accent, True))], "align": "center", "space_after": 4},
        {"segs": [(label, S(12, MUTED))], "align": "center", "space_after": 0},
    ])


def quad(x, y, w, h, idx, title, lines, accent):
    box(x, y, w, h, fill=BG_PANEL, stroke=LINE)
    box(x, y, 0.09, h, fill=accent, radius=0)
    paragraphs(x + 0.28, y + 0.16, w - 0.5,
               [{"segs": [(idx + "  ", S(18, accent, True)), (title, S(17, TEXT, True))], "space_after": 8}] +
               [{"segs": [("·  ", S(13, accent, True)), (ln, S(13, MUTED))], "space_after": 6,
                 "leading": 17} for ln in lines])


pages = []


def page(fn):
    pages.append(fn)
    return fn


# ---- 1. 封面 -------------------------------------------------------------
@page
def p01():
    bg()
    box(0, 0, 13.333, 0.18, fill=ACCENT, radius=0)
    box(0, 0.18, 13.333, 0.06, fill=ACCENT2, radius=0)
    paragraphs(0.9, 1.8, 11.5, [
        {"segs": [("SmartCode  Browser", S(50, TEXT, True))], "space_after": 6},
        {"segs": [("级联式代码浏览器", S(28, ACCENT, True))], "space_after": 16},
        {"segs": [("一个人 + AI，做出一个真能用在内核 / 芯片大库上的代码导航工具", S(18, TEXT))], "space_after": 4},
        {"segs": [("几乎没手写代码 —— 全程用 Cursor「聊」出来", S(15, MUTED))], "space_after": 0},
    ])
    box(0.9, 5.5, 10.6, 0.0, stroke=LINE, sw=1.0, radius=0)
    paragraphs(0.9, 5.7, 11.6, [{"segs": [
        ("为什么需要 ", S(16, ACCENT2, True)),
        ("·  怎么用 AI 造的  ·  ", S(16, MUTED)),
        ("要注意什么 ", S(16, ACCENT2, True)),
        ("·  往哪走", S(16, MUTED)),
    ], "space_after": 0}])


# ---- 2. 主线 -------------------------------------------------------------
@page
def p02():
    bg(); header("今天的主线", "一条线串起来：从缝隙到工具，再到 AI 怎么造的")
    spine = [
        ("缝隙", "现有工具追一条链都别扭", ACCENT),
        ("级联", "用新交互填上，现场演示", ACCENT),
        ("AI 造的", "全程和 Cursor 聊出来", WARN),
        ("踩过的坑", "用 AI 开发要注意什么", WARN),
        ("往哪走", "路线图", ACCENT2),
    ]
    bw = 2.05; gap = 0.28; x = 0.95; y = 2.4; bh = 1.7
    for i, (t, d, ac) in enumerate(spine):
        box(x, y, bw, bh, fill=BG_PANEL, stroke=ac, sw=1.5)
        box(x, y, bw, 0.12, fill=ac, radius=0)
        paragraphs(x + 0.12, y + 0.3, bw - 0.24, [
            {"segs": [(f"{i+1}", S(14, ac, True))], "align": "center", "space_after": 4},
            {"segs": [(t, S(20, TEXT, True))], "align": "center", "space_after": 6},
            {"segs": [(d, S(12, MUTED))], "align": "center", "space_after": 0, "leading": 15},
        ])
        if i < len(spine) - 1:
            chev(x + bw + 0.02, y + bh / 2 - 0.16, 0.32, color=MUTED)
        x += bw + gap
    paragraphs(0.95, 4.7, 11.3, [{"segs": [
        ("重点在第 3 段：", S(16, WARN, True)),
        ("这工具本身只是个例子，更想分享的是 —— 现在你也能这样用 AI 造出真能用的内部工具。", S(16, TEXT))],
        "space_after": 0}])


# ---- 3. 为什么需要它 -----------------------------------------------------
@page
def p03():
    bg(); header("为什么需要它", "「调查一条调用链」是被现有工具组织得最烂的任务")
    table(0.95, 1.7, 10.6, ["现有方式", "能干嘛", "追一条链时的别扭"],
          [["IDE 跳转", "准、能改代码", "标签越开越多，路径全在脑子里，难复述给别人"],
           ["grep / 全文搜索", "快、无需索引", "只给「出现位置」，没有调用层次"],
           ["直接问 AI", "出解释快", "行号 / 路径不稳定，难逐行核对"]],
          ratios=[2.4, 2.8, 5.4], row_h=0.78, head_h=0.6, body_size=14.5)
    box(0.95, 4.85, 10.6, 1.5, fill=BG_PANEL, stroke=ACCENT, sw=1.5)
    paragraphs(1.3, 5.05, 10.0, [
        {"segs": [("缝隙：不是工具不好，而是「沿调用链调查」这件事，信息组织方式不对。", S(18, TEXT, True))],
         "space_after": 6},
        {"segs": [("我们想要的：", S(15, ACCENT, True)),
                  ("从入口出发，顺着「谁调谁」一层层展开，路径可见、可续、可分享 —— 像在树上散步。", S(15, MUTED))],
         "space_after": 0},
    ])


# ---- 4. 核心体验 ---------------------------------------------------------
@page
def p04():
    bg(); header("怎么填这个缝隙", "核心体验：点蓝色调用，右侧长出新面板")
    py = 2.1; ph = 2.6; pw = 3.2
    data = [("函数 A", "入口 / 搜索进入", ACCENT, True),
            ("函数 B", "点 A 里的调用打开", ACCENT, True),
            ("函数 C", "再点 B 里的调用打开", ACCENT2, False)]
    xs = [0.95, 4.55, 8.15]
    for i, (t, d, ac, has) in enumerate(data):
        x = xs[i]
        box(x, py, pw, ph, fill=BG_PANEL, stroke=ac, sw=1.5)
        box(x, py, pw, 0.55, fill=ac, radius=0.10)
        box(x, py + 0.27, pw, 0.28, fill=ac, radius=0)
        paragraphs(x, py + 0.12, pw, [{"segs": [(t, S(17, BG_DARK, True))], "align": "center", "space_after": 0}])
        ps = [{"segs": [(d, S(12, MUTED))], "space_after": 10, "leading": 16}]
        if has:
            ps.append({"segs": [("  result = ", S(12, TEXT)), ("call_next()", S(12, ACCENT, True)),
                                (";", S(12, TEXT))], "space_after": 0})
        paragraphs(x + 0.25, py + 0.75, pw - 0.5, ps)
    for i in range(2):
        arrow(xs[i] + pw + 0.02, py + 1.0, 0.55, 0.5, color=ACCENT2)
    paragraphs(0.95, 5.15, 11.4, [{"segs": [
        ("新面板向右生长，左侧不被盖住", S(17, ACCENT, True)),
        (" —— 整条调用链 A→B→C 始终可见、可回看、可截图分享。", S(17, TEXT))], "space_after": 0}])


# ---- 5. 能力一览 ---------------------------------------------------------
@page
def p05():
    bg(); header("它能做什么", "能力一览")
    table(0.95, 1.7, 10.6, ["能力", "一句话说明"],
          [["调用 → 定义", "点蓝色引用，级联展开；多实现时真实现优先、空桩靠后"],
           ["变量 → 声明", "局部变量本面板高亮，全局 / 字段 / 枚举开新面板"],
           ["查找用法", "Alt/Ctrl+点击 或右键，看谁在用这个符号"],
           ["符号搜索", "支持 in:路径 限定范围，从任意入口开始追链"],
           ["多 arch 消歧", "配 compile_commands.json 后跳到真正被编译的那一份"],
           ["会话 / 标签", "刷新自动恢复 + 命名保存探索路径，方便交接分享"],
           ["可选 AI 分析", "对当前函数提问，走 cursor-agent（复用 Cursor 登录）"]],
          ratios=[3.0, 7.6], row_h=0.6, head_h=0.55, body_size=14, head_size=15)
    paragraphs(0.95, 6.3, 11.4, [{"segs": [
        ("语言无关：C/C++ · Python · Java · Scala/Chisel —— 换语言、换项目主要靠配置。", S(14, MUTED))],
        "space_after": 0}])


# ---- 6. 现场演示 ---------------------------------------------------------
@page
def p06():
    bg(); header("现场演示", "三分钟看明白（重点两个动作）", accent=ACCENT2)
    steps = [
        ("1", "搜入口 → 连点 2~3 层调用", "面板一块块向右长出来 —— 全场最直观的瞬间，口播调用链", False),
        ("2", "保存标签 → 刷新恢复", "命名保存路径 → F5，阅读树自动恢复，强调「可续」", False),
        ("★", "吃自己的狗粮", "当场用这个工具去读它自己的源码 —— AI 做的工具来读代码，最有记忆点", True),
    ]
    y = 2.0
    for num, t, d, star in steps:
        ac = WARN if star else ACCENT2
        box(0.95, y, 0.7, 1.05, fill=ac)
        paragraphs(0.95, y + 0.32, 0.7, [{"segs": [(num, S(26, BG_DARK, True))], "align": "center", "space_after": 0}])
        box(1.85, y, 9.7, 1.05, fill=BG_PANEL, stroke=LINE)
        if star:
            box(1.85, y, 0.09, 1.05, fill=WARN, radius=0)
        paragraphs(2.15, y + 0.2, 9.2, [
            {"segs": [(t, S(18, TEXT, True))], "space_after": 4},
            {"segs": [(d, S(13.5, MUTED))], "space_after": 0, "leading": 17},
        ])
        y += 1.27
    paragraphs(0.95, 6.05, 11.4, [{"segs": [
        ("其它（查用法、多候选选真实现、AI 提问）视时间补充，别让演示掉节奏。", S(13, MUTED))], "space_after": 0}])


# ---- 7. 分隔：用 Cursor 聊出来的 + 数字 ---------------------------------
@page
def p07():
    bg()
    box(0, 1.9, 13.333, 1.7, fill=BG_PANEL, radius=0)
    box(0.9, 1.9, 0.14, 1.7, fill=WARN, radius=0)
    paragraphs(1.3, 2.0, 10.5, [
        {"segs": [("PART · 重点", S(15, WARN, True))], "space_after": 6},
        {"segs": [("怎么用 Cursor 把这个工具「聊」出来", S(31, TEXT, True))], "space_after": 0},
    ])
    stats = [("≈6900", "行代码"), ("8", "个 Python 模块"), ("~2400", "行前端"), ("7+", "次能力迭代")]
    sw = 2.55; x0 = 0.95; sy = 4.1
    for i, (num, lab) in enumerate(stats):
        stat(x0 + i * (sw + 0.2), sy, sw, num, lab, accent=WARN if i % 2 else ACCENT)
    paragraphs(0.95, 5.6, 11.4, [{"segs": [
        ("几乎全程 AI 结对完成 —— 人几乎没手写实现，只在「说清楚要什么」和「把关」上花时间。", S(14, MUTED))],
        "space_after": 0}])


# ---- 8. 核心理念 ---------------------------------------------------------
@page
def p08():
    bg(); header("怎么造的 (1/4)", "核心理念：不写实现，写「想要什么」", accent=WARN)
    cards = [
        ("从真实痛点出发", ["起点是「读 cpuidle 调用链很累」", "不是「我想学个新框架」", "需求来自真实工程，验收也回真实工程"], WARN),
        ("用自然语言描述需求", ["「点调用就在右边展开定义」", "「同名多实现时真实现优先」", "AI 负责翻译成跨文件的代码"], ACCENT),
        ("人审 + 小步迭代", ["每个能力一个 commit，独立验证", "跑起来不对就回退、重新描述", "实现是 AI 的活儿，方向是人的活儿"], ACCENT2),
    ]
    cw = 3.6; x0 = 0.95
    for i, (t, lines, ac) in enumerate(cards):
        card(x0 + i * (cw + 0.25), 1.9, cw, 3.4, t, lines, accent=ac, title_size=17, body_size=13)
    paragraphs(0.95, 5.6, 11.4, [{"segs": [
        ("一句话：", S(15, WARN, True)),
        ("把 Cursor 当「随叫随到的结对工程师」—— 你负责想清楚，它负责写出来。", S(15, TEXT))], "space_after": 0}])


# ---- 9. 迭代时间线 -------------------------------------------------------
@page
def p09():
    bg(); header("怎么造的 (2/4)", "真实迭代时间线（每条 = 一次对话 + 一个 commit）", accent=WARN)
    timeline = [
        ("v0", "独立级联浏览器", "先把「点调用→右侧展开」的骨架跑起来", ACCENT),
        ("+", "面板去重 · 拖动避让 · 会话标签", "让多面板好用：刷新恢复、命名保存路径", ACCENT),
        ("+", "AI 分析侧栏（cursor-agent）", "把 Cursor 接进浏览器，对当前函数提问", ACCENT2),
        ("+", "搜索支持 in:路径 限定", "大库里更快定位入口符号", ACCENT2),
        ("+", "函数指针跳转 · 宏修复 · 索引缓存", "真用内核时撞到的边界，逐个补上 + 提速", WARN),
        ("+", "查用法 · 连线锚点优化", "往回看依赖 + 视觉打磨", WARN),
        ("now", "多入口跳同一函数时复用面板", "细节体验持续抛光", ACCENT),
    ]
    y = 1.8; lh = 0.66
    box(1.5, y, 0.03, lh * len(timeline) - 0.2, fill=LINE, radius=0)
    for tag, t, d, ac in timeline:
        box(1.28, y + 0.06, 0.46, 0.46, fill=ac)
        paragraphs(1.28, y + 0.18, 0.46, [{"segs": [(tag, S(11, BG_DARK, True))], "align": "center", "space_after": 0}])
        paragraphs(2.0, y + 0.16, 9.5, [{"segs": [(t + "    ", S(15, TEXT, True)), (d, S(12.5, MUTED))],
                                         "space_after": 0}])
        y += lh


# ---- 10. 怎么和 Cursor 配合 ---------------------------------------------
@page
def p10():
    bg(); header("怎么造的 (3/4)", "具体怎么和 Cursor 配合", accent=WARN)
    ways = [
        ("Agent / Composer 多文件改", "一句需求同时改后端 + 前端，保持端到端一致"),
        ("@ 引用精确喂上下文", "@文件 / @符号 指给 AI，少绕弯、改得准"),
        ("边写边跑自检", "curl 接口 + 浏览器实时看效果，错了立刻反馈给 AI"),
        ("SpecStory 留存对话", ".specstory/ 自动记录每次会话 = 开发决策日志"),
        ("吃自己的狗粮", "registry 默认指向本仓库，用工具读工具自身代码"),
        ("让 AI 同步写文档", "README、这份 PPT 讲稿都让 AI 跟着代码一起更新"),
    ]
    cw = 5.2; ch = 1.35; x0 = 0.95; y0 = 1.85
    for i, (t, d) in enumerate(ways):
        col = i % 2; row = i // 2
        x = x0 + col * (cw + 0.2); y = y0 + row * (ch + 0.18)
        box(x, y, cw, ch, fill=BG_PANEL, stroke=LINE)
        box(x, y, 0.09, ch, fill=WARN if col else ACCENT, radius=0)
        paragraphs(x + 0.28, y + 0.18, cw - 0.5, [
            {"segs": [(t, S(16, TEXT, True))], "space_after": 5},
            {"segs": [(d, S(12.5, MUTED))], "space_after": 0, "leading": 16},
        ])


# ---- 11. 人 vs AI --------------------------------------------------------
@page
def p11():
    bg(); header("怎么造的 (4/4)", "人和 AI 各干什么", accent=WARN)
    box(0.95, 1.9, 5.15, 3.7, fill=BG_PANEL, stroke=ACCENT, sw=1.5)
    a = ["定方向：解决哪个真实痛点", "定边界：只读 / 语言无关 / 不做 IDE",
         "定优先级：如「真实现优先于空桩」", "验真场景：拿内核 / NEMU 实测", "审结果、把关取舍与质量"]
    paragraphs(1.25, 2.1, 4.6, [{"segs": [("人负责（少而关键）", S(20, ACCENT, True))], "space_after": 10}] +
               [{"segs": [("·  ", S(13, ACCENT, True)), (t, S(13.5, TEXT))], "space_after": 9} for t in a])
    box(6.4, 1.9, 5.15, 3.7, fill=BG_PANEL, stroke=ACCENT2, sw=1.5)
    b = ["几乎全部实现：跨文件写 / 改代码", "脚手架：服务、前端、语言适配", "补盲区：宏、函数指针等边界 case",
         "重构、命名、写注释 / 文档", "解释报错、给修复方案"]
    paragraphs(6.7, 2.1, 4.6, [{"segs": [("AI（Cursor）负责（重活）", S(20, ACCENT2, True))], "space_after": 10}] +
               [{"segs": [("·  ", S(13, ACCENT2, True)), (t, S(13.5, TEXT))], "space_after": 9} for t in b])
    paragraphs(0.95, 5.85, 11.4, [{"segs": [
        ("AI 写了几乎所有代码，但「这东西该是什么样」始终是人在拿主意。", S(15, TEXT, True))],
        "align": "center", "space_after": 0}])


# ---- 12. 用 AI 开发的注意事项 -------------------------------------------
@page
def p12():
    bg(); header("踩过的坑", "用 AI 做这类东西，要注意什么", accent=WARN)
    quads = [
        ("①", "方向与边界：人来守", ["场景要具体（需求 ≈ 验收标准）", "边界钉死，否则范围一路膨胀", "优先级是人的判断，AI 给不了"], ACCENT),
        ("②", "质量：别信「看起来对」", ["每次都审 diff，尤其跨文件", "小步提交 + 拿真实数据验证", "防幻觉：编造的 API 去查文档"], WARN),
        ("③", "上下文：喂得准、会漂", ["@文件 / @符号 精确给上下文", "长对话会忘约定，适时开新会话", "把边界 / 风格固化进规则文件"], ACCENT2),
        ("④", "安全与合规", ["别把密钥 / 内部源码无意识喂出去", "生成代码可能撞开源，关键处留意", "危险操作（删库 / 强推）人来确认"], WARN),
    ]
    cw = 5.2; ch = 2.0; x0 = 0.95; y0 = 1.8
    for i, (idx, t, lines, ac) in enumerate(quads):
        col = i % 2; row = i // 2
        x = x0 + col * (cw + 0.2); y = y0 + row * (ch + 0.18)
        quad(x, y, cw, ch, idx, t, lines, ac)
    paragraphs(0.95, 6.0, 11.4, [{"segs": [
        ("一句话：AI 是放大器 —— 放大你的判断力，也放大你的疏忽。坦诚讲局限，反而最加分。", S(14, MUTED))],
        "space_after": 0}])


# ---- 13. 这不是玩具：设计取舍 -------------------------------------------
@page
def p13():
    bg(); header("这不是玩具", "几个为真实工程做的取舍（AI 实现，人来定）")
    tradeoffs = [
        ("多 arch / 多 ISA 消歧", "同名实现 x86 / riscv / mips 各一份；读 compile_commands.json 判断「这次实际编译了哪份」，稳定命中真实现", ACCENT),
        ("真实现优先、空桩靠后", "大库里同名 / 弱符号 / #ifdef 桩满天飞 —— 候选排序体现对真实工程的理解", ACCENT2),
        ("诚实优于炫技", "静态解析有盲区，解析不了就明确标注、绝不假装能跳；grep 兜底保证至少搜得到名字", WARN),
    ]
    y = 1.85
    for t, d, ac in tradeoffs:
        box(0.95, y, 10.6, 1.4, fill=BG_PANEL, stroke=LINE)
        box(0.95, y, 0.1, 1.4, fill=ac, radius=0)
        paragraphs(1.35, y + 0.22, 10.0, [
            {"segs": [(t, S(18, ac, True))], "space_after": 5},
            {"segs": [(d, S(14, MUTED))], "space_after": 0, "leading": 18},
        ])
        y += 1.55


# ---- 14. 路线图 ----------------------------------------------------------
@page
def p14():
    bg(); header("往哪走 · ROADMAP", "后面打算做什么", accent=ACCENT2)
    roadmap = [
        ("近期 · Now/Next", ACCENT,
         ["难解析场景增强：函数指针 / 表驱动 / 宏 跳得更准",
          "全局调用图视图：不止级联，整张图一眼看全",
          "调用树导出 / 分享链接：把路径发给同事"]),
        ("中期", ACCENT2,
         ["更深 AI：一键讲解整条调用链",
          "对调用图提问：「谁最终调用了它」",
          "接 IDE / Git / PR：跳编辑器、评审挂调用树"]),
        ("远期", WARN,
         ["更多语言：Rust / Go / Verilog 完善",
          "团队协作：登录鉴权 / 共享标签",
          "性能：超大库增量索引、更快冷启动"]),
    ]
    cw = 3.6; x0 = 0.95; cy = 1.85; ch = 4.3
    for i, (t, ac, lines) in enumerate(roadmap):
        x = x0 + i * (cw + 0.25)
        box(x, cy, cw, ch, fill=BG_PANEL, stroke=LINE)
        band(t, x, cy, cw, ac, h_band=0.7, zh_size=18)
        paragraphs(x + 0.3, cy + 0.95, cw - 0.6,
                   [{"segs": [("▸  ", S(14.5, ac, True)), (ln, S(14.5, TEXT))], "space_after": 14,
                     "leading": 20} for ln in lines])


# ---- 15. 总结 ------------------------------------------------------------
@page
def p15():
    bg(); header("总结", "一页带走")
    rows = [
        ("缝隙 → 工具", "「沿调用链调查」被现有工具组织得很烂；级联交互把它变成沿调用树散步", ACCENT),
        ("怎么造的（重点）", "一个人 + Cursor 聊出来：人提需求 + 把关，AI 写几乎全部实现，小步迭代", WARN),
        ("最想分享的", "门槛降了 —— 你也能这样造内部工具；但方向、边界、把关，仍是人的活儿", ACCENT2),
    ]
    y = 1.95
    for t, d, ac in rows:
        box(0.95, y, 10.6, 1.2, fill=BG_PANEL, stroke=LINE)
        box(0.95, y, 0.12, 1.2, fill=ac, radius=0)
        paragraphs(1.35, y + 0.2, 10.0, [
            {"segs": [(t, S(19, ac, True))], "space_after": 4},
            {"segs": [(d, S(15, TEXT))], "space_after": 0, "leading": 19},
        ])
        y += 1.45


# ---- 16. 谢谢 ------------------------------------------------------------
@page
def p16():
    bg()
    box(0, 0, 13.333, 0.18, fill=ACCENT, radius=0)
    box(0, 0.18, 13.333, 0.06, fill=ACCENT2, radius=0)
    paragraphs(0.9, 3.0, 11.5, [
        {"segs": [("谢谢 · 欢迎提问", S(42, TEXT, True))], "align": "center", "space_after": 12},
        {"segs": [("现场演示 + Q&A", S(19, ACCENT))], "align": "center", "space_after": 0},
    ])


total = len(pages)
skip = {1, 7, total}
for i, fn in enumerate(pages, start=1):
    fn()
    if i not in skip:
        footer(i, total)
    c.showPage()
c.save()
print(f"OK -> {OUT}  ({total} pages)")
