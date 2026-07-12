/*
 * SmartCode 代码浏览器前端
 *
 * 核心是一棵「导航树」：每个 Panel 记录它从哪个父 Panel 的哪一行点进来。
 * 渲染时按 depth（到根的距离）分列，同一父节点下的多个分支在同列纵向堆叠，
 * 从而实现「A→B→C 和 A→B→E 并列」的级联效果（IDE 难以做到）。
 */

const state = {
  project: null,
  panels: new Map(), // id -> panel 对象
  order: [],         // 维持插入顺序，决定同列内的堆叠次序
  seq: 0,            // panel id 自增
  _restoring: false, // 恢复会话时跳过自动保存，避免写入半成品
  aiConfigured: false,
  aiModel: "",
  aiBackend: "",
  searchMode: "def", // def=定义 | use=调用位置
  focusedPanelId: null,
  debugProfiles: [],    // 来自 .vscode/launch.json 的 GDB 配置
  autoBookmarkId: null,   // 当前树对应的自动同步标签 id
  autoBookmarkName: null, // 用户自定义标签名（再次保存时沿用）
  manualBookmarkId: null, // 当前关联的手动标签 id（仅 load 手动标签后用于编辑回写）
  manualBookmarkLoaded: false, // true = 从顶栏手动标签打开，编辑时同步回该标签
  reparentTargetId: null, // 切换箭头来源模式：待改父链的目标面板 id
};

// localStorage 键：上次会话 + 用户命名的标签书签 + AI 分析记录
const LS_SESSION = "smartcode-browser-session-v1";
const LS_BOOKMARKS = "smartcode-browser-bookmarks-v1";
const LS_AI = "smartcode-browser-ai-v1";
const LS_DEBUG_PROFILE = "smartcode-browser-debug-profile-v1";

const el = {
  projectSelect: document.getElementById("project-select"),
  searchInput: document.getElementById("search-input"),
  searchResults: document.getElementById("search-results"),
  searchMode: document.getElementById("search-mode"),
  board: document.getElementById("board"),
  stats: document.getElementById("stats"),
  emptyHint: document.getElementById("empty-hint"),
  btnSaveBookmark: document.getElementById("btn-save-bookmark"),
  bookmarkList: document.getElementById("bookmark-list"),
  bookmarkDialog: document.getElementById("bookmark-dialog"),
  bookmarkNameInput: document.getElementById("bookmark-name-input"),
  bookmarkSaveOk: document.getElementById("bookmark-save-ok"),
  bookmarkSaveCancel: document.getElementById("bookmark-save-cancel"),
  debugProfileSelect: document.getElementById("debug-profile-select"),
  btnExportGdb: document.getElementById("btn-export-gdb"),
  codeCtxMenu: document.getElementById("code-ctx-menu"),
  funcMap: document.getElementById("func-map"),
  funcMapBody: document.getElementById("func-map-body"),
  funcMapToggle: document.getElementById("func-map-toggle"),
};

// ---------- 工具 ----------

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

async function api(path, params) {
  const url = new URL(path, window.location.origin);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== null && v !== undefined) url.searchParams.set(k, v);
  });
  const resp = await fetch(url);
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({}));
    throw new Error(detail.detail || resp.statusText);
  }
  return resp.json();
}

async function apiPost(path, body) {
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const detail = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(detail.detail || resp.statusText);
  return detail;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast("已复制到剪贴板");
      return true;
    } catch {
      toast("复制失败");
      return false;
    } finally {
      ta.remove();
    }
  }
}

// ---------- 编译上下文 / GDB ----------

async function loadDebugProfiles(projectId) {
  state.debugProfiles = [];
  if (!projectId) {
    refreshDebugProfileSelect();
    return;
  }
  try {
    state.debugProfiles = await api("/api/debug/profiles", { project: projectId });
  } catch {
    state.debugProfiles = [];
  }
  refreshDebugProfileSelect();
  await autoSelectDebugProfile();
}

function debugProfileStore() {
  try {
    return JSON.parse(localStorage.getItem(LS_DEBUG_PROFILE)) || {};
  } catch {
    return {};
  }
}

function saveDebugProfileChoice(profileId) {
  if (!state.project || !profileId) return;
  const s = debugProfileStore();
  s[state.project] = profileId;
  localStorage.setItem(LS_DEBUG_PROFILE, JSON.stringify(s));
}

async function autoSelectDebugProfile(hintFile) {
  const root = state.order[0] && state.panels.get(state.order[0]);
  const file = hintFile || root?.detail?.file;
  if (!file || !state.debugProfiles.length) return;

  try {
    const prof = await api("/api/debug/suggest", { project: state.project, file });
    if (prof?.id && state.debugProfiles.some((p) => p.id === prof.id)) {
      el.debugProfileSelect.value = prof.id;
      saveDebugProfileChoice(prof.id);
      return;
    }
  } catch {
    /* 无推荐时回退用户上次选择 */
  }
  const stored = debugProfileStore()[state.project];
  if (stored && state.debugProfiles.some((p) => p.id === stored && !p.needs_input)) {
    el.debugProfileSelect.value = stored;
  }
}

function refreshDebugProfileSelect() {
  const sel = el.debugProfileSelect;
  const prev = sel.value;
  sel.innerHTML = '<option value="">调试配置…</option>';
  state.debugProfiles.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    let label = p.name;
    if (p.needs_input) label += "（需填路径）";
    opt.textContent = label;
    opt.title = `${p.program}\ncwd: ${p.cwd}`;
    sel.appendChild(opt);
  });
  if (prev && state.debugProfiles.some((p) => p.id === prev)) sel.value = prev;
  el.btnExportGdb.disabled = !state.debugProfiles.length;
}

function selectedDebugProfile() {
  const id = el.debugProfileSelect.value;
  return state.debugProfiles.find((p) => p.id === id) || null;
}

async function fetchPanelCompileContext(panel) {
  if (!state.project || !panel?.detail?.file || panel._compileCtx) return;
  try {
    panel._compileCtx = await api("/api/compile_context", {
      project: state.project,
      file: panel.detail.file,
    });
    updatePanelCompileUi(panel);
  } catch {
    panel._compileCtx = { available: false };
  }
}

function updatePanelCompileUi(panel) {
  const node = panel?.el;
  const ctx = panel?._compileCtx;
  if (!node || !ctx?.available) return;

  let strip = node.querySelector(".panel-compile");
  if (!strip) {
    strip = document.createElement("div");
    strip.className = "panel-compile hidden";
    const code = node.querySelector(".panel-code");
    node.insertBefore(strip, code || null);
  }

  const d = panel.detail;
  const compiled = ctx.direct_compiled;
  const tu = ctx.tu_file;
  const badgeCls = compiled ? "compile-badge" : tu ? "compile-badge hdr" : "compile-badge none";
  const badgeText = compiled ? "已编译 TU" : tu ? `头文件 · TU=${tu.split("/").pop()}` : "无编译信息";
  const macros = (ctx.defines || []).slice(0, 12);
  const more = (ctx.defines_total || 0) - macros.length;

  const dbgHint = ctx.debug_profile_name
    ? `<div class="compile-debug">GDB：${escapeHtml(ctx.debug_profile_name)}</div>`
    : "";

  strip.innerHTML =
    `<div class="compile-head">` +
    `<span class="${badgeCls}">${escapeHtml(badgeText)}</span>` +
    `<span class="compile-summary">${macros.length ? escapeHtml(macros.slice(0, 3).join("  ")) : "点击展开 -D 宏"}${more > 0 ? ` …+${more}` : ""}</span>` +
    `</div>` +
    `<div class="compile-body">` +
    dbgHint +
    (macros.length
      ? `<div class="compile-macros">${escapeHtml(macros.join("  "))}${more > 0 ? ` … 共 ${ctx.defines_total} 个 -D` : ""}</div>`
      : `<div class="compile-macros">（无 -D 或未匹配到翻译单元）</div>`) +
    `</div>`;
  strip.classList.remove("hidden");
  strip.querySelector(".compile-head").onclick = (e) => {
    e.stopPropagation();
    strip.classList.toggle("open");
  };

  let dot = node.querySelector(".panel-header .compile-dot");
  if (!dot) {
    dot = document.createElement("span");
    dot.className = "compile-dot";
    const header = node.querySelector(".panel-header");
    const fileSpan = header?.querySelector(".file");
    if (header && fileSpan) header.insertBefore(dot, fileSpan);
  }
  dot.textContent = compiled ? "●" : tu ? "◐" : "";
  dot.title = compiled
    ? `已编译：${tu || d.file}\n${(ctx.defines || []).slice(0, 8).join("\n")}`
    : tu
      ? `头文件，关联 TU：${tu}`
      : "未在 compile_commands 中找到对应翻译单元";
}

async function copyGdbBreak(file, line) {
  if (!state.project || !file || !line) return;
  try {
    const r = await api("/api/debug/break", {
      project: state.project,
      file,
      line,
      absolute: true,
    });
    await copyText(r.command);
  } catch (e) {
    toast("生成断点失败: " + e.message);
  }
}

async function exportGdbScript() {
  const profile = selectedDebugProfile();
  if (!profile) {
    toast("请先选择调试配置");
    el.debugProfileSelect.focus();
    return;
  }
  if (profile.needs_input) {
    toast("该配置含 ${input:...} 占位，请在 VS Code launch.json 中改用固定路径");
    return;
  }
  if (!state.order.length) {
    toast("当前没有调用树，无法导出断点");
    return;
  }
  const lines = [
    "# SmartCode Browser — GDB 脚本（粘贴到终端：gdb -x script.gdb）",
    `# 配置：${profile.name}`,
    `cd ${profile.cwd}`,
    `file ${profile.program}`,
  ];
  (profile.setup || []).forEach((cmd) => lines.push(cmd));
  for (const id of state.order) {
    const p = state.panels.get(id);
    if (!p?.detail) continue;
    try {
      const r = await api("/api/debug/break", {
        project: state.project,
        file: p.detail.file,
        line: p.detail.start_line,
        absolute: true,
      });
      lines.push(`# ${p.detail.name}`);
      lines.push(r.command);
    } catch {
      lines.push(`# break ${p.detail.file}:${p.detail.start_line}`);
    }
  }
  lines.push("run");
  await copyText(lines.join("\n"));
}

// ---------- 会话持久化（刷新/重启后自动恢复 + 命名标签） ----------

/** 把当前代码树序列化为可 JSON 存储的快照（只存定位信息，源码恢复时再拉取） */
function serializeState() {
  if (!state.project || !state.order.length) return null;
  const idToIdx = new Map();
  state.order.forEach((id, i) => idToIdx.set(id, i));
  return {
    v: 1,
    project: state.project,
    seq: state.seq,
    boardScroll: { left: el.board.scrollLeft, top: el.board.scrollTop },
    panels: state.order.map((id) => {
      const p = state.panels.get(id);
      const d = p.detail;
      return {
        file: d.file,
        name: d.name,
        line: d.start_line,
        parentIndex: p.parentId != null ? idToIdx.get(p.parentId) : -1,
        fromRef: p.fromRef,
        manualPos: p.manualPos || null,
        // 同一函数被多处引用时，额外来源边（不重复开面板）
        extraLinks: (p.extraLinks || []).map((l) => ({
          parentIndex: idToIdx.get(l.parentId),
          fromRef: l.fromRef,
        })).filter((l) => l.parentIndex >= 0),
      };
    }),
  };
}

let _persistTimer = null;
function schedulePersist() {
  if (state._restoring) return;
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    persistTreeNow(false);
  }, 350);
}

/** 立即写入会话 + 自动标签（关闭/清树前需 force=true） */
function persistTreeNow(force) {
  const snap = serializeState();
  if (snap) {
    localStorage.setItem(LS_SESSION, JSON.stringify(snap));
    syncAutoBookmark(snap);
  } else {
    localStorage.removeItem(LS_SESSION);
  }
  if (force) clearTimeout(_persistTimer);
}

function treeFingerprint(snap) {
  if (!snap?.panels?.length) return "";
  const root = snap.panels.find((p) => p.parentIndex < 0) || snap.panels[0];
  return `${snap.project}:${root.file}:${root.name}:${root.line}`;
}

function autoBookmarkDefaultName(snap) {
  const root = snap?.panels?.find((p) => p.parentIndex < 0) || snap?.panels?.[0];
  if (!root) return "代码树";
  const base = (root.file || "").split("/").pop() || root.file;
  const stem = base.replace(/\.(c|S|s|cpp|h)$/i, "");
  return `${root.name} · ${stem}`;
}

function findAutoBookmarkId(project, fingerprint) {
  const bookmarks = loadBookmarksStore();
  for (const [id, bm] of Object.entries(bookmarks)) {
    if (bm.auto && bm.fingerprint === fingerprint && bm.session?.project === project) {
      return id;
    }
  }
  return null;
}

/** 丢弃当前树的标签绑定（须在 flushTreeBeforeClear 之后调用） */
function resetBookmarkTracking() {
  state.autoBookmarkId = null;
  state.autoBookmarkName = null;
  state.manualBookmarkId = null;
  state.manualBookmarkLoaded = false;
}

function syncAutoBookmark(snap) {
  if (!snap?.panels?.length) return;
  const fp = treeFingerprint(snap);
  const bookmarks = loadBookmarksStore();

  // 仅从顶栏「手动标签」打开的树：编辑时写回该标签（自动标签仍单独维护）
  if (
    state.manualBookmarkLoaded &&
    state.manualBookmarkId &&
    bookmarks[state.manualBookmarkId] &&
    !bookmarks[state.manualBookmarkId].auto
  ) {
    const id = state.manualBookmarkId;
    const name = state.autoBookmarkName || bookmarks[id].name;
    bookmarks[id] = {
      ...bookmarks[id],
      name,
      savedAt: new Date().toISOString(),
      session: snap,
      fingerprint: fp,
    };
    saveBookmarksStore(bookmarks);
    state.autoBookmarkName = name;
    renderBookmarkList();
  }

  let id = state.autoBookmarkId;
  // 手动保存的书签 id 不能参与自动同步，否则会覆盖用户命名的标签
  if (id && bookmarks[id] && !bookmarks[id].auto) id = null;
  if (!id) id = findAutoBookmarkId(snap.project, fp);
  if (!id) id = "bm-auto-" + Date.now();
  const name =
    state.autoBookmarkName ||
    bookmarks[id]?.name ||
    autoBookmarkDefaultName(snap);
  bookmarks[id] = {
    name,
    savedAt: new Date().toISOString(),
    session: snap,
    auto: true,
    fingerprint: fp,
  };
  saveBookmarksStore(bookmarks);
  state.autoBookmarkId = id;
  if (!state.autoBookmarkName) state.autoBookmarkName = name;
  renderBookmarkList();
}

function loadBookmarksStore() {
  try {
    return JSON.parse(localStorage.getItem(LS_BOOKMARKS)) || {};
  } catch {
    return {};
  }
}

function saveBookmarksStore(bookmarks) {
  localStorage.setItem(LS_BOOKMARKS, JSON.stringify(bookmarks));
}

function defaultBookmarkName() {
  const root = state.order[0] && state.panels.get(state.order[0]);
  if (!root) return "";
  const d = root.detail;
  const n = state.order.length;
  return n > 1 ? `${d.name} (+${n - 1})` : d.name;
}

function renderBookmarkList() {
  const bookmarks = loadBookmarksStore();
  const entries = Object.entries(bookmarks).sort(
    (a, b) => (b[1].savedAt || "").localeCompare(a[1].savedAt || "")
  );
  el.bookmarkList.innerHTML = "";
  entries.forEach(([id, bm]) => {
    const pill = document.createElement("div");
    pill.className = "bookmark-pill" + (bm.auto ? " auto" : "");
    pill.title = `${bm.name}${bm.auto ? " · 自动同步" : ""}\n${bm.session?.panels?.length || 0} 个面板 · ${formatSavedAt(bm.savedAt)}`;
    pill.innerHTML =
      `<span class="bm-name">${escapeHtml(bm.name)}</span>` +
      `<span class="bm-del" title="删除标签">×</span>`;
    pill.querySelector(".bm-name").onclick = () => loadBookmark(id);
    pill.querySelector(".bm-del").onclick = (e) => {
      e.stopPropagation();
      deleteBookmark(id);
    };
    el.bookmarkList.appendChild(pill);
  });
}

function formatSavedAt(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function openBookmarkDialog() {
  const snap = serializeState();
  if (!snap) {
    toast("当前没有可保存的代码树，请先搜索并打开一个函数");
    return;
  }
  el.bookmarkNameInput.value =
    state.autoBookmarkName ||
    loadBookmarksStore()[state.autoBookmarkId]?.name ||
    loadBookmarksStore()[state.manualBookmarkId]?.name ||
    defaultBookmarkName();
  el.bookmarkDialog.classList.remove("hidden");
  el.bookmarkNameInput.focus();
  el.bookmarkNameInput.select();
}

function closeBookmarkDialog() {
  el.bookmarkDialog.classList.add("hidden");
}

function saveCurrentAsBookmark() {
  const name = el.bookmarkNameInput.value.trim();
  if (!name) {
    toast("请输入标签名称");
    el.bookmarkNameInput.focus();
    return;
  }
  const snap = serializeState();
  if (!snap) {
    toast("当前没有可保存的代码树");
    return;
  }
  const bookmarks = loadBookmarksStore();
  // 仅当从顶栏手动标签打开时更新原标签；否则每次「保存到标签」都新建一条
  const updatingManual =
    state.manualBookmarkLoaded &&
    state.manualBookmarkId &&
    bookmarks[state.manualBookmarkId] &&
    !bookmarks[state.manualBookmarkId].auto;
  const id = updatingManual ? state.manualBookmarkId : "bm-" + Date.now();
  bookmarks[id] = {
    name,
    savedAt: new Date().toISOString(),
    session: snap,
    auto: false,
    fingerprint: treeFingerprint(snap),
  };
  saveBookmarksStore(bookmarks);
  state.autoBookmarkName = name;
  state.manualBookmarkId = id;
  state.manualBookmarkLoaded = updatingManual;
  renderBookmarkList();
  closeBookmarkDialog();
  toast(updatingManual ? `已更新标签「${name}」` : `已保存新标签「${name}」`);
}

function deleteBookmark(id) {
  const bookmarks = loadBookmarksStore();
  const name = bookmarks[id]?.name || "标签";
  delete bookmarks[id];
  saveBookmarksStore(bookmarks);
  if (state.autoBookmarkId === id || state.manualBookmarkId === id) {
    resetBookmarkTracking();
  }
  renderBookmarkList();
  toast(`已删除「${name}」`);
}

async function loadBookmark(id) {
  const bm = loadBookmarksStore()[id];
  if (!bm?.session) return;
  const ok = await restoreSession(bm.session);
  if (ok) {
    state.autoBookmarkName = bm.name || null;
    if (bm.auto) {
      state.autoBookmarkId = id;
      state.manualBookmarkId = null;
      state.manualBookmarkLoaded = false;
    } else {
      state.autoBookmarkId = null;
      state.manualBookmarkId = id;
      state.manualBookmarkLoaded = true;
    }
    toast(`已打开标签「${bm.name}」`);
  } else if (bm.session?.panels?.length) {
    toast("标签恢复失败：部分符号可能已移动，请尝试重新搜索打开");
  }
}

async function restoreSession(snap) {
  if (!snap?.panels?.length) return false;
  state._restoring = true;
  try {
    const opt = el.projectSelect.querySelector(`option[value="${snap.project}"]`);
    if (!opt || opt.disabled) {
      toast("无法恢复：项目不存在或路径无效");
      return false;
    }
    el.projectSelect.value = snap.project;
    state.project = snap.project;
    clearAllPanels({ silent: true, skipSave: true });
    await refreshProjectStats(snap.project);

    state.seq = Math.max(state.seq, snap.seq || 0);
    const builtIds = [];
    let failCount = 0;

    for (const ps of snap.panels) {
      let detail = null;
      try {
        detail = await fetchSymbol(ps.file, ps.name, ps.line);
      } catch {
        try {
          detail = await api("/api/open_at", {
            project: snap.project,
            file: ps.file,
            line: ps.line,
          });
        } catch {
          detail = null;
        }
      }
      if (!detail?.lines?.length && detail?.file) {
        failCount++;
        continue;
      }
      if (!detail) {
        failCount++;
        continue;
      }

      const parentId =
        ps.parentIndex >= 0 && ps.parentIndex < builtIds.length
          ? builtIds[ps.parentIndex]
          : null;
      const id = insertPanel(detail, parentId, ps.fromRef || null, "p" + state.seq++);
      if (ps.manualPos) state.panels.get(id).manualPos = ps.manualPos;
      builtIds.push(id);
    }

    if (!builtIds.length) {
      toast(`标签恢复失败：${failCount} 个面板无法加载（符号或行号可能已变化）`);
      return false;
    }
    if (failCount) {
      toast(`已恢复 ${builtIds.length} 个面板，${failCount} 个跳过`);
    }

    snap.panels.forEach((ps, i) => {
      if (!ps.extraLinks?.length) return;
      const targetId = builtIds[i];
      if (!targetId) return;
      for (const xl of ps.extraLinks) {
        const parentId = builtIds[xl.parentIndex];
        if (parentId) linkPanelFrom(parentId, xl.fromRef, targetId, { silent: true });
      }
    });

    render();
    if (builtIds.length) focusPanel(builtIds[builtIds.length - 1]);
    requestAnimationFrame(() => {
      if (snap.boardScroll) {
        el.board.scrollLeft = snap.boardScroll.left || 0;
        el.board.scrollTop = snap.boardScroll.top || 0;
      }
      schedule(true);
    });
    attachBookmarkTrackingForSnap(snap);
    schedulePersist();
    await loadDebugProfiles(snap.project);
    return true;
  } catch (e) {
    toast("恢复失败: " + e.message);
    clearAllPanels({ silent: true, skipSave: true });
    return false;
  } finally {
    state._restoring = false;
  }
}

/** 刷新/会话恢复后，把当前树关联到已有的 auto 标签（若存在） */
function attachBookmarkTrackingForSnap(snap) {
  if (!snap?.panels?.length) return;
  const fp = treeFingerprint(snap);
  const bookmarks = loadBookmarksStore();
  const autoId = findAutoBookmarkId(snap.project, fp);
  if (!autoId) return;
  state.autoBookmarkId = autoId;
  state.manualBookmarkId = null;
  state.manualBookmarkLoaded = false;
  if (!state.autoBookmarkName) {
    state.autoBookmarkName = bookmarks[autoId]?.name || null;
  }
}

async function tryRestoreLastSession(projects) {
  let raw;
  try {
    raw = localStorage.getItem(LS_SESSION);
  } catch {
    return false;
  }
  if (!raw) return false;
  let snap;
  try {
    snap = JSON.parse(raw);
  } catch {
    return false;
  }
  const proj = projects.find((p) => p.id === snap.project && p.exists);
  if (!proj) return false;
  return restoreSession(snap);
}

// ---------- 项目 ----------

async function loadProjects() {
  const projects = await api("/api/projects");
  el.projectSelect.innerHTML = "";
  projects.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.exists ? p.name : `${p.name}（路径不存在）`;
    opt.disabled = !p.exists;
    el.projectSelect.appendChild(opt);
  });
  renderBookmarkList();
  await loadAiConfig();

  // 优先恢复上次浏览的代码树；无记录时再选默认项目
  const restored = await tryRestoreLastSession(projects);
  if (!restored) {
    const firstOk = projects.find((p) => p.exists);
    if (firstOk) {
      el.projectSelect.value = firstOk.id;
      await setProject(firstOk.id);
    }
  }
}

async function refreshProjectStats(id) {
  el.stats.textContent = "索引中…";
  try {
    const s = await api("/api/stats", { project: id });
    el.stats.textContent = `${s.files_indexed} 文件 · ${s.symbols} 符号` +
      (s.from_cache ? " · 缓存" : "") +
      (s.truncated ? " · 已截断" : "") +
      (s.compile_db ? ` · 编译库 ${s.compile_db}` : "");
  } catch (e) {
    el.stats.textContent = "索引失败: " + e.message;
  }
}

async function setProject(id) {
  await flushTreeBeforeClear();
  resetBookmarkTracking();
  state.project = id;
  clearAllPanels({ silent: true, skipSave: true });
  await Promise.all([refreshProjectStats(id), loadDebugProfiles(id)]);
}

// ---------- 搜索 ----------

/** 与后端 index.parse_search_query 一致：in:/@ 路径过滤 + 符号名 */
function parseSearchQuery(query) {
  const q = query.trim();
  if (!q) return { pathFilter: null, nameQ: "" };
  const low = q.toLowerCase();
  if (low.startsWith("in:") || q.startsWith("@")) {
    const prefixLen = low.startsWith("in:") ? 3 : 1;
    const rest = q.slice(prefixLen).trimStart();
    if (!rest) return { pathFilter: null, nameQ: "" };
    if (rest.includes(" ")) {
      const sp = rest.indexOf(" ");
      return { pathFilter: rest.slice(0, sp).trim(), nameQ: rest.slice(sp + 1).trim() };
    }
    return { pathFilter: rest, nameQ: "" };
  }
  return { pathFilter: null, nameQ: q };
}

function fileMatchesPath(rel, pathFilter) {
  const r = rel.replace(/\\/g, "/");
  const p = pathFilter.replace(/\\/g, "/").trim();
  if (!p) return true;
  const rl = r.toLowerCase();
  const pl = p.toLowerCase();
  if (p.endsWith("/")) {
    const prefix = pl.replace(/\/$/, "") + "/";
    return rl.startsWith(prefix) || rl.includes("/" + prefix);
  }
  return rl.includes(pl);
}

function setSearchMode(mode) {
  state.searchMode = mode;
  el.searchMode?.querySelectorAll(".search-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  const ph = mode === "use"
    ? "调用：read 或 in:fs/ read（结果内可再筛目录）"
    : "符号定义：符号名 或 in:nemu/ main";
  el.searchInput.placeholder = ph;
  const q = el.searchInput.value.trim();
  if (q) runSearch(q);
}

let searchTimer = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  const q = el.searchInput.value.trim();
  if (!q) { el.searchResults.classList.add("hidden"); return; }
  searchTimer = setTimeout(() => runSearch(q), 200);
}

function appendSearchFoot(hasTree) {
  if (!hasTree) return;
  const foot = document.createElement("div");
  foot.className = "search-foot";
  foot.textContent = "点击：新开根节点（与现有树并列） · Shift+点击：挂到当前面板 · Ctrl+点击：替换整棵树";
  el.searchResults.appendChild(foot);
}

/** 拉取用法列表；path 传给后端收窄 grep 范围（常见名如 read 必备） */
async function fetchUsages(name, pathFilter, limit = 500) {
  const params = { project: state.project, name, limit };
  if (pathFilter) params.path = pathFilter;
  return api("/api/usages", params);
}

function buildUsageRow(nameQ, u, onPick) {
  const row = document.createElement("div");
  row.className = "item usage-item";
  row.innerHTML =
    `<span class="nm">${escapeHtml(nameQ)}</span>` +
    `<span class="tag-use">调用</span>` +
    `<span class="loc">${escapeHtml(u.file)}:${u.line}` +
    (u.enclosing ? ` <span class="kind">in ${escapeHtml(u.enclosing)}</span>` : "") +
    `</span>` +
    (u.text ? `<div class="snip">${escapeHtml(u.text)}</div>` : "");
  row.onclick = onPick;
  return row;
}

function buildUsagePopRow(u, onPick) {
  const row = document.createElement("div");
  row.className = "usage-row";
  row.innerHTML =
    `<div class="u-loc">${escapeHtml(u.file)}:${u.line}` +
    (u.enclosing ? ` <span class="u-in">in ${escapeHtml(u.enclosing)}</span>` : "") +
    `</div><div class="u-snip">${escapeHtml(u.text)}</div>`;
  row.onclick = onPick;
  return row;
}

/** 用法结果顶栏：目录过滤（在结果内收窄，避免 read 等常见名刷屏） */
function mountUsagePathFilter(container, ctx) {
  const bar = document.createElement("div");
  bar.className = "usage-filter-bar";
  bar.innerHTML =
    `<span class="usage-filter-lbl">目录</span>` +
    `<input class="usage-path-input" type="text" placeholder="如 fs/ drivers/mmc （/ 结尾仅该目录）" />` +
    `<span class="usage-filter-cnt"></span>`;
  const input = bar.querySelector(".usage-path-input");
  input.value = ctx.pathFilter || "";
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => e.stopPropagation());
  let timer = null;
  input.addEventListener("input", () => {
    ctx.pathFilter = input.value.trim();
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const cntEl = bar.querySelector(".usage-filter-cnt");
      if (cntEl) cntEl.textContent = "…";
      try {
        ctx.list = await fetchUsages(ctx.name, ctx.pathFilter);
        ctx.onUpdate();
      } catch (e) {
        toast("过滤失败: " + e.message);
      }
    }, 280);
  });
  container.appendChild(bar);
  ctx.filterBar = bar;
  return bar;
}

function updateUsageFilterCount(ctx) {
  const cntEl = ctx.filterBar?.querySelector(".usage-filter-cnt");
  if (!cntEl) return;
  const total = ctx.list.length;
  const cap = ctx.displayLimit || 40;
  const shown = Math.min(total, cap);
  cntEl.textContent = total > shown ? `${shown}/${total} 条` : `${total} 条`;
}

function renderUsageSearchResults(nameQ, list, initialPathFilter) {
  el.searchResults.innerHTML = "";
  const ctx = {
    name: nameQ,
    list,
    pathFilter: initialPathFilter || "",
    displayLimit: 40,
    filterBar: null,
    onUpdate: () => renderUsageSearchBody(ctx),
  };

  mountUsagePathFilter(el.searchResults, ctx);
  const body = document.createElement("div");
  body.className = "usage-result-list";
  el.searchResults.appendChild(body);
  ctx.bodyEl = body;

  renderUsageSearchBody(ctx);
  appendSearchFoot(state.order.length > 0);
  el.searchResults.classList.remove("hidden");
}

function renderUsageSearchBody(ctx) {
  const body = ctx.bodyEl;
  if (!body) return;
  body.innerHTML = "";
  updateUsageFilterCount(ctx);
  if (!ctx.list.length) {
    body.innerHTML = `<div class="item">${ctx.pathFilter ? "该目录下无调用" : `未找到 ${escapeHtml(ctx.name)} 的调用`}</div>`;
    return;
  }
  ctx.list.slice(0, ctx.displayLimit).forEach((u) => {
    body.appendChild(buildUsageRow(ctx.name, u, (e) => {
      el.searchResults.classList.add("hidden");
      el.searchInput.value = "";
      openFromSearch({ kind: "usage", name: ctx.name, usage: u }, e);
    }));
  });
}

async function runSearch(q) {
  if (!state.project) return;
  const { pathFilter, nameQ } = parseSearchQuery(q);

  if (state.searchMode === "use") {
    if (!nameQ) {
      el.searchResults.innerHTML =
        `<div class="item">${pathFilter ? "调用搜索需写符号名，如 in:fs/ read" : "输入要查找的调用/引用符号名"}</div>`;
      el.searchResults.classList.remove("hidden");
      return;
    }
    el.searchResults.innerHTML = `<div class="item">查找 ${escapeHtml(nameQ)} 的调用…</div>`;
    el.searchResults.classList.remove("hidden");
    try {
      const list = await fetchUsages(nameQ, pathFilter || null);
      renderUsageSearchResults(nameQ, list, pathFilter || "");
    } catch (e) { toast("查找调用失败: " + e.message); }
    return;
  }

  el.searchResults.innerHTML = "";
  try {
    results = await api("/api/search", { project: state.project, q, limit: 40 });
  } catch (e) { toast("搜索失败: " + e.message); return; }

  if (!results.length) {
    const hint = /^(?:in:|@)/i.test(q)
      ? "无匹配定义（检查路径是否在已索引文件内）"
      : "无匹配符号定义";
    el.searchResults.innerHTML = `<div class="item">${hint}</div>`;
  } else {
    results.forEach((r) => {
      const div = document.createElement("div");
      div.className = "item";
      div.innerHTML =
        `<span class="nm">${escapeHtml(r.name)}</span>` +
        `<span class="kind">${escapeHtml(r.kind)}</span>` +
        `<span class="loc">${escapeHtml(r.file)}:${r.start_line}</span>`;
      div.onclick = (e) => {
        el.searchResults.classList.add("hidden");
        el.searchInput.value = "";
        openFromSearch({ kind: "def", result: r }, e);
      };
      el.searchResults.appendChild(div);
    });
    appendSearchFoot(state.order.length > 0);
  }
  el.searchResults.classList.remove("hidden");
}

/** 在父面板代码中定位符号，作为搜索连线的来源锚点 */
function makeSearchFromRef(parentPanel, symbolName) {
  const d = parentPanel.detail;
  const re = new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  for (let i = 0; i < d.lines.length; i++) {
    const m = re.exec(d.lines[i]);
    if (m) {
      return {
        name: symbolName,
        line: d.start_line + i,
        col: m.index + 1,
        refKind: "search",
      };
    }
  }
  return {
    name: symbolName,
    line: d.start_line,
    col: 1,
    refKind: "search",
  };
}

function getSearchAttachParent() {
  if (state.focusedPanelId && state.panels.has(state.focusedPanelId)) {
    return state.focusedPanelId;
  }
  if (state.order.length) return state.order[state.order.length - 1];
  return null;
}

async function openFromSearch(item, ev) {
  const shift = !!(ev && ev.shiftKey);
  const replace = !!(ev && (ev.ctrlKey || ev.metaKey));
  const attach = shift && !replace && state.order.length > 0;

  if (replace) {
    if (item.kind === "usage") await openRootUsage(item.name, item.usage);
    else {
      const r = item.result;
      await openRoot(r.file, r.name, r.start_line);
    }
    return;
  }
  if (attach) {
    const parentId = getSearchAttachParent();
    if (item.kind === "usage") await openSearchUsage(parentId, item.name, item.usage);
    else await openSearchDefinition(parentId, item.result);
    return;
  }
  // 默认：追加新根节点，与已有树并列（不清空）
  if (item.kind === "usage") await appendRootUsage(item.name, item.usage);
  else {
    const r = item.result;
    await appendRoot(r.file, r.name, r.start_line);
  }
}

async function openSearchDefinition(parentId, result) {
  try {
    const detail = await fetchSymbol(result.file, result.name, result.start_line);
    const parent = state.panels.get(parentId);
    const searchRef = makeSearchFromRef(parent, result.name);
    openPanelFrom(parentId, searchRef, detail);
  } catch (e) { toast("打开失败: " + e.message); }
}

async function openSearchUsage(parentId, symbolName, usage) {
  try {
    const detail = await api("/api/open_at", {
      project: state.project, file: usage.file, line: usage.line,
    });
    if (!detail) { toast("无法打开该调用位置"); return; }
    const parent = state.panels.get(parentId);
    if (parent?.detail && symbolKey(parent.detail) === symbolKey(detail)) {
      flashLine(parentId, usage.line);
      focusPanel(parentId);
      return;
    }
    const defRef = makeSearchFromRef(parent, symbolName);
    const usageRef = makeUsageFromRef(defRef, usage);
    const id = openPanelFrom(parentId, usageRef, detail);
    setTimeout(() => flashLine(id, usage.line), 120);
  } catch (e) { toast("打开失败: " + e.message); }
}

async function appendRootUsage(symbolName, usage) {
  try {
    const detail = await api("/api/open_at", {
      project: state.project, file: usage.file, line: usage.line,
    });
    if (!detail) { toast("无法打开该调用位置"); return; }
    const id = addPanel(detail, null, null);
    setTimeout(() => flashLine(id, usage.line), 120);
    await autoSelectDebugProfile(usage.file);
  } catch (e) { toast("打开失败: " + e.message); }
}

/** 替换整棵树：仅 Ctrl+搜索 或显式 openRoot 时使用 */
async function openRootUsage(symbolName, usage) {
  await flushTreeBeforeClear();
  resetBookmarkTracking();
  clearAllPanels({ silent: true, skipSave: true });
  try {
    const detail = await api("/api/open_at", {
      project: state.project, file: usage.file, line: usage.line,
    });
    if (!detail) { toast("无法打开该调用位置"); return; }
    const id = addPanel(detail, null, null);
    setTimeout(() => flashLine(id, usage.line), 120);
  } catch (e) { toast("打开失败: " + e.message); }
}

// ---------- 打开符号 / 级联 ----------

async function fetchSymbol(file, name, line) {
  return api("/api/symbol", { project: state.project, file, name, line });
}

function ensureAutoBookmarkOnRoot() {
  if (state._restoring) return;
  if (!state.project || !state.order.length) return;
  const roots = state.order.filter((id) => !state.panels.get(id)?.parentId);
  if (roots.length !== 1) return;
  const snap = serializeState();
  if (!snap) return;
  syncAutoBookmark(snap);
}

// 追加新根（不清空已有调用树）
async function appendRoot(file, name, line) {
  try {
    const detail = await fetchSymbol(file, name, line);
    addPanel(detail, null, null);
    ensureAutoBookmarkOnRoot();
    await autoSelectDebugProfile(file);
  } catch (e) { toast("打开失败: " + e.message); }
}

// 打开为根并清空现有树（Ctrl+搜索）
async function openRoot(file, name, line) {
  await flushTreeBeforeClear();
  resetBookmarkTracking();
  clearAllPanels({ silent: true, skipSave: true });
  try {
    const detail = await fetchSymbol(file, name, line);
    addPanel(detail, null, null);
    ensureAutoBookmarkOnRoot();
    await autoSelectDebugProfile(file);
  } catch (e) { toast("打开失败: " + e.message); }
}

// parentId: 来源面板；fromRef: 来源引用（用于父面板高亮）
function insertPanel(detail, parentId, fromRef, id) {
  const parent = parentId ? state.panels.get(parentId) : null;
  const panel = {
    id,
    detail,
    parentId,
    fromRef,
    depth: parent ? parent.depth + 1 : 0,
  };
  state.panels.set(id, panel);
  state.order.push(id);
  // 函数指针成员调用可多次展开不同目标，不占用 childByRef（避免再次点击只聚焦）
  if (parent && fromRef && fromRef.refKind !== "member") {
    parent.childByRef = parent.childByRef || {};
    parent.childByRef[refKey(fromRef)] = id;
  }
  return id;
}

function addPanel(detail, parentId, fromRef) {
  const id = insertPanel(detail, parentId, fromRef, "p" + state.seq++);
  state.focusNew = id;
  render();
  schedulePersist();
  ensureAutoBookmarkOnRoot();
  return id;
}

function refKey(ref) { return `${ref.name}@${ref.line}:${ref.col}`; }

/** 符号唯一键：同一定义只保留一个面板（多入口跳转/查用法时复用） */
function symbolKey(detail) {
  const fnLike = new Set(["function", "method", "constructor", "macro"]);
  // 函数/宏：同文件同名即同一符号（避免 ERROR 节点与正常解析 start_line 差 1～2 行导致重复面板）
  if (detail.kind && fnLike.has(detail.kind) && detail.name) {
    return `${detail.file}:${detail.name}`;
  }
  return `${detail.file}:${detail.start_line}`;
}

function findPanelBySymbol(detail) {
  const key = symbolKey(detail);
  for (const id of state.order) {
    const p = state.panels.get(id);
    if (p?.detail && symbolKey(p.detail) === key) return id;
  }
  return null;
}

/** 面板的所有入边（主父链 + 复用时的额外来源） */
function panelLinks(panel) {
  const links = [];
  if (panel.parentId && panel.fromRef) {
    links.push({ parentId: panel.parentId, fromRef: panel.fromRef });
  }
  if (panel.extraLinks) links.push(...panel.extraLinks);
  return links;
}

/**
 * 把 parent 的某次点击关联到已有面板（不新建重复面板）。
 * 主父链不变；额外来源记入 extraLinks，decorate 会画多条箭头。
 */
function linkPanelFrom(parentId, fromRef, targetId, opts = {}) {
  const parent = state.panels.get(parentId);
  const target = state.panels.get(targetId);
  if (!parent || !target || parentId === targetId) return false;
  const rk = refKey(fromRef);
  parent.childByRef = parent.childByRef || {};
  if (parent.childByRef[rk] === targetId) return true;
  parent.childByRef[rk] = targetId;
  const isPrimary =
    target.parentId === parentId &&
    target.fromRef && refKey(target.fromRef) === rk;
  if (!isPrimary) {
    target.extraLinks = target.extraLinks || [];
    const dup = target.extraLinks.some(
      (l) => l.parentId === parentId && refKey(l.fromRef) === rk
    );
    if (!dup) target.extraLinks.push({ parentId, fromRef });
  }
  if (!opts.silent) {
    state.focusNew = targetId;
    render();
    schedulePersist();
  }
  return true;
}

// ---------- 切换箭头来源（A→B 改为 C→B） ----------

function panelDescendants(panelId) {
  const out = new Set();
  const walk = (pid) => {
    for (const cid of state.order) {
      const p = state.panels.get(cid);
      if (p?.parentId === pid) {
        out.add(cid);
        walk(cid);
      }
    }
  };
  walk(panelId);
  return out;
}

function canReparentTo(targetId, newParentId) {
  if (!targetId || !newParentId || targetId === newParentId) return false;
  return !panelDescendants(targetId).has(newParentId);
}

function fromRefFromTokenEl(el) {
  return {
    name: el.dataset.name,
    line: parseInt(el.dataset.line, 10),
    col: parseInt(el.dataset.col, 10),
    receiver: el.dataset.receiver || "",
    refKind: el.dataset.refKind || (el.classList.contains("ref") ? "call" : "reference"),
  };
}

/** 在父面板里找与子函数名最匹配的调用点（快速绑定时用） */
function findBestRefInPanel(parentPanel, childName) {
  const d = parentPanel.detail;
  const refs = d.references || [];
  const hit = refs.find((r) => r.name === childName);
  if (hit) {
    return {
      name: hit.name,
      line: hit.line,
      col: hit.col,
      receiver: hit.receiver || "",
      refKind: hit.ref_kind || "call",
    };
  }
  if (refs.length) {
    const r = refs[0];
    return {
      name: r.name,
      line: r.line,
      col: r.col,
      receiver: r.receiver || "",
      refKind: r.ref_kind || "call",
    };
  }
  return {
    name: childName,
    line: d.start_line,
    col: 1,
    refKind: "correlation",
  };
}

function unlinkPrimaryParent(target) {
  const oldParentId = target.parentId;
  const oldRef = target.fromRef;
  if (!oldParentId || !oldRef) return;
  const oldParent = state.panels.get(oldParentId);
  if (!oldParent?.childByRef) return;
  const rk = refKey(oldRef);
  if (oldParent.childByRef[rk] === target.id) delete oldParent.childByRef[rk];
}

function recalculateDepth(panelId) {
  const panel = state.panels.get(panelId);
  if (!panel) return;
  const parent = panel.parentId ? state.panels.get(panel.parentId) : null;
  panel.depth = parent ? parent.depth + 1 : 0;
  for (const id of state.order) {
    const p = state.panels.get(id);
    if (p?.parentId === panelId) recalculateDepth(id);
  }
}

function reparentPanel(targetId, newParentId, fromRef) {
  const target = state.panels.get(targetId);
  const newParent = state.panels.get(newParentId);
  if (!target || !newParent || !canReparentTo(targetId, newParentId)) return false;

  const rk = refKey(fromRef);
  if (target.extraLinks) {
    target.extraLinks = target.extraLinks.filter(
      (l) => !(l.parentId === newParentId && refKey(l.fromRef) === rk)
    );
  }

  unlinkPrimaryParent(target);
  target.parentId = newParentId;
  target.fromRef = fromRef;
  target.manualPos = null;

  if (fromRef.refKind !== "member") {
    newParent.childByRef = newParent.childByRef || {};
    newParent.childByRef[rk] = targetId;
  }

  recalculateDepth(targetId);
  state.focusNew = targetId;
  render();
  schedulePersist();
  toast(`箭头来源已改为 ${newParent.detail.name} → ${target.detail.name}`);
  return true;
}

function cancelReparentMode() {
  if (!state.reparentTargetId) return;
  state.reparentTargetId = null;
  document.body.classList.remove("reparent-mode");
  document.querySelectorAll(".panel.reparent-target, .panel.reparent-candidate").forEach((n) => {
    n.classList.remove("reparent-target", "reparent-candidate");
  });
}

function startReparentMode(panelId) {
  const panel = state.panels.get(panelId);
  if (!panel?.parentId) {
    toast("根面板没有箭头来源");
    return;
  }
  cancelReparentMode();
  state.reparentTargetId = panelId;
  document.body.classList.add("reparent-mode");
  for (const id of state.order) {
    const el = state.panels.get(id)?.el;
    if (!el) continue;
    if (id === panelId) el.classList.add("reparent-target");
    else if (canReparentTo(panelId, id)) el.classList.add("reparent-candidate");
  }
  toast("点击其他面板中的蓝色调用处切换来源；点候选面板标题可快速绑定（Esc 取消）");
}

function tryReparentFromToken(sourcePanelId, tokenEl) {
  const targetId = state.reparentTargetId;
  if (!targetId || sourcePanelId === targetId) return false;
  if (!canReparentTo(targetId, sourcePanelId)) {
    toast("不能指向自身或子面板");
    return true;
  }
  reparentPanel(targetId, sourcePanelId, fromRefFromTokenEl(tokenEl));
  cancelReparentMode();
  return true;
}

function tryReparentFromHeader(sourcePanelId) {
  const targetId = state.reparentTargetId;
  if (!targetId || sourcePanelId === targetId) return;
  if (!canReparentTo(targetId, sourcePanelId)) return;
  const target = state.panels.get(targetId);
  const parent = state.panels.get(sourcePanelId);
  if (!target || !parent) return;
  reparentPanel(targetId, sourcePanelId, findBestRefInPanel(parent, target.detail.name));
  cancelReparentMode();
}

// 关闭面板及其所有后代
function closePanel(id) {
  if (state.reparentTargetId === id) cancelReparentMode();
  const toRemove = new Set();
  const collect = (pid) => {
    toRemove.add(pid);
    for (const cid of state.order) {
      const p = state.panels.get(cid);
      if (p && p.parentId === pid) collect(cid);
    }
  };
  collect(id);
  // 清理 childByRef / extraLinks 中对被删面板的引用
  for (const pid of state.order) {
    if (toRemove.has(pid)) continue;
    const p = state.panels.get(pid);
    if (p.childByRef) {
      for (const [k, v] of Object.entries(p.childByRef)) {
        if (toRemove.has(v)) delete p.childByRef[k];
      }
    }
    if (p.extraLinks) {
      p.extraLinks = p.extraLinks.filter((l) => !toRemove.has(l.parentId));
    }
  }
  state.order = state.order.filter((pid) => !toRemove.has(pid));
  toRemove.forEach((pid) => state.panels.delete(pid));
  render();
  schedulePersist();
  if (!state.order.length) {
    resetBookmarkTracking();
    persistTreeNow(true);
  }
}

function clearAllPanels(opts = {}) {
  cancelReparentMode();
  if (!opts.skipSave && !opts.silent && state.order.length) {
    persistTreeNow(true);
  }
  state.panels.clear();
  state.order = [];
  state.seq = 0;
  state.focusedPanelId = null;
  render();
  if (!opts.silent) schedulePersist();
}

async function flushTreeBeforeClear() {
  if (!state.order.length) return;
  persistTreeNow(true);
}

// 点击任意 token：
//  - 普通点击：调用(.ref)走函数解析；变量(.tok)走 resolve_at（局部声明优先）
//  - Alt/Ctrl/Meta 或右键：查找该标识符的所有用法
async function navFromToken(panelId, el, ev) {
  if (state.reparentTargetId) {
    tryReparentFromToken(panelId, el);
    return;
  }
  const panel = state.panels.get(panelId);
  const name = el.dataset.name;
  const line = parseInt(el.dataset.line, 10);
  const col = parseInt(el.dataset.col, 10);
  // refKind 决定连线颜色与方向：call / reference / member / usage / search
  const fromRef = {
    name, line, col,
    receiver: el.dataset.receiver || "",
    refKind: el.dataset.refKind || (el.classList.contains("ref") ? "call" : "reference"),
  };
  const isMemberFp = fromRef.refKind === "member";

  if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.type === "contextmenu") {
    return openUsages(panelId, fromRef, el);
  }

  // 同一来源已展开 → 聚焦（函数指针成员调用除外：可多次展开不同 handler）
  if (!isMemberFp) {
    const existingId = panel.childByRef && panel.childByRef[refKey(fromRef)];
    if (existingId && state.panels.has(existingId)) { focusPanel(existingId); return; }
  }

  let cands = [];
  try {
    if (el.classList.contains("ref")) {
      const receiver = el.dataset.receiver || "";
      if (receiver && el.dataset.refKind === "member") {
        cands = await api("/api/resolve_call", {
          project: state.project,
          file: panel.detail.file,
          name,
          line,
          col,
          receiver,
        });
      } else {
        cands = await api("/api/resolve", {
          project: state.project, name, from_file: panel.detail.file,
        });
      }
    } else {
      cands = await api("/api/resolve_at", {
        project: state.project, file: panel.detail.file, name, line, col,
      });
    }
  } catch (e) { toast("解析失败: " + e.message); return; }

  if (!cands.length) {
    toast(`无法解析 ${name}（外部库/宏/未声明，或仅在更外层作用域）`);
    return;
  }
  if (cands.length === 1 && !isMemberFp) {
    await openCandidate(panelId, fromRef, cands[0], ev.shiftKey);
  } else if (cands.length >= 1) {
    showCandidateMenu(panelId, fromRef, el, cands);
  }
}

/**
 * 从 parent 打开 detail：若树上已有同符号面板则复用并追加连线，避免多入口各开一份。
 * 函数指针成员调用、Shift 强制新开时仍允许重复面板。
 */
function openPanelFrom(parentId, fromRef, detail, opts = {}) {
  const memberFp = opts.memberFp || fromRef.refKind === "member";
  if (!opts.forceNew && !memberFp) {
    const existingId = findPanelBySymbol(detail);
    if (existingId && existingId !== parentId) {
      linkPanelFrom(parentId, fromRef, existingId, opts);
      return existingId;
    }
  }
  return addPanel(detail, parentId, fromRef);
}

async function openCandidate(panelId, ref, cand, forceNew = false) {
  // 局部变量声明：就在当前函数面板内，闪烁定位即可，不另开面板
  if (cand.kind === "local") {
    flashLine(panelId, cand.line);
    return;
  }
  const memberFp = ref.refKind === "member";
  try {
    const detail = await fetchSymbol(cand.file, cand.name, cand.line);
    if (!detail) { toast("目标源码不可读"); return; }
    openPanelFrom(panelId, ref, detail, { forceNew, memberFp });
  } catch (e) { toast("展开失败: " + e.message); }
}

// 查找用法 → 弹出浮动列表（含目录过滤）
async function openUsages(panelId, fromRef, anchorEl) {
  closeUsagesPop();
  closeCandidateMenu();
  const pop = document.createElement("div");
  pop.id = "usages-pop";
  pop.className = "usages-pop";

  const head = document.createElement("div");
  head.className = "usages-pop-head";
  head.innerHTML =
    `<span>⤢ 用法: ${escapeHtml(fromRef.name)}</span>` +
    `<span class="cnt">…</span><span class="x">×</span>`;
  head.querySelector(".x").onclick = closeUsagesPop;
  pop.appendChild(head);

  const filterSlot = document.createElement("div");
  pop.appendChild(filterSlot);

  const body = document.createElement("div");
  body.className = "usages-pop-body";
  pop.appendChild(body);
  document.body.appendChild(pop);

  const ctx = {
    name: fromRef.name,
    list: [],
    pathFilter: "",
    displayLimit: 80,
    filterBar: null,
    bodyEl: body,
    originPanelId: panelId,
    fromRef,
    headCnt: head.querySelector(".cnt"),
    onUpdate: () => renderUsagesPopBody(ctx),
  };
  mountUsagePathFilter(filterSlot, ctx);

  const rect = anchorEl ? anchorEl.getBoundingClientRect() : { left: 100, bottom: 100 };
  const popW = 460;
  let left = rect.left;
  if (left + popW > window.innerWidth) left = window.innerWidth - popW - 12;
  pop.style.left = Math.max(8, left) + "px";
  pop.style.top = (rect.bottom + 6) + "px";

  setTimeout(() => {
    document.addEventListener("click", onDocCloseUsages, true);
    document.addEventListener("keydown", onEscCloseUsages);
  }, 0);

  try {
    ctx.list = await fetchUsages(fromRef.name, null);
    ctx.onUpdate();
  } catch (e) {
    toast("查找用法失败: " + e.message);
    closeUsagesPop();
  }
}

function renderUsagesPopBody(ctx) {
  const body = ctx.bodyEl;
  body.innerHTML = "";
  updateUsageFilterCount(ctx);
  if (ctx.headCnt) {
    ctx.headCnt.textContent = String(ctx.list.length);
  }
  if (!ctx.list.length) {
    body.innerHTML = `<div class="usage-row">${ctx.pathFilter ? "该目录下无用法" : "未找到使用位置"}</div>`;
    return;
  }
  ctx.list.slice(0, ctx.displayLimit).forEach((u) => {
    body.appendChild(buildUsagePopRow(u, (e) => {
      e.stopPropagation();
      openUsageRow(ctx.originPanelId, ctx.fromRef, u);
    }));
  });
}

function closeUsagesPop() {
  const m = document.getElementById("usages-pop");
  if (m) m.remove();
}

function onDocCloseUsages(e) {
  const pop = document.getElementById("usages-pop");
  if (pop && !pop.contains(e.target)) {
    closeUsagesPop();
    document.removeEventListener("click", onDocCloseUsages, true);
    document.removeEventListener("keydown", onEscCloseUsages);
  }
}
function onEscCloseUsages(e) {
  if (e.key === "Escape") {
    closeUsagesPop();
    document.removeEventListener("click", onDocCloseUsages, true);
    document.removeEventListener("keydown", onEscCloseUsages);
  }
}

// 点击用法行 → 打开所属函数/宏（或行上下文）并闪烁用法行
// 用法连线：子面板内用法 token → 父面板定义（箭头指向定义，与「顺调用链」相反）
async function openUsageRow(originPanelId, fromRef, u) {
  closeUsagesPop();
  try {
    const detail = await api("/api/open_at", {
      project: state.project, file: u.file, line: u.line,
    });
    if (!detail) { toast("无法打开该用法位置"); return; }
    const usageRef = makeUsageFromRef(fromRef, u);
    const id = openPanelFrom(originPanelId, usageRef, detail);
    setTimeout(() => flashLine(id, u.line), 120);
  } catch (e) { toast("打开失败: " + e.message); }
}

// 在指定面板内闪烁某一行（用于「跳到声明/用法」的同面板定位）
function flashLine(panelId, lineNo) {
  const panel = state.panels.get(panelId);
  const node = panel && panel.el;
  if (!node || !panel.detail) return;
  const idx = lineNo - panel.detail.start_line;
  const lines = node.querySelectorAll(".code-line");
  if (idx < 0 || idx >= lines.length) return;
  const lineEl = lines[idx];
  lineEl.classList.add("flash");
  lineEl.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => lineEl.classList.remove("flash"), 1600);
}

function showCandidateMenu(panelId, ref, anchorEl, candidates) {
  closeCandidateMenu();
  const menu = document.createElement("div");
  menu.className = "cand-menu";
  menu.id = "cand-menu";
  const recv = anchorEl.dataset.receiver;
  if (recv && candidates.length > 1) {
    const head = document.createElement("div");
    head.className = "cand-menu-head";
    head.textContent = `${recv} · ${ref.name}（${candidates.length} 个实现，表项可能在其它 .c）`;
    menu.appendChild(head);
  }
  candidates.forEach((c) => {
    const item = document.createElement("div");
    item.className = "citem";
    // 空实现/桩明确标注，提示用户「真正的实现」通常排在最上
    const tag = c.empty ? `<span class="stub-tag">空实现</span>` : "";
    const kindTag = `<span class="kind-tag">${escapeHtml(c.kind)}</span>`;
    item.innerHTML =
      `<span>${escapeHtml(c.name)}</span>${kindTag}${tag}` +
      `<span class="cf">${escapeHtml(c.file)}:${c.line}</span>`;
    item.onclick = (e) => {
      closeCandidateMenu();
      openCandidate(panelId, ref, c, e.shiftKey);
    };
    menu.appendChild(item);
  });
  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.top = rect.bottom + 4 + "px";
  setTimeout(() => document.addEventListener("click", closeCandidateMenu, { once: true }), 0);
}
function closeCandidateMenu() {
  const m = document.getElementById("cand-menu");
  if (m) m.remove();
}

function focusPanel(id) {
  state.focusedPanelId = id;
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("focused"));
  const node = document.querySelector(`.panel[data-id="${id}"]`);
  if (node) {
    node.classList.add("focused");
    node.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }
  syncFuncMapActive();
}

// ---------- 右侧函数地图（扁平箭头链，无缩进） ----------

/** 路径拆成文件夹链 + 文件名，供地图展示 */
function splitFilePath(file) {
  const norm = file.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  if (slash < 0) return { dirs: [], base: norm };
  return {
    dirs: norm.slice(0, slash).split("/").filter(Boolean),
    base: norm.slice(slash + 1),
  };
}

/** 目录显示：过长时保留末尾一段 */
function formatMapDir(dirs) {
  if (!dirs.length) return "";
  if (dirs.length <= 2) return dirs.join("/") + "/";
  return "…/" + dirs[dirs.length - 1] + "/";
}

function syncFuncMapActive() {
  if (!el.funcMapBody) return;
  el.funcMapBody.querySelectorAll(".map-row[data-panel-id]").forEach((n) => {
    n.classList.toggle("active", n.dataset.panelId === state.focusedPanelId);
  });
}

/** 单行：父 → 子（根节点仅显示函数名），点击整行跳到子/自身面板 */
function renderFuncMapRow(panelId, container) {
  const panel = state.panels.get(panelId);
  if (!panel?.detail) return;
  const d = panel.detail;
  const parent = panel.parentId ? state.panels.get(panel.parentId) : null;
  const { dirs, base } = splitFilePath(d.file);

  const row = document.createElement("div");
  row.className = "map-row" + (panelId === state.focusedPanelId ? " active" : "");
  row.dataset.panelId = panelId;

  const chain = document.createElement("div");
  chain.className = "map-chain";

  if (parent?.detail) {
    const pName = document.createElement("span");
    pName.className = "map-fn map-fn-parent";
    pName.title = parent.detail.file;
    pName.textContent = parent.detail.name;
    pName.onclick = (e) => {
      e.stopPropagation();
      focusPanel(panel.parentId);
    };

    const arrow = document.createElement("span");
    arrow.className = "map-arrow";
    arrow.textContent = "→";
    arrow.setAttribute("aria-hidden", "true");

    const cName = document.createElement("span");
    cName.className = "map-fn map-fn-child";
    cName.title = d.file;
    cName.textContent = d.name;

    chain.appendChild(pName);
    chain.appendChild(arrow);
    chain.appendChild(cName);
  } else {
    const cName = document.createElement("span");
    cName.className = "map-fn map-fn-root";
    cName.title = d.file;
    cName.innerHTML = `<span class="map-root-tag">根</span>${escapeHtml(d.name)}`;
    chain.appendChild(cName);
  }

  const meta = document.createElement("div");
  meta.className = "map-meta";
  meta.innerHTML =
    `<span class="map-file">${escapeHtml(base)}:${d.start_line}</span>` +
    (dirs.length ? ` <span class="map-dir" title="${escapeHtml(dirs.join("/"))}">${escapeHtml(formatMapDir(dirs))}</span>` : "");

  row.appendChild(chain);
  row.appendChild(meta);
  row.onclick = () => focusPanel(panelId);
  container.appendChild(row);
}

function renderFuncMap() {
  if (!el.funcMapBody) return;
  el.funcMapBody.innerHTML = "";
  if (!state.order.length) {
    el.funcMapBody.innerHTML = '<div class="map-empty">打开函数后显示调用链</div>';
    return;
  }
  // 按打开顺序扁平列出，每行 parent → child，长链也不缩进
  state.order.forEach((id) => renderFuncMapRow(id, el.funcMapBody));
}

// ---------- 渲染 ----------

// 列间距（父子横向留白）/ 行间距 / 内边距
const LAYOUT = { colGap: 96, rowGap: 18, padX: 20, padY: 16 };

/** 根据当前面板位置撑开画布滚动区域 */
function updateBoardSizer() {
  let maxRight = LAYOUT.padX, maxBottom = LAYOUT.padY;
  for (const id of state.order) {
    const p = state.panels.get(id);
    if (!p?.el) continue;
    const left = p._left ?? 0;
    const top = p._top ?? 0;
    maxRight = Math.max(maxRight, left + p.el.offsetWidth);
    maxBottom = Math.max(maxBottom, top + p.el.offsetHeight);
  }
  let sizer = el.board.querySelector(".board-sizer");
  if (!sizer) {
    sizer = document.createElement("div");
    sizer.className = "board-sizer";
    el.board.appendChild(sizer);
  }
  sizer.style.left = (maxRight + LAYOUT.padX) + "px";
  sizer.style.top = (maxBottom + LAYOUT.padY) + "px";
}

// ---------- 面板拖动（标题栏拖拽；双击标题恢复自动布局） ----------

let dragState = null;

function setupPanelDrag(header, panelId) {
  header.title = "拖动移动 · 双击恢复自动布局";

  header.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest(".close")) return;
    const panel = state.panels.get(panelId);
    if (!panel?.el) return;
    e.preventDefault();

    dragState = {
      panelId,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: panel._left ?? panel.el.offsetLeft,
      startTop: panel._top ?? panel.el.offsetTop,
      moved: false,
    };
    panel.el.classList.add("dragging");
    focusPanel(panelId);

    document.addEventListener("mousemove", onPanelDragMove);
    document.addEventListener("mouseup", onPanelDragEnd);
  });

  header.addEventListener("dblclick", (e) => {
    if (e.target.closest(".close")) return;
    const panel = state.panels.get(panelId);
    if (!panel) return;
    delete panel.manualPos;
    render();
    schedulePersist();
    toast("已恢复自动布局");
  });

  header.addEventListener("click", (e) => {
    if (e.target.closest(".close")) return;
    if (header._suppressClick) {
      header._suppressClick = false;
      return;
    }
    focusPanel(panelId);
  });
}

function onPanelDragMove(e) {
  if (!dragState) return;
  const panel = state.panels.get(dragState.panelId);
  if (!panel?.el) return;

  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragState.moved = true;

  const left = Math.max(LAYOUT.padX, dragState.startLeft + dx);
  const top = Math.max(LAYOUT.padY, dragState.startTop + dy);

  panel.manualPos = { left, top };
  // 基于新位置重排其余（非手动）子面板，避免重叠
  layout();
  drawConnectors();
  e.preventDefault();
}

function onPanelDragEnd() {
  if (!dragState) return;
  const panel = state.panels.get(dragState.panelId);
  const header = panel?.el?.querySelector(".panel-header");
  if (panel?.el) panel.el.classList.remove("dragging");
  if (dragState.moved) {
    if (header) header._suppressClick = true;
    layout();
    decorate();
    schedulePersist();
  }
  dragState = null;
  document.removeEventListener("mousemove", onPanelDragMove);
  document.removeEventListener("mouseup", onPanelDragEnd);
}

function render() {
  el.emptyHint.classList.toggle("hidden", state.order.length > 0);

  // 清空旧面板节点与撑尺寸的 sizer（保留 empty-hint）
  [...el.board.querySelectorAll(".panel, .board-sizer")].forEach((n) => n.remove());
  if (!state.order.length) {
    drawConnectors();
    renderFuncMap();
    return;
  }

  // 创建全部面板节点并绝对定位（位置稍后由 layout 计算）
  for (const id of state.order) {
    const panel = state.panels.get(id);
    const node = renderPanel(panel);
    panel.el = node;
    el.board.appendChild(node);
    refreshPanelAi(id);
  }

  // 需先完成布局测量，再算高亮与连线
  requestAnimationFrame(() => { layout(); decorate(); renderFuncMap(); });
  for (const id of state.order) {
    const panel = state.panels.get(id);
    if (panel._compileCtx?.available) updatePanelCompileUi(panel);
    else fetchPanelCompileContext(panel);
  }
}

/*
 * 平衡树布局（调用行锚定 + 最小位移去重叠）：
 * - 手动拖过的面板固定不动（manualPos），作为障碍物。
 * - 其余面板仍按调用行锚定 + 聚簇去重叠，并避让所有手动面板，避免互相覆盖。
 * - 父面板被拖动后，子面板的理想 y 随 parent._top 更新（逐 depth 传播）。
 */
function hRangesOverlap(l1, r1, l2, r2) {
  return l1 < r2 && l2 < r1;
}

/** 将 auto 面板下推，直到不与 obstacles 中的矩形（含 gap）相交 */
function pushBelowObstacles(top, left, width, height, obstacles, gap) {
  let t = top;
  for (let guard = 0; guard < 64; guard++) {
    let moved = false;
    for (const o of obstacles) {
      if (!hRangesOverlap(left, left + width, o.left, o.right)) continue;
      if (t < o.bottom + gap && t + height > o.top - gap) {
        const next = o.bottom + gap;
        if (next > t) { t = next; moved = true; }
      }
    }
    if (!moved) break;
  }
  return t;
}

function panelObstacle(p) {
  return {
    left: p._left,
    top: p._top,
    right: p._left + p.el.offsetWidth,
    bottom: p._top + p.el.offsetHeight,
  };
}

function applyPanelPos(p, left, top) {
  p._left = left;
  p._top = top;
  p.el.style.left = left + "px";
  p.el.style.top = top + "px";
  p.el.style.visibility = "visible";
}

function layout() {
  if (!state.order.length) return;

  const maxDepth = Math.max(...state.order.map((id) => state.panels.get(id).depth));
  const byDepth = Array.from({ length: maxDepth + 1 }, () => []);
  for (const id of state.order) byDepth[state.panels.get(id).depth].push(id);

  // 每列 x 偏移 = 前面各列最大宽度累加（宽度自适应）
  const colX = [];
  let x = LAYOUT.padX;
  for (let d = 0; d <= maxDepth; d++) {
    colX[d] = x;
    const maxW = Math.max(...byDepth[d].map((id) => state.panels.get(id).el.offsetWidth));
    x += maxW + LAYOUT.colGap;
  }

  const H = (id) => state.panels.get(id).el.offsetHeight;
  let maxRight = 0, maxBottom = 0;

  // 先固定所有手动面板，并收集为障碍物
  const obstacles = [];
  for (const id of state.order) {
    const p = state.panels.get(id);
    if (p.manualPos) {
      applyPanelPos(p, p.manualPos.left, p.manualPos.top);
      p.el.classList.add("manual-pos");
      obstacles.push(panelObstacle(p));
      maxRight = Math.max(maxRight, p._left + p.el.offsetWidth);
      maxBottom = Math.max(maxBottom, p._top + p.el.offsetHeight);
    } else {
      p.el.classList.remove("manual-pos");
    }
  }

  // 逐层布局自动面板：理想 y 随父面板（含拖动后的 _top）传播
  for (let d = 0; d <= maxDepth; d++) {
    const autoItems = [];
    for (const id of byDepth[d]) {
      const p = state.panels.get(id);
      if (p.manualPos) continue;
      let desired = LAYOUT.padY;
      if (p.parentId && p.fromRef) {
        const parent = state.panels.get(p.parentId);
        desired = (parent._top ?? LAYOUT.padY) +
          callLineOffset(parent, p.fromRef.line) - 18;
      }
      autoItems.push({ id, desired: Math.max(LAYOUT.padY, desired), h: H(id) });
    }
    if (!autoItems.length) continue;

    let pos = resolveOverlaps(autoItems, LAYOUT.rowGap, LAYOUT.padY);

    // 避让手动面板
    for (const it of autoItems) {
      const p = state.panels.get(it.id);
      const left = colX[d];
      const w = p.el.offsetWidth;
      pos[it.id] = pushBelowObstacles(pos[it.id], left, w, it.h, obstacles, LAYOUT.rowGap);
    }

    // 避让后同列自动面板之间可能再次重叠 → 二次聚簇
    const readjusted = autoItems.map((it) => ({ ...it, desired: pos[it.id] }));
    pos = resolveOverlaps(readjusted, LAYOUT.rowGap, LAYOUT.padY);
    for (const it of autoItems) {
      const p = state.panels.get(it.id);
      const left = colX[d];
      const w = p.el.offsetWidth;
      pos[it.id] = pushBelowObstacles(pos[it.id], left, w, it.h, obstacles, LAYOUT.rowGap);
    }

    for (const it of autoItems) {
      const p = state.panels.get(it.id);
      applyPanelPos(p, colX[d], pos[it.id]);
      maxRight = Math.max(maxRight, colX[d] + p.el.offsetWidth);
      maxBottom = Math.max(maxBottom, pos[it.id] + it.h);
    }
  }

  // 撑出滚动区域
  let sizer = el.board.querySelector(".board-sizer");
  if (!sizer) {
    sizer = document.createElement("div");
    sizer.className = "board-sizer";
    el.board.appendChild(sizer);
  }
  sizer.style.left = (maxRight + LAYOUT.padX) + "px";
  sizer.style.top = (maxBottom + LAYOUT.padY) + "px";

  if (state.focusNew) {
    focusPanel(state.focusNew);
    state.focusNew = null;
  }
}

// 调用行相对其所在面板顶部的像素偏移（面板显示完整函数，无需夹断）
function callLineOffset(panel, lineNo) {
  const el0 = panel.el;
  if (!el0 || !panel.detail) return 40;
  const codeEl = el0.querySelector(".panel-code");
  const lineEls = codeEl ? codeEl.querySelectorAll(".code-line") : [];
  const idx = lineNo - panel.detail.start_line;
  const codeTop = codeEl ? codeEl.offsetTop : 40;
  if (codeEl && idx >= 0 && idx < lineEls.length) {
    return codeTop + lineEls[idx].offsetTop;
  }
  return codeTop;
}

/*
 * 一维「最小位移去重叠」：每项有理想位置 desired 与高度 h，要求按顺序排列且
 * 相邻间距 >= gap。做法是把重叠的项合并为簇，簇的位置取使「各项与其理想位置
 * 偏差平方和最小」的解（即各项 desired 减去其在簇内偏移后的均值），从而围绕
 * 理想位置对称展开，而非一味下推。
 */
function resolveOverlaps(items, gap, minY) {
  const sorted = items.slice().sort((a, b) => a.desired - b.desired);
  const clusters = [];

  const mergeTop = (members) => {
    // top = mean(desired_i - offset_i)，offset_i 为成员在簇内的累计偏移
    let off = 0, sum = 0;
    for (const m of members) { sum += m.desired - off; off += m.h + gap; }
    return sum / members.length;
  };

  for (const it of sorted) {
    let cluster = { members: [it], top: it.desired, height: it.h };
    clusters.push(cluster);
    // 与前一簇重叠则合并，并级联向前
    while (clusters.length >= 2) {
      const b = clusters[clusters.length - 1];
      const a = clusters[clusters.length - 2];
      if (a.top + a.height + gap <= b.top) break;
      const members = a.members.concat(b.members);
      let off = 0;
      for (const m of members) off += m.h + gap;
      const merged = { members, height: off - gap, top: mergeTop(members) };
      clusters.splice(clusters.length - 2, 2, merged);
    }
  }

  // 落位：保证不低于 minY，且簇间不重叠
  const result = {};
  let runningTop = minY;
  for (const c of clusters) {
    const top = Math.max(c.top, runningTop);
    let off = 0;
    for (const m of c.members) {
      result[m.id] = top + off;
      off += m.h + gap;
    }
    runningTop = top + c.height + gap;
  }
  return result;
}

// 不参与跳转的常见关键字（点了也无意义），渲染为普通文本以减少噪声
const KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "default", "break",
  "continue", "return", "goto", "sizeof", "typeof", "struct", "union", "enum",
  "const", "static", "inline", "void", "int", "char", "long", "short", "unsigned",
  "signed", "float", "double", "bool", "true", "false", "null", "nullptr",
  "class", "interface", "public", "private", "protected", "final", "abstract",
  "new", "extends", "implements", "import", "package", "throws", "throw", "try",
  "catch", "finally", "def", "lambda", "pass", "yield", "with", "as", "elif",
  "raise", "except", "and", "or", "not", "in", "is", "None", "True", "False",
  "self", "this", "super", "var", "let",
]);

function renderPanel(panel) {
  const node = document.createElement("div");
  node.className = "panel";
  node.dataset.id = panel.id;
  node.style.visibility = "hidden"; // 定位完成前先隐藏，避免左上角闪烁

  const d = panel.detail;
  const header = document.createElement("div");
  header.className = "panel-header";
  header.innerHTML =
    `<span class="fn">${escapeHtml(d.name)}</span>` +
    `<span class="kind">${escapeHtml(d.kind)}</span>` +
    (panel.parentId
      ? `<span class="reparent-src" title="切换箭头来源：从其他面板重新指定调用点">⇄</span>`
      : "") +
    `<span class="file" title="${escapeHtml(d.file)}">${escapeHtml(d.file)}:${d.start_line}</span>` +
    `<span class="ai-open" title="AI 分析此函数">✦${hasAiNotes(d) ? '<i class="ai-dot"></i>' : ""}</span>` +
    `<span class="close" title="关闭此面板及右侧分支">×</span>`;
  header.querySelector(".close").onclick = (e) => { e.stopPropagation(); closePanel(panel.id); };
  const repBtn = header.querySelector(".reparent-src");
  if (repBtn) {
    repBtn.onclick = (e) => {
      e.stopPropagation();
      if (state.reparentTargetId === panel.id) cancelReparentMode();
      else startReparentMode(panel.id);
    };
  }
  header.addEventListener("click", (e) => {
    if (!state.reparentTargetId || state.reparentTargetId === panel.id) return;
    if (e.target.closest(".close, .ai-open, .reparent-src")) return;
    tryReparentFromHeader(panel.id);
  });
  header.querySelector(".ai-open").onclick = (e) => {
    e.stopPropagation();
    openPanelAi(panel.id, { selectedText: "" });
  };
  setupPanelDrag(header, panel.id);
  node.appendChild(header);
  if (panel.manualPos) node.classList.add("manual-pos");

  if (d.doc) {
    const doc = document.createElement("div");
    doc.className = "panel-doc";
    doc.textContent = d.doc;
    node.appendChild(doc);
  }

  // 代码区：调用位置集合（这些 token 用蓝色 .ref，其余标识符用 .tok）
  const code = document.createElement("div");
  code.className = "panel-code";
  const callCols = {};
  d.references.forEach((r) => {
    (callCols[r.line] = callCols[r.line] || new Map()).set(r.col, r);
  });

  d.lines.forEach((text, idx) => {
    const lineNo = d.start_line + idx;
    const lineEl = document.createElement("div");
    lineEl.className = "code-line";
    lineEl.innerHTML =
      `<span class="ln">${lineNo}</span>` +
      `<span class="lc">${renderLine(text, callCols[lineNo], lineNo)}</span>`;
    code.appendChild(lineEl);
  });

  // 事件委托：点击=跳定义/声明；Alt/Ctrl/右键=查用法
  code.addEventListener("click", (e) => {
    const t = e.target.closest(".tok, .ref");
    if (t) { e.stopPropagation(); navFromToken(panel.id, t, e); }
  });
  code.addEventListener("contextmenu", (e) => {
    // 任意右键均弹出菜单（含 AI），不再要求先选中代码
    e.preventDefault();
    e.stopPropagation();
    const sel = window.getSelection()?.toString().trim();
    const t = e.target.closest(".tok, .ref");
    showCodeContextMenu(e, panel.id, sel || "", t);
  });
  node.appendChild(code);

  // AI 问答区：与当前符号绑定，内容持久化到 localStorage
  const aiSec = document.createElement("div");
  aiSec.className = "panel-ai";
  node.appendChild(aiSec);

  return node;
}

// 将一行按标识符分词：每个标识符包成可点击 span（调用蓝色，其余中性）
function renderLine(text, callColMap, lineNo) {
  let html = "";
  let cursor = 0;
  const re = /[A-Za-z_]\w*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const s = m.index, word = m[0], col = s + 1;
    html += escapeHtml(text.slice(cursor, s));
    cursor = s + word.length;
    if (KEYWORDS.has(word)) { html += escapeHtml(word); continue; }
    const meta = callColMap && callColMap.get(col);
    const isCall = !!meta;
    let cls = isCall ? "ref" : "tok";
    if (meta && meta.ref_kind === "member") cls += " ref-member";
    let attrs = `data-name="${escapeHtml(word)}" data-line="${lineNo}" data-col="${col}"`;
    if (meta && meta.receiver) {
      attrs += ` data-receiver="${escapeHtml(meta.receiver)}" data-ref-kind="member"`;
    }
    html += `<span class="${cls}" ${attrs}>${escapeHtml(word)}</span>`;
  }
  html += escapeHtml(text.slice(cursor));
  return html;
}

/** 在用法行文本中定位标识符列（grep 命中无 col 时的回退） */
function colOfNameInLine(text, name) {
  if (!text || !name) return 1;
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const m = re.exec(text);
  return m ? m.index + 1 : 1;
}

/** 构造「查用法」连线的 fromRef：锚点在子面板用法行，defRef 指向定义侧 */
function makeUsageFromRef(defRef, usage) {
  return {
    name: defRef.name,
    line: usage.line,
    col: colOfNameInLine(usage.text || "", defRef.name),
    receiver: defRef.receiver || "",
    refKind: "usage",
    defRef: {
      name: defRef.name,
      line: defRef.line,
      col: defRef.col,
      receiver: defRef.receiver || "",
    },
  };
}

/** 连线语义 → CSS 类 / 箭头方向（usage 为子→父，其余为父→子） */
function classifyLink(fromRef) {
  if (!fromRef) return "call";
  const k = fromRef.refKind || "call";
  if (k === "usage") return "usage";
  if (k === "search") return "correlation";
  if (k === "reference") return "reference";
  return "call";
}

const LINK_MARKERS = {
  call: "arrow-call",
  reference: "arrow-ref",
  usage: "arrow-usage",
  correlation: "arrow-corr",
};

/** 在父面板 DOM 中定位来源 token（优先 line+col，退回同行同名） */
function findTokenInPanel(panelEl, fromRef) {
  if (!panelEl || !fromRef) return null;
  const { line, col, name } = fromRef;
  let el = panelEl.querySelector(
    `.tok[data-line="${line}"][data-col="${col}"], .ref[data-line="${line}"][data-col="${col}"]`
  );
  if (el) return el;
  if (!name) return null;
  for (const c of panelEl.querySelectorAll(`.tok[data-line="${line}"], .ref[data-line="${line}"]`)) {
    if (c.dataset.name === name) return c;
  }
  return null;
}

/** 连线起点：Y 对齐来源标识符，X 固定在父面板右缘（不伸入面板内部） */
function linkAnchorFromParent(parentEl, parentDetail, fromRef) {
  const pRect = parentEl.getBoundingClientRect();
  const token = findTokenInPanel(parentEl, fromRef);
  if (token) {
    const tr = token.getBoundingClientRect();
    return {
      x: pRect.right,
      y: Math.min(Math.max(tr.top + tr.height / 2, pRect.top + 8), pRect.bottom - 8),
      token,
    };
  }
  const idx = parentDetail ? fromRef.line - parentDetail.start_line : -1;
  const lineEls = parentEl.querySelectorAll(".code-line");
  if (idx >= 0 && idx < lineEls.length) {
    const lr = lineEls[idx].getBoundingClientRect();
    return {
      x: pRect.right,
      y: Math.min(Math.max(lr.top + lr.height / 2, pRect.top + 8), pRect.bottom - 8),
      token: null,
    };
  }
  return { x: pRect.right, y: pRect.top + 40, token: null };
}

/** 连线起点（查用法）：Y 对齐子面板内用法 token，X 固定在子面板左缘 */
function linkAnchorInChild(childEl, childDetail, fromRef) {
  const cRect = childEl.getBoundingClientRect();
  const token = findTokenInPanel(childEl, fromRef);
  if (token) {
    const tr = token.getBoundingClientRect();
    return {
      x: cRect.left,
      y: Math.min(Math.max(tr.top + tr.height / 2, cRect.top + 8), cRect.bottom - 8),
      token,
    };
  }
  const idx = childDetail ? fromRef.line - childDetail.start_line : -1;
  const lineEls = childEl.querySelectorAll(".code-line");
  if (idx >= 0 && idx < lineEls.length) {
    const lr = lineEls[idx].getBoundingClientRect();
    return {
      x: cRect.left,
      y: Math.min(Math.max(lr.top + lr.height / 2, cRect.top + 8), cRect.bottom - 8),
      token: null,
    };
  }
  return { x: cRect.left, y: cRect.top + 40, token: null };
}

// 统一装饰：高亮每个「催生了子面板」的来源标识符，并绘制父→子箭头连线。
// 集中处理可正确支持「同一父面板的多个分支」（多条高亮 + 多条连线）。
function decorate() {
  document.querySelectorAll(".code-line.src-highlight").forEach((n) =>
    n.classList.remove("src-highlight"));
  document.querySelectorAll(".tok.src-highlight, .ref.src-highlight").forEach((n) =>
    n.classList.remove("src-highlight"));

  for (const id of state.order) {
    const panel = state.panels.get(id);
    const childEl = document.querySelector(`.panel[data-id="${id}"]`);
    if (!childEl) continue;
    for (const link of panelLinks(panel)) {
      const parentEl = document.querySelector(`.panel[data-id="${link.parentId}"]`);
      if (!parentEl) continue;
      const parent = state.panels.get(link.parentId);
      if (!parent?.detail) continue;
      const kind = classifyLink(link.fromRef);

      if (kind === "usage" && link.fromRef.defRef) {
        // 查用法：子面板用法处 → 父面板定义处（箭头指向定义）
        const childAnchor = linkAnchorInChild(childEl, panel.detail, link.fromRef);
        const target = linkAnchorFromParent(parentEl, parent.detail, link.fromRef.defRef);
        if (childAnchor.token) childAnchor.token.classList.add("src-highlight");
        if (target.token) target.token.classList.add("src-highlight");
        else {
          const idx = link.fromRef.defRef.line - parent.detail.start_line;
          const lineEls = parentEl.querySelectorAll(".code-line");
          if (idx >= 0 && idx < lineEls.length) lineEls[idx].classList.add("src-highlight");
        }
        continue;
      }

      const anchor = linkAnchorFromParent(parentEl, parent.detail, link.fromRef);
      if (anchor.token) {
        anchor.token.classList.add("src-highlight");
      } else {
        const idx = link.fromRef.line - parent.detail.start_line;
        const lineEls = parentEl.querySelectorAll(".code-line");
        if (idx >= 0 && idx < lineEls.length) lineEls[idx].classList.add("src-highlight");
      }
    }
  }
  drawConnectors();
}

function ensureSvg() {
  const mk = (id, fill) =>
    `<marker id="${id}" markerWidth="9" markerHeight="9" refX="7" refY="3"
      orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L7,3 L0,6 Z" fill="${fill}"></path>
    </marker>`;
  const defsHtml =
    `<defs>` +
    mk("arrow-call", "#58a6ff") +
    mk("arrow-ref", "#3fb950") +
    mk("arrow-usage", "#d2a8ff") +
    mk("arrow-corr", "#ffb14d") +
    `</defs>`;

  let svg = document.getElementById("connectors");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "connectors";
    svg.innerHTML = defsHtml;
    document.body.appendChild(svg);
  } else if (!document.getElementById("arrow-call")) {
    svg.innerHTML = defsHtml;
  }
  return svg;
}

// 父→子（调用/引用/搜索）或 子→父（查用法）曲线箭头；颜色与方向由 classifyLink 决定。
function drawConnectors() {
  const svg = ensureSvg();
  const vw = window.innerWidth, vh = window.innerHeight;
  svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
  // 清除旧连线（保留 defs）
  [...svg.querySelectorAll("path.link")].forEach((p) => p.remove());

  for (const id of state.order) {
    const panel = state.panels.get(id);
    const childEl = document.querySelector(`.panel[data-id="${id}"]`);
    if (!childEl) continue;
    const cRect = childEl.getBoundingClientRect();

    for (const link of panelLinks(panel)) {
      const parentEl = document.querySelector(`.panel[data-id="${link.parentId}"]`);
      if (!parentEl) continue;
      const parent = state.panels.get(link.parentId);
      const kind = classifyLink(link.fromRef);
      const marker = LINK_MARKERS[kind] || LINK_MARKERS.call;
      let x1, y1, x2, y2;

      if (kind === "usage" && link.fromRef.defRef) {
        const childAnchor = linkAnchorInChild(childEl, panel.detail, link.fromRef);
        const target = linkAnchorFromParent(parentEl, parent?.detail, link.fromRef.defRef);
        x1 = childAnchor.x;
        y1 = childAnchor.y;
        x2 = target.x;
        y2 = target.y;
      } else {
        const anchor = linkAnchorFromParent(parentEl, parent?.detail, link.fromRef);
        x1 = anchor.x;
        y1 = anchor.y;
        x2 = cRect.left;
        y2 = Math.min(Math.max(cRect.top + 20, 0), vh);
      }

      const mx = (x1 + x2) / 2;
      const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", `link link-${kind}`);
      path.setAttribute("d", d);
      path.setAttribute("marker-end", `url(#${marker})`);
      svg.appendChild(path);
    }
  }
}

// ---------- AI 分析（右键 / 面板 ✦ → 面板内子区，按符号 localStorage 持久化） ----------

let codeCtxState = null;

/** 与 symbolKey 对齐，避免同函数因 start_line 漂移拆成多条记录 */
function aiSymbolKey(detail) {
  return `${state.project}:${symbolKey(detail)}`;
}

function aiLegacyKey(detail) {
  return `${state.project}:${detail.file}:${detail.start_line}:${detail.name}`;
}

function loadAiStore() {
  try { return JSON.parse(localStorage.getItem(LS_AI)) || {}; }
  catch { return {}; }
}

function saveAiStore(store) {
  localStorage.setItem(LS_AI, JSON.stringify(store));
}

/** 查找记录并迁移旧键（project:file:start_line:name） */
function resolveAiEntry(store, detail) {
  const key = aiSymbolKey(detail);
  if (store[key]) return { key, record: store[key] };
  const legacy = aiLegacyKey(detail);
  if (store[legacy]) {
    store[key] = store[legacy];
    delete store[legacy];
    return { key, record: store[key], migrated: true };
  }
  return { key, record: null };
}

function getAiRecord(detail) {
  const store = loadAiStore();
  const { record, migrated } = resolveAiEntry(store, detail);
  if (migrated) saveAiStore(store);
  return record;
}

function hasAiNotes(detail) {
  const rec = getAiRecord(detail);
  if (!rec?.threads?.length) return false;
  return rec.threads.some((t) => t.messages?.length > 0);
}

function aiMessageCount(detail) {
  const rec = getAiRecord(detail);
  if (!rec?.threads?.length) return 0;
  return rec.threads.reduce((n, t) => n + (t.messages?.length || 0), 0);
}

function ensureAiRecord(detail) {
  const store = loadAiStore();
  const { key, record, migrated } = resolveAiEntry(store, detail);
  if (!record) {
    store[key] = {
      symbol: {
        file: detail.file, name: detail.name,
        start_line: detail.start_line, end_line: detail.end_line,
      },
      project: state.project,
      threads: [],
    };
  }
  if (migrated || !record) saveAiStore(store);
  return store[key];
}

function persistAiRecord(detail, record) {
  const store = loadAiStore();
  store[aiSymbolKey(detail)] = record;
  saveAiStore(store);
}

/** 面板级 UI 状态（展开/当前线程/选中片段），随 panel 对象存活 */
function ensurePanelAiState(panel) {
  if (!panel.aiState) {
    panel.aiState = {
      expanded: hasAiNotes(panel.detail),
      threadId: null,
      selectedText: "",
    };
  }
  return panel.aiState;
}

function threadTitle(thread) {
  const first = thread.messages.find((m) => m.role === "user");
  if (!first) return "空对话";
  const t = first.content.replace(/\s+/g, " ").trim();
  return t.length > 36 ? t.slice(0, 36) + "…" : t;
}

function closeCodeContextMenu() {
  el.codeCtxMenu.classList.add("hidden");
  codeCtxState = null;
}

function showCodeContextMenu(ev, panelId, selectedText, tokenEl) {
  closeCodeContextMenu();
  const panel = state.panels.get(panelId);
  const lineEl = ev.target.closest(".code-line");
  const lineNo = lineEl
    ? parseInt(lineEl.querySelector(".ln")?.textContent || "0", 10)
    : panel?.detail?.start_line || 0;
  codeCtxState = { panelId, selectedText, tokenEl, lineNo };
  const menu = el.codeCtxMenu;
  menu.querySelector('[data-action="usages"]').classList.toggle(
    "hidden", !tokenEl
  );
  if (!state.aiConfigured) {
    menu.querySelector('[data-action="ai"]').textContent = "✦ AI 分析（未配置 cursor-agent，请先 login）";
  } else if (selectedText) {
    menu.querySelector('[data-action="ai"]').textContent = "✦ AI 分析选中代码";
  } else {
    menu.querySelector('[data-action="ai"]').textContent = "✦ AI 分析整个函数";
  }
  menu.classList.remove("hidden");
  menu.style.left = Math.min(ev.clientX, window.innerWidth - 200) + "px";
  menu.style.top = ev.clientY + "px";
  setTimeout(() => document.addEventListener("click", closeCodeContextMenu, { once: true }), 0);
}

function formatAiText(text) {
  // 简单 markdown：代码块 + 换行（不做完整 MD 解析，避免 XSS）
  const parts = text.split(/```/);
  let html = "";
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      html += `<pre class="ai-code">${escapeHtml(part.replace(/^\w*\n/, ""))}</pre>`;
    } else {
      html += escapeHtml(part).replace(/\n/g, "<br>");
    }
  });
  return html;
}

function ensurePanelAiThread(panel, record, opts = {}) {
  const ai = ensurePanelAiState(panel);
  let threadId = opts.threadId || ai.threadId;
  if (!threadId) {
    if (opts.newThread || opts.selectedText) {
      const th = {
        id: "th-" + Date.now(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        selectedText: opts.selectedText || "",
        messages: [],
      };
      record.threads.unshift(th);
      threadId = th.id;
      persistAiRecord(panel.detail, record);
    } else if (record.threads.length) {
      threadId = record.threads[0].id;
    } else {
      const th = {
        id: "th-" + Date.now(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        selectedText: "",
        messages: [],
      };
      record.threads.unshift(th);
      threadId = th.id;
      persistAiRecord(panel.detail, record);
    }
  }
  ai.threadId = threadId;
  if (opts.selectedText) ai.selectedText = opts.selectedText;
  return threadId;
}

/** 在面板底部渲染 AI 子区（线程、历史消息、输入框） */
function refreshPanelAi(panelId) {
  const panel = state.panels.get(panelId);
  const mount = panel?.el?.querySelector(".panel-ai");
  if (!panel?.detail || !mount) return;

  const d = panel.detail;
  const ai = ensurePanelAiState(panel);
  const record = ensureAiRecord(d);
  ensurePanelAiThread(panel, record);
  persistAiRecord(d, record);

  const msgCount = aiMessageCount(d);
  const thread = record.threads.find((t) => t.id === ai.threadId);

  mount.innerHTML = "";
  mount.classList.toggle("has-notes", msgCount > 0);

  const head = document.createElement("div");
  head.className = "panel-ai-head";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "panel-ai-toggle";
  toggle.innerHTML =
    `<span class="panel-ai-label">✦ AI 笔记</span>` +
    (msgCount ? `<span class="panel-ai-count">${msgCount} 条</span>` : "");
  toggle.onclick = (e) => {
    e.stopPropagation();
    ai.expanded = !ai.expanded;
    refreshPanelAi(panelId);
  };
  head.appendChild(toggle);

  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "panel-ai-new";
  newBtn.title = "新对话";
  newBtn.textContent = "+";
  newBtn.onclick = (e) => {
    e.stopPropagation();
    openPanelAi(panelId, { newThread: true, selectedText: ai.selectedText || "" });
  };
  head.appendChild(newBtn);
  mount.appendChild(head);

  const body = document.createElement("div");
  body.className = "panel-ai-body" + (ai.expanded ? "" : " collapsed");

  const threadBar = document.createElement("div");
  threadBar.className = "panel-ai-thread-bar";
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = "历史";
  threadBar.appendChild(lbl);
  const threadList = document.createElement("div");
  threadList.className = "ai-thread-list";
  record.threads.forEach((th) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "ai-thread-pill" + (th.id === ai.threadId ? " active" : "");
    pill.textContent = threadTitle(th);
    pill.title = threadTitle(th);
    pill.onclick = (e) => {
      e.stopPropagation();
      ai.threadId = th.id;
      refreshPanelAi(panelId);
    };
    threadList.appendChild(pill);
  });
  threadBar.appendChild(threadList);
  body.appendChild(threadBar);

  if (ai.selectedText) {
    const selHint = document.createElement("div");
    selHint.className = "panel-ai-sel-hint";
    selHint.textContent = "已附带选中代码片段";
    body.appendChild(selHint);
  }

  const messages = document.createElement("div");
  messages.className = "panel-ai-messages ai-messages";
  if (!thread || !thread.messages.length) {
    messages.innerHTML =
      `<div class="ai-hint">可问：这里几种时序/分支情况？多核下可能有什么问题？如何验证？</div>`;
  } else {
    thread.messages.forEach((m) => {
      const div = document.createElement("div");
      div.className = `ai-msg ai-msg-${m.role}`;
      const meta = document.createElement("div");
      meta.className = "ai-msg-meta";
      meta.textContent = m.role === "user" ? "你" : "AI";
      const msgBody = document.createElement("div");
      msgBody.className = "ai-msg-body";
      msgBody.innerHTML = formatAiText(m.content);
      div.appendChild(meta);
      div.appendChild(msgBody);
      messages.appendChild(div);
    });
    requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
  }
  body.appendChild(messages);

  const inputWrap = document.createElement("div");
  inputWrap.className = "panel-ai-input-wrap ai-input-wrap";
  const textarea = document.createElement("textarea");
  textarea.className = "panel-ai-input";
  textarea.rows = 2;
  textarea.placeholder = "描述你想分析的问题…（Ctrl+Enter 发送）";
  textarea.onclick = (e) => e.stopPropagation();
  textarea.onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendPanelAiMessage(panelId, textarea);
    }
  };
  inputWrap.appendChild(textarea);
  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "panel-ai-send";
  sendBtn.textContent = "发送";
  sendBtn.onclick = (e) => {
    e.stopPropagation();
    sendPanelAiMessage(panelId, textarea, sendBtn);
  };
  inputWrap.appendChild(sendBtn);
  body.appendChild(inputWrap);

  const status = document.createElement("div");
  status.className = "panel-ai-status ai-status";
  if (state.aiConfigured) {
    status.textContent = `${state.aiBackend || "cursor-agent"} · ${state.aiModel}`;
  } else {
    status.textContent = "请安装 cursor-agent 并 login";
  }
  body.appendChild(status);

  mount.appendChild(body);

  if (panel._aiPrefill) {
    textarea.value = panel._aiPrefill;
    panel._aiPrefill = "";
  }
  if (panel._aiFocus) {
    textarea.focus();
    panel._aiFocus = false;
  }
}

function openPanelAi(panelId, opts = {}) {
  const panel = state.panels.get(panelId);
  if (!panel?.detail) return;
  const record = ensureAiRecord(panel.detail);
  const ai = ensurePanelAiState(panel);
  ensurePanelAiThread(panel, record, opts);
  ai.expanded = true;
  if (opts.prefill) panel._aiPrefill = opts.prefill;
  panel._aiFocus = true;
  refreshPanelAi(panelId);
  refreshAiPanelBadge(panelId);
  panel.el?.querySelector(".panel-ai")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function refreshAiPanelBadge(panelId) {
  const panel = state.panels.get(panelId);
  const node = panel?.el?.querySelector(".ai-open");
  if (!node || !panel.detail) return;
  const dot = node.querySelector(".ai-dot");
  const has = hasAiNotes(panel.detail);
  if (has && !dot) {
    node.insertAdjacentHTML("beforeend", '<i class="ai-dot"></i>');
  } else if (!has && dot) {
    dot.remove();
  }
}

async function sendPanelAiMessage(panelId, textarea, sendBtn) {
  const question = textarea.value.trim();
  if (!question) return;
  if (!state.aiConfigured) {
    toast("未配置 cursor-agent（请先 login）");
    return;
  }

  const panel = state.panels.get(panelId);
  if (!panel?.detail) return;
  const d = panel.detail;
  const ai = ensurePanelAiState(panel);
  const record = ensureAiRecord(d);
  const thread = record.threads.find((t) => t.id === ai.threadId);
  if (!thread) return;

  thread.messages.push({
    role: "user", content: question, ts: new Date().toISOString(),
  });
  thread.updatedAt = new Date().toISOString();
  if (ai.selectedText && !thread.selectedText) {
    thread.selectedText = ai.selectedText;
  }
  persistAiRecord(d, record);
  textarea.value = "";
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.textContent = "分析中…";
  }
  refreshPanelAi(panelId);

  const source = d.lines.join("\n");
  const history = thread.messages.slice(0, -1).map((m) => ({
    role: m.role, content: m.content,
  }));

  try {
    const resp = await apiPost("/api/ai/chat", {
      project: state.project,
      file: d.file,
      function_name: d.name,
      start_line: d.start_line,
      end_line: d.end_line,
      signature: d.signature || "",
      source,
      selected_text: ai.selectedText || thread.selectedText || "",
      question,
      history,
      chat_id: thread.chatId || "",
    });
    if (resp.chat_id) thread.chatId = resp.chat_id;
    thread.messages.push({
      role: "assistant", content: resp.reply, ts: new Date().toISOString(),
    });
    thread.updatedAt = new Date().toISOString();
    persistAiRecord(d, record);
    refreshAiPanelBadge(panelId);
    refreshPanelAi(panelId);
  } catch (e) {
    toast("AI 分析失败: " + e.message);
    thread.messages.pop();
    persistAiRecord(d, record);
    refreshPanelAi(panelId);
  } finally {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = "发送";
    }
  }
}

async function loadAiConfig() {
  try {
    const cfg = await api("/api/ai/config");
    state.aiConfigured = !!cfg.configured;
    state.aiModel = cfg.model || "";
    state.aiBackend = cfg.backend || "";
  } catch {
    state.aiConfigured = false;
    state.aiBackend = "";
  }
}

// ---------- 事件绑定 ----------

el.funcMapToggle?.addEventListener("click", () => {
  document.body.classList.toggle("map-collapsed");
});

el.projectSelect.addEventListener("change", (e) => setProject(e.target.value));
el.searchMode?.addEventListener("click", (e) => {
  const btn = e.target.closest(".search-mode-btn");
  if (!btn) return;
  setSearchMode(btn.dataset.mode);
});
el.searchInput.addEventListener("input", onSearchInput);
el.searchInput.addEventListener("focus", onSearchInput);
el.btnSaveBookmark.addEventListener("click", openBookmarkDialog);
el.bookmarkSaveOk.addEventListener("click", saveCurrentAsBookmark);
el.bookmarkSaveCancel.addEventListener("click", closeBookmarkDialog);
el.bookmarkDialog.addEventListener("click", (e) => {
  if (e.target === el.bookmarkDialog) closeBookmarkDialog();
});
el.bookmarkNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveCurrentAsBookmark();
  if (e.key === "Escape") closeBookmarkDialog();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.reparentTargetId) cancelReparentMode();
});

document.addEventListener("click", (e) => {
  if (!state.reparentTargetId) return;
  if (e.target.closest(".panel, .code-ctx-menu, .bookmark-dialog, .search-wrap, .topbar")) return;
  cancelReparentMode();
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) el.searchResults.classList.add("hidden");
});

el.codeCtxMenu.addEventListener("click", (e) => {
  const item = e.target.closest(".ctx-item");
  if (!item || !codeCtxState) return;
  e.stopPropagation();
  const action = item.dataset.action;
  const { panelId, selectedText, tokenEl, lineNo } = codeCtxState;
  const panel = state.panels.get(panelId);
  closeCodeContextMenu();
  if (action === "ai") {
    openPanelAi(panelId, {
      selectedText,
      prefill: selectedText
        ? "请分析以下选中代码可能的几种情况（时序/分支/多核）："
        : "",
    });
  } else if (action === "usages" && tokenEl) {
    navFromToken(panelId, tokenEl, { type: "contextmenu" });
  } else if (action === "gdb-break" && panel?.detail) {
    copyGdbBreak(panel.detail.file, lineNo || panel.detail.start_line);
  } else if (action === "gdb-fn-break" && panel?.detail) {
    copyGdbBreak(panel.detail.file, panel.detail.start_line);
  }
});

el.btnExportGdb.addEventListener("click", () => exportGdbScript());
el.debugProfileSelect.addEventListener("change", () => {
  const p = selectedDebugProfile();
  if (p) {
    saveDebugProfileChoice(p.id);
    toast(`已选：${p.name}`);
  }
});

// 页面关闭前立即写入，减少刷新时丢失最后一帧改动的概率
window.addEventListener("beforeunload", () => {
  if (state._restoring) return;
  const snap = serializeState();
  if (snap) localStorage.setItem(LS_SESSION, JSON.stringify(snap));
});

// rAF 节流：滚动/缩放时按需重排 + 重绘连线
let _frame = null;
function schedule(withLayout) {
  if (_frame) { _frame.withLayout = _frame.withLayout || withLayout; return; }
  _frame = { withLayout };
  requestAnimationFrame(() => {
    const wl = _frame.withLayout;
    _frame = null;
    if (wl) layout();   // 父代码滚动后，子面板（整棵子树）跟随调用行重新定位
    drawConnectors();
  });
}

// capture=true 既能捕获画布平移（target=board），也能捕获面板内代码滚动（target=panel-code）
el.board.addEventListener(
  "scroll",
  (e) => {
    const t = e.target;
    const isCodeScroll = t && t.classList && t.classList.contains("panel-code");
    schedule(isCodeScroll);
    if (t === el.board) schedulePersist();
  },
  true
);
// 窗口缩放会改变代码区限高，进而影响行位置 → 需重排
window.addEventListener("resize", () => schedule(true));

loadProjects();
