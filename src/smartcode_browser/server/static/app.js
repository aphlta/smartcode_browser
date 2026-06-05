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
  ai: null, // { panelId, threadId, selectedText }
};

// localStorage 键：上次会话 + 用户命名的标签书签 + AI 分析记录
const LS_SESSION = "smartcode-browser-session-v1";
const LS_BOOKMARKS = "smartcode-browser-bookmarks-v1";
const LS_AI = "smartcode-browser-ai-v1";

const el = {
  projectSelect: document.getElementById("project-select"),
  searchInput: document.getElementById("search-input"),
  searchResults: document.getElementById("search-results"),
  board: document.getElementById("board"),
  stats: document.getElementById("stats"),
  emptyHint: document.getElementById("empty-hint"),
  btnSaveBookmark: document.getElementById("btn-save-bookmark"),
  bookmarkList: document.getElementById("bookmark-list"),
  bookmarkDialog: document.getElementById("bookmark-dialog"),
  bookmarkNameInput: document.getElementById("bookmark-name-input"),
  bookmarkSaveOk: document.getElementById("bookmark-save-ok"),
  bookmarkSaveCancel: document.getElementById("bookmark-save-cancel"),
  codeCtxMenu: document.getElementById("code-ctx-menu"),
  aiDrawer: document.getElementById("ai-drawer"),
  aiDrawerTitle: document.getElementById("ai-drawer-title"),
  aiDrawerSub: document.getElementById("ai-drawer-sub"),
  aiDrawerClose: document.getElementById("ai-drawer-close"),
  aiThreadList: document.getElementById("ai-thread-list"),
  aiNewThread: document.getElementById("ai-new-thread"),
  aiMessages: document.getElementById("ai-messages"),
  aiInput: document.getElementById("ai-input"),
  aiSend: document.getElementById("ai-send"),
  aiStatus: document.getElementById("ai-status"),
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
    const snap = serializeState();
    if (snap) localStorage.setItem(LS_SESSION, JSON.stringify(snap));
    else localStorage.removeItem(LS_SESSION);
  }, 350);
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
    pill.className = "bookmark-pill";
    pill.title = `${bm.name}\n${bm.session?.panels?.length || 0} 个面板 · ${formatSavedAt(bm.savedAt)}`;
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
  el.bookmarkNameInput.value = defaultBookmarkName();
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
  const id = "bm-" + Date.now();
  bookmarks[id] = { name, savedAt: new Date().toISOString(), session: snap };
  saveBookmarksStore(bookmarks);
  renderBookmarkList();
  closeBookmarkDialog();
  toast(`已保存标签「${name}」`);
}

function deleteBookmark(id) {
  const bookmarks = loadBookmarksStore();
  const name = bookmarks[id]?.name || "标签";
  delete bookmarks[id];
  saveBookmarksStore(bookmarks);
  renderBookmarkList();
  toast(`已删除「${name}」`);
}

async function loadBookmark(id) {
  const bm = loadBookmarksStore()[id];
  if (!bm?.session) return;
  const ok = await restoreSession(bm.session);
  if (ok) toast(`已打开标签「${bm.name}」`);
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
    clearAllPanels({ silent: true });
    await refreshProjectStats(snap.project);

    const builtIds = [];
    for (const ps of snap.panels) {
      const detail = await fetchSymbol(ps.file, ps.name, ps.line);
      const id = "p" + state.seq++;
      const parentId = ps.parentIndex >= 0 ? builtIds[ps.parentIndex] : null;
      insertPanel(detail, parentId, ps.fromRef, id);
      if (ps.manualPos) state.panels.get(id).manualPos = ps.manualPos;
      builtIds.push(id);
    }
    // 恢复「复用面板」的额外来源连线
    snap.panels.forEach((ps, i) => {
      if (!ps.extraLinks?.length) return;
      const targetId = builtIds[i];
      for (const xl of ps.extraLinks) {
        const parentId = builtIds[xl.parentIndex];
        if (parentId) linkPanelFrom(parentId, xl.fromRef, targetId, { silent: true });
      }
    });
    render();
    requestAnimationFrame(() => {
      if (snap.boardScroll) {
        el.board.scrollLeft = snap.boardScroll.left || 0;
        el.board.scrollTop = snap.boardScroll.top || 0;
      }
      schedule(true);
    });
    schedulePersist();
    return true;
  } catch (e) {
    toast("恢复失败: " + e.message);
    clearAllPanels({ silent: true });
    return false;
  } finally {
    state._restoring = false;
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
      (s.truncated ? " · 已截断" : "");
  } catch (e) {
    el.stats.textContent = "索引失败: " + e.message;
  }
}

async function setProject(id) {
  state.project = id;
  clearAllPanels();
  await refreshProjectStats(id);
}

// ---------- 搜索 ----------

let searchTimer = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  const q = el.searchInput.value.trim();
  if (!q) { el.searchResults.classList.add("hidden"); return; }
  searchTimer = setTimeout(() => runSearch(q), 200);
}

async function runSearch(q) {
  if (!state.project) return;
  let results = [];
  try {
    results = await api("/api/search", { project: state.project, q, limit: 40 });
  } catch (e) { toast("搜索失败: " + e.message); return; }

  el.searchResults.innerHTML = "";
  if (!results.length) {
    const hint = /^(?:in:|@)/i.test(q)
      ? "无匹配（检查路径是否在已索引文件内）"
      : "无匹配符号";
    el.searchResults.innerHTML = `<div class="item">${hint}</div>`;
  } else {
    results.forEach((r) => {
      const div = document.createElement("div");
      div.className = "item";
      div.innerHTML =
        `<span class="nm">${escapeHtml(r.name)}</span>` +
        `<span class="kind">${escapeHtml(r.kind)}</span>` +
        `<span class="loc">${escapeHtml(r.file)}:${r.start_line}</span>`;
      div.onclick = () => {
        el.searchResults.classList.add("hidden");
        el.searchInput.value = "";
        openRoot(r.file, r.name, r.start_line);
      };
      el.searchResults.appendChild(div);
    });
  }
  el.searchResults.classList.remove("hidden");
}

// ---------- 打开符号 / 级联 ----------

async function fetchSymbol(file, name, line) {
  return api("/api/symbol", { project: state.project, file, name, line });
}

// 打开为根（清空现有所有面板）
async function openRoot(file, name, line) {
  clearAllPanels();
  try {
    const detail = await fetchSymbol(file, name, line);
    addPanel(detail, null, null);
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
  return id;
}

function refKey(ref) { return `${ref.name}@${ref.line}:${ref.col}`; }

/** 符号唯一键：同一 file+行 视为同一定义，可复用面板 */
function symbolKey(detail) {
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

// 关闭面板及其所有后代
function closePanel(id) {
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
}

function clearAllPanels(opts = {}) {
  state.panels.clear();
  state.order = [];
  state.seq = 0;
  render();
  if (!opts.silent) schedulePersist();
}

// 点击任意 token：
//  - 普通点击：调用(.ref)走函数解析；变量(.tok)走 resolve_at（局部声明优先）
//  - Alt/Ctrl/Meta 或右键：查找该标识符的所有用法
async function navFromToken(panelId, el, ev) {
  const panel = state.panels.get(panelId);
  const name = el.dataset.name;
  const line = parseInt(el.dataset.line, 10);
  const col = parseInt(el.dataset.col, 10);
  const fromRef = {
    name, line, col,
    receiver: el.dataset.receiver || "",
    refKind: el.dataset.refKind || "",
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
    // 函数指针：每次选择都新开子面板；普通调用仍可复用已有面板（Shift 强制新开）
    if (!forceNew && !memberFp) {
      const existingId = findPanelBySymbol(detail);
      if (existingId && existingId !== panelId) {
        linkPanelFrom(panelId, ref, existingId);
        return;
      }
    }
    addPanel(detail, panelId, ref);
  } catch (e) { toast("展开失败: " + e.message); }
}

// 查找用法 → 弹出一个**临时浮动列表**（不进入树，选完即关）
async function openUsages(panelId, fromRef, anchorEl) {
  let list = [];
  try {
    list = await api("/api/usages", { project: state.project, name: fromRef.name, limit: 300 });
  } catch (e) { toast("查找用法失败: " + e.message); return; }
  showUsagesPop(panelId, fromRef.name, list, anchorEl);
}

function closeUsagesPop() {
  const m = document.getElementById("usages-pop");
  if (m) m.remove();
}

function showUsagesPop(originPanelId, name, list, anchorEl) {
  closeUsagesPop();
  closeCandidateMenu();
  const pop = document.createElement("div");
  pop.id = "usages-pop";
  pop.className = "usages-pop";

  const head = document.createElement("div");
  head.className = "usages-pop-head";
  head.innerHTML = `<span>⤢ 用法: ${escapeHtml(name)}</span>` +
    `<span class="cnt">${list.length}</span><span class="x">×</span>`;
  head.querySelector(".x").onclick = closeUsagesPop;
  pop.appendChild(head);

  const body = document.createElement("div");
  body.className = "usages-pop-body";
  if (!list.length) body.innerHTML = `<div class="usage-row">未找到使用位置</div>`;
  list.forEach((u) => {
    const row = document.createElement("div");
    row.className = "usage-row";
    row.innerHTML =
      `<div class="u-loc">${escapeHtml(u.file)}:${u.line}` +
      (u.enclosing ? ` <span class="u-in">in ${escapeHtml(u.enclosing)}</span>` : "") +
      `</div><div class="u-snip">${escapeHtml(u.text)}</div>`;
    row.onclick = (e) => { e.stopPropagation(); openUsageRow(originPanelId, u); };
    body.appendChild(row);
  });
  pop.appendChild(body);
  document.body.appendChild(pop);

  // 定位到锚点附近，避免超出视口
  const rect = anchorEl ? anchorEl.getBoundingClientRect() : { left: 100, bottom: 100 };
  const popW = 460;
  let left = rect.left;
  if (left + popW > window.innerWidth) left = window.innerWidth - popW - 12;
  pop.style.left = Math.max(8, left) + "px";
  pop.style.top = (rect.bottom + 6) + "px";

  // 点击别处 / Esc 关闭
  setTimeout(() => {
    document.addEventListener("click", onDocCloseUsages, true);
    document.addEventListener("keydown", onEscCloseUsages);
  }, 0);
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

// 点击用法行 → 在「变量所在面板」下打开其所属函数并闪烁，然后关闭弹窗
async function openUsageRow(originPanelId, u) {
  closeUsagesPop();
  if (!u.enclosing) {
    toast(`顶层使用：${u.file}:${u.line}`);
    return;
  }
  try {
    const detail = await fetchSymbol(u.file, u.enclosing, u.enclosing_line);
    if (!detail) { toast("目标源码不可读"); return; }
    const id = addPanel(detail, originPanelId, { name: u.enclosing, line: u.line, col: 1 });
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
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("focused"));
  const node = document.querySelector(`.panel[data-id="${id}"]`);
  if (node) {
    node.classList.add("focused");
    node.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }
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
  if (!state.order.length) { drawConnectors(); return; }

  // 创建全部面板节点并绝对定位（位置稍后由 layout 计算）
  for (const id of state.order) {
    const panel = state.panels.get(id);
    const node = renderPanel(panel);
    panel.el = node;
    el.board.appendChild(node);
  }

  // 需先完成布局测量，再算高亮与连线
  requestAnimationFrame(() => { layout(); decorate(); });
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
    const node = state.panels.get(state.focusNew)?.el;
    if (node) node.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
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
    `<span class="file" title="${escapeHtml(d.file)}">${escapeHtml(d.file)}:${d.start_line}</span>` +
    `<span class="ai-open" title="AI 分析此函数">✦${hasAiNotes(d) ? '<i class="ai-dot"></i>' : ""}</span>` +
    `<span class="close" title="关闭此面板及右侧分支">×</span>`;
  header.querySelector(".close").onclick = (e) => { e.stopPropagation(); closePanel(panel.id); };
  header.querySelector(".ai-open").onclick = (e) => {
    e.stopPropagation();
    openAiDrawer(panel.id, { selectedText: "" });
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

// 统一装饰：高亮每个「催生了子面板」的来源行，并绘制父→子箭头连线。
// 集中处理可正确支持「同一父面板的多个分支」（多条高亮 + 多条连线）。
function decorate() {
  document.querySelectorAll(".code-line.src-highlight").forEach((n) =>
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
      const idx = link.fromRef.line - parent.detail.start_line;
      const lineEls = parentEl.querySelectorAll(".code-line");
      if (idx >= 0 && idx < lineEls.length) lineEls[idx].classList.add("src-highlight");
    }
  }
  drawConnectors();
}

function ensureSvg() {
  let svg = document.getElementById("connectors");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "connectors";
    svg.innerHTML =
      `<defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="3"
        orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L7,3 L0,6 Z" fill="var(--accent)"></path>
      </marker></defs>`;
    document.body.appendChild(svg);
  }
  return svg;
}

// 在父面板右缘与子面板左缘之间画曲线箭头；连线走列间空隙，尽量不压代码。
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
    const y2 = Math.min(Math.max(cRect.top + 20, 0), vh);

    for (const link of panelLinks(panel)) {
      const parentEl = document.querySelector(`.panel[data-id="${link.parentId}"]`);
      if (!parentEl) continue;
      const pRect = parentEl.getBoundingClientRect();
      const parent = state.panels.get(link.parentId);
      const idx = parent?.detail ? link.fromRef.line - parent.detail.start_line : -1;
      const lineEls = parentEl.querySelectorAll(".code-line");

      let y1 = pRect.top + 40;
      if (idx >= 0 && idx < lineEls.length) {
        const lr = lineEls[idx].getBoundingClientRect();
        y1 = Math.min(Math.max(lr.top + lr.height / 2, pRect.top + 30), pRect.bottom - 8);
      }
      const x1 = pRect.right;
      const x2 = cRect.left;
      const mx = (x1 + x2) / 2;
      const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "link");
      path.setAttribute("d", d);
      path.setAttribute("marker-end", "url(#arrow)");
      svg.appendChild(path);
    }
  }
}

// ---------- AI 分析（右键 / 面板 ✦ → 侧栏对话，按函数 localStorage 持久化） ----------

let codeCtxState = null;

function aiSymbolKey(detail) {
  return `${state.project}:${detail.file}:${detail.start_line}:${detail.name}`;
}

function loadAiStore() {
  try { return JSON.parse(localStorage.getItem(LS_AI)) || {}; }
  catch { return {}; }
}

function saveAiStore(store) {
  localStorage.setItem(LS_AI, JSON.stringify(store));
}

function getAiRecord(detail) {
  const store = loadAiStore();
  return store[aiSymbolKey(detail)] || null;
}

function hasAiNotes(detail) {
  const rec = getAiRecord(detail);
  if (!rec?.threads?.length) return false;
  return rec.threads.some((t) => t.messages?.length > 0);
}

function ensureAiRecord(detail) {
  const store = loadAiStore();
  const key = aiSymbolKey(detail);
  if (!store[key]) {
    store[key] = {
      symbol: {
        file: detail.file, name: detail.name,
        start_line: detail.start_line, end_line: detail.end_line,
      },
      project: state.project,
      threads: [],
    };
  }
  return store[key];
}

function persistAiRecord(detail, record) {
  const store = loadAiStore();
  store[aiSymbolKey(detail)] = record;
  saveAiStore(store);
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
  codeCtxState = { panelId, selectedText, tokenEl };
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

function renderAiUi() {
  if (!state.ai) return;
  const panel = state.panels.get(state.ai.panelId);
  if (!panel?.detail) return;
  const d = panel.detail;
  const record = ensureAiRecord(d);
  persistAiRecord(d, record);

  el.aiDrawerTitle.textContent = `AI · ${d.name}`;
  el.aiDrawerSub.textContent = `${d.file}:${d.start_line}`;
  if (state.ai.selectedText) {
    el.aiDrawerSub.textContent += " · 已选中片段";
  }

  el.aiThreadList.innerHTML = "";
  record.threads.forEach((th) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "ai-thread-pill" + (th.id === state.ai.threadId ? " active" : "");
    pill.textContent = threadTitle(th);
    pill.title = threadTitle(th);
    pill.onclick = () => {
      state.ai.threadId = th.id;
      renderAiUi();
    };
    el.aiThreadList.appendChild(pill);
  });

  const thread = record.threads.find((t) => t.id === state.ai.threadId);
  el.aiMessages.innerHTML = "";
  if (!thread || !thread.messages.length) {
    el.aiMessages.innerHTML =
      `<div class="ai-hint">可问：这里几种时序/分支情况？多核下可能有什么问题？如何验证？</div>`;
  } else {
    thread.messages.forEach((m) => {
      const div = document.createElement("div");
      div.className = `ai-msg ai-msg-${m.role}`;
      const meta = document.createElement("div");
      meta.className = "ai-msg-meta";
      meta.textContent = m.role === "user" ? "你" : "AI";
      const body = document.createElement("div");
      body.className = "ai-msg-body";
      body.innerHTML = formatAiText(m.content);
      div.appendChild(meta);
      div.appendChild(body);
      el.aiMessages.appendChild(div);
    });
    el.aiMessages.scrollTop = el.aiMessages.scrollHeight;
  }

  if (state.aiConfigured) {
    const backend = state.aiBackend || "cursor-agent";
    el.aiStatus.textContent = `${backend} · ${state.aiModel}`;
  } else {
    el.aiStatus.textContent = "请安装 cursor-agent 并 login";
  }
}

function openAiDrawer(panelId, opts = {}) {
  const panel = state.panels.get(panelId);
  if (!panel?.detail) return;
  const record = ensureAiRecord(panel.detail);
  let threadId = opts.threadId;
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
  state.ai = {
    panelId,
    threadId,
    selectedText: opts.selectedText || "",
  };
  document.body.classList.add("ai-open");
  el.aiDrawer.classList.remove("hidden");
  renderAiUi();
  refreshAiPanelBadge(panelId);
  if (opts.prefill) el.aiInput.value = opts.prefill;
  el.aiInput.focus();
}

function closeAiDrawer() {
  el.aiDrawer.classList.add("hidden");
  document.body.classList.remove("ai-open");
  state.ai = null;
}

function refreshAiPanelBadge(panelId) {
  const panel = state.panels.get(panelId);
  const node = panel?.el?.querySelector(".ai-open");
  if (!node || !panel.detail) return;
  const dot = node.querySelector(".ai-dot");
  if (hasAiNotes(panel.detail) && !dot) {
    node.insertAdjacentHTML("beforeend", '<i class="ai-dot"></i>');
  }
}

function newAiThread() {
  if (!state.ai) return;
  openAiDrawer(state.ai.panelId, {
    newThread: true,
    selectedText: state.ai.selectedText || "",
  });
}

async function sendAiMessage() {
  if (!state.ai) return;
  const question = el.aiInput.value.trim();
  if (!question) return;
  if (!state.aiConfigured) {
    toast("未配置 cursor-agent（请先 login）");
    return;
  }

  const panel = state.panels.get(state.ai.panelId);
  if (!panel?.detail) return;
  const d = panel.detail;
  const record = ensureAiRecord(d);
  const thread = record.threads.find((t) => t.id === state.ai.threadId);
  if (!thread) return;

  thread.messages.push({
    role: "user", content: question, ts: new Date().toISOString(),
  });
  thread.updatedAt = new Date().toISOString();
  if (state.ai.selectedText && !thread.selectedText) {
    thread.selectedText = state.ai.selectedText;
  }
  persistAiRecord(d, record);
  el.aiInput.value = "";
  el.aiSend.disabled = true;
  el.aiSend.textContent = "分析中…";
  renderAiUi();

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
      selected_text: state.ai.selectedText || thread.selectedText || "",
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
    refreshAiPanelBadge(state.ai.panelId);
    renderAiUi();
  } catch (e) {
    toast("AI 分析失败: " + e.message);
    thread.messages.pop();
    persistAiRecord(d, record);
    renderAiUi();
  } finally {
    el.aiSend.disabled = false;
    el.aiSend.textContent = "发送";
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

el.projectSelect.addEventListener("change", (e) => setProject(e.target.value));
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
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) el.searchResults.classList.add("hidden");
});

el.codeCtxMenu.addEventListener("click", (e) => {
  const item = e.target.closest(".ctx-item");
  if (!item || !codeCtxState) return;
  e.stopPropagation();
  const action = item.dataset.action;
  const { panelId, selectedText, tokenEl } = codeCtxState;
  closeCodeContextMenu();
  if (action === "ai") {
    openAiDrawer(panelId, {
      selectedText,
      prefill: selectedText
        ? "请分析以下选中代码可能的几种情况（时序/分支/多核）："
        : "",
    });
  } else if (action === "usages" && tokenEl) {
    navFromToken(panelId, tokenEl, { type: "contextmenu" });
  }
});

el.aiDrawerClose.addEventListener("click", closeAiDrawer);
el.aiNewThread.addEventListener("click", newAiThread);
el.aiSend.addEventListener("click", sendAiMessage);
el.aiInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendAiMessage();
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
