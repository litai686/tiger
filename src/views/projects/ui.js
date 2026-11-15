// 项目管理视图：事件绑定、布局、刷新调度、状态栏与 SSE 联动
import { t as _t } from "../../i18n.js";
import { copyText } from "../shared/clipboard.js";
import { state } from "./store.js";
import * as store from "./store.js";
import { badgeOf } from "./git.js";
import { renderProjectsList } from "./projects_list.js";
import { renderTree } from "./tree.js";
import { renderContent } from "./viewer.js";

const SIDEBAR_KEY = "projects.sidebarWidth";
const POLL_INTERVAL_MS = 15000;
const POLL_BACKOFF_MS = 30000;
const SSE_DEBOUNCE_MS = 800;

let boundRoot = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let pollTimer = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let debounceTimer = null;
let pollDelay = POLL_INTERVAL_MS;

/** 注册渲染入口：store 数据变化时调用。 */
export function render() {
  if (!state.root || state.destroyed) return;
  const view = /** @type {HTMLElement|null} */ (state.root.querySelector("#projects-view"));
  if (!view) return;
  const width = Number(localStorage.getItem(SIDEBAR_KEY) || 300);
  view.style.setProperty("--projects-sidebar-width", (width >= 220 && width <= 480 ? width : 300) + "px");

  const activeProject = state.projects.find(function (p) {
    return p.path === state.activePath;
  });
  const selectName = /** @type {HTMLElement|null} */ (state.root.querySelector("#projects-select-name"));
  if (selectName) {
    if (activeProject) {
      selectName.textContent = (activeProject.isDefault ? "★ " : "") + (activeProject.name || activeProject.path);
      selectName.title = activeProject.path;
    } else if (state.projectsLoading) {
      selectName.textContent = _t("正在加载项目...");
      selectName.title = "";
    } else {
      selectName.textContent = _t("还没有加载项目");
      selectName.title = "";
    }
  }
  const selectBtn = /** @type {HTMLElement|null} */ (state.root.querySelector("#projects-select"));
  if (selectBtn) selectBtn.classList.toggle("open", state.projectsMenuOpen);
  const selectArrow = /** @type {HTMLElement|null} */ (state.root.querySelector("#projects-select-arrow"));
  if (selectArrow) selectArrow.textContent = state.projectsMenuOpen ? "▴" : "▾";
  const menu = /** @type {HTMLElement|null} */ (state.root.querySelector("#projects-select-menu"));
  if (menu) {
    renderProjectsList(menu);
    menu.classList.toggle("show", state.projectsMenuOpen);
  }
  const tree = /** @type {HTMLElement|null} */ (state.root.querySelector("#projects-tree"));
  if (tree) renderTree(tree);
  const content = /** @type {HTMLElement|null} */ (state.root.querySelector("#projects-content"));
  if (content) {
    if (state.pageError) {
      renderPageError(content);
    } else {
      renderContent(content);
    }
  }
  renderBanner(view);
  renderStatusBar();
}

function placeholder(container, text, action) {
  container.textContent = "";
  const box = document.createElement("div");
  box.className = "projects-placeholder";
  box.textContent = _t(text);
  container.appendChild(box);
  if (action) {
    const wrap = document.createElement("div");
    wrap.className = "projects-placeholder";
    const button = document.createElement("button");
    button.className = "projects-btn";
    button.textContent = _t(action.label);
    button.setAttribute("data-action", action.action);
    wrap.appendChild(button);
    container.appendChild(wrap);
  }
}

function renderPageError(container) {
  container.textContent = "";
  const box = document.createElement("div");
  box.className = "projects-placeholder";
  box.textContent = _t(state.pageError);
  container.appendChild(box);
  if (state.pageError === "未连接服务端") {
    const wrap = document.createElement("div");
    wrap.className = "projects-placeholder";
    const button = document.createElement("button");
    button.className = "projects-btn";
    button.textContent = _t("去设置连接服务端");
    button.setAttribute("data-action", "goto-settings");
    wrap.appendChild(button);
    container.appendChild(wrap);
  }
}

function renderBanner(view) {
  const banner = /** @type {HTMLElement|null} */ (view.querySelector("#projects-banner"));
  const text = /** @type {HTMLElement|null} */ (view.querySelector("#projects-banner-text"));
  if (!banner || !text) return;
  banner.className = "projects-banner";
  let message = "";
  let level = "warn";
  if (state.statusStatus === 404 && state.activePath) {
    message = _t("工作区失效，请重新加载项目");
    level = "error";
  } else if (state.git && state.git.exists === false) {
    message = _t("服务端上该目录不存在或已失去访问权限");
    level = "error";
  } else if (state.staleTree) {
    message = _t("文件已变化，点击刷新");
  } else if (state.statusError) {
    message = _t("状态刷新失败: ") + state.statusError;
    level = "error";
  }
  if (!message) return;
  banner.classList.add("show", level);
  text.textContent = message;
}

function countBadges() {
  const counts = { modified: 0, added: 0, deleted: 0, renamed: 0, conflict: 0, untracked: 0 };
  if (!state.git || !state.git.isRepo) return counts;
  for (const entry of state.git.entries.values()) {
    const badge = badgeOf(entry);
    if (counts[badge] !== undefined) counts[badge]++;
  }
  return counts;
}

function appendStatusCounts(bar, item) {
  const counts = countBadges();
  const parts = [];
  if (counts.modified) parts.push(counts.modified + " " + _t("已修改"));
  if (counts.added) parts.push(counts.added + " " + _t("新增"));
  if (counts.deleted) parts.push(counts.deleted + " " + _t("已删除"));
  if (counts.renamed) parts.push(counts.renamed + " " + _t("已重命名"));
  if (counts.conflict) parts.push(counts.conflict + " " + _t("冲突"));
  if (counts.untracked) parts.push(counts.untracked + " " + _t("未跟踪"));
  if (parts.length) bar.appendChild(item(parts.join(" · ")));
  if (state.git && state.git.truncated) bar.appendChild(item(_t("状态已截断")));
}

function appendRefreshInfo(bar, item) {
  if (state.statusError) {
    bar.appendChild(item(_t("状态刷新失败: ") + state.statusError, "projects-status-error"));
    return;
  }
  if (state.lastStatusAt) {
    bar.appendChild(item(_t("最近刷新 ") + new Date(state.lastStatusAt).toLocaleTimeString()));
  }
}

function renderStatusBar() {
  if (!state.root) return;
  const bar = /** @type {HTMLElement|null} */ (state.root.querySelector("#projects-statusbar"));
  if (!bar) return;
  bar.textContent = "";
  if (!state.activePath) return;
  const item = function (text, className) {
    const el = document.createElement("span");
    el.className = "projects-status-item" + (className ? " " + className : "");
    el.textContent = text;
    return el;
  };
  if (!state.caps.git) {
    bar.appendChild(item(_t("服务端版本过低，请升级服务端后使用项目管理")));
    return;
  }
  if (state.statusLoading) {
    const spinner = document.createElement("span");
    spinner.className = "projects-spinner";
    bar.appendChild(spinner);
  }
  if (!state.git) {
    bar.appendChild(item(_t("加载中...")));
    return;
  }
  if (!state.git.exists) {
    bar.appendChild(item(_t("服务端上该目录不存在或已失去访问权限"), "projects-status-error"));
    return;
  }
  if (!state.git.isRepo) {
    const nested = state.git.nestedRepos || [];
    if (!nested.length) {
      bar.appendChild(item(_t("非 Git 仓库")));
      if (!state.git.gitInstalled) bar.appendChild(item(_t("服务端未安装 git")));
      return;
    }
    // 主目录不是仓库，但子目录里有仓库：展示聚合后的状态与仓库列表。
    const nestedItem = item(_t("子目录 Git 仓库") + ": " + nested.length);
    nestedItem.title = nested.join("\\n");
    bar.appendChild(nestedItem);
    appendStatusCounts(bar, item);
    const spacer = document.createElement("span");
    spacer.className = "projects-status-spacer";
    bar.appendChild(spacer);
    appendRefreshInfo(bar, item);
    return;
  }
  const branchText = state.git.detached ? "HEAD@" + state.git.head : "⎇ " + (state.git.branch || state.git.head || "-");
  bar.appendChild(item(branchText));
  if (state.git.ahead > 0) bar.appendChild(item("↑" + state.git.ahead));
  if (state.git.behind > 0) bar.appendChild(item("↓" + state.git.behind));

  appendStatusCounts(bar, item);
  const spacer = document.createElement("span");
  spacer.className = "projects-status-spacer";
  bar.appendChild(spacer);
  appendRefreshInfo(bar, item);
}

async function reloadProject() {
  const project = state.projects.find(function (p) {
    return p.path === state.activePath;
  });
  if (!project) return;
  state.wsId = "";
  await store.selectProject(project);
}

async function expandTo(dir) {
  const parts = String(dir || "").split("/").filter(Boolean);
  let acc = "";
  state.expanded.add("");
  for (const part of parts) {
    acc = acc ? acc + "/" + part : part;
    state.expanded.add(acc);
    await store.loadDir(acc);
  }
  store.notify();
}

async function onClick(event) {
  const target = /** @type {HTMLElement|null} */ (event.target && event.target.closest ? event.target.closest("[data-action]") : null);
  if (!target) return;
  const action = target.getAttribute("data-action");
  const path = target.getAttribute("data-path") || "";
  switch (action) {
    case "select-project": {
      const project = state.projects.find(function (p) {
        return p.path === path;
      });
      state.projectsMenuOpen = false;
      if (project) await store.selectProject(project);
      else store.notify();
      break;
    }
    case "toggle-dir":
      await store.toggleDir(path);
      break;
    case "select-file":
      await store.selectFile(path);
      break;
    case "retry-dir":
      await store.loadDir(path, true);
      break;
    case "tab":
      await store.setMode(target.getAttribute("data-mode") || "preview");
      break;
    case "staged":
      await store.setStaged(target.getAttribute("data-staged") === "1");
      break;
    case "refresh-file":
      await store.reloadSelection();
      break;
    case "copy-path":
      if (state.selection.path) copyText(state.selection.path, target);
      break;
    case "reload-project":
    case "refresh-all":
      await reloadProject();
      break;
    case "crumb-dir":
      await expandTo(path);
      break;
    case "toggle-project-menu":
      state.projectsMenuOpen = !state.projectsMenuOpen;
      store.notify();
      break;
    case "goto-settings":
      if (/** @type {any} */ (window).navigateTo) /** @type {any} */ (window).navigateTo("/settings?panel=server");
      break;
    default:
      break;
  }
}

/** 点击下拉之外的区域时收起工作目录下拉。 */
function onDocumentClick(event) {
  if (!state.projectsMenuOpen || !state.root) return;
  const wrap = state.root.querySelector("#projects-select-wrap");
  if (wrap && event.target instanceof Node && wrap.contains(event.target)) return;
  state.projectsMenuOpen = false;
  store.notify();
}

function onDblClick(event) {
  const target = /** @type {HTMLElement|null} */ (event.target && event.target.closest ? event.target.closest('[data-action="select-file"]') : null);
  if (!target) return;
  const path = target.getAttribute("data-path") || "";
  if (path && store.statusOf(path)) store.selectFile(path, "diff");
}

// ===== 左右分栏宽度 =====
let dragging = false;

function onSplitterDown(event) {
  dragging = true;
  event.preventDefault();
  document.addEventListener("mousemove", onSplitterMove);
  document.addEventListener("mouseup", onSplitterUp);
}

function onSplitterMove(event) {
  if (!dragging || !state.root) return;
  const view = /** @type {HTMLElement|null} */ (state.root.querySelector("#projects-view"));
  if (!view) return;
  const rect = view.getBoundingClientRect();
  let width = event.clientX - rect.left;
  if (width < 220) width = 220;
  if (width > 480) width = 480;
  view.style.setProperty("--projects-sidebar-width", width + "px");
}

function onSplitterUp() {
  dragging = false;
  document.removeEventListener("mousemove", onSplitterMove);
  document.removeEventListener("mouseup", onSplitterUp);
  if (!state.root) return;
  const view = /** @type {HTMLElement|null} */ (state.root.querySelector("#projects-view"));
  if (!view) return;
  const value = parseInt(view.style.getPropertyValue("--projects-sidebar-width"), 10);
  if (value >= 220 && value <= 480) localStorage.setItem(SIDEBAR_KEY, String(value));
}

// ===== 刷新调度 =====
function scheduleRefresh(delay) {
  state.staleTree = true;
  store.notify();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async function () {
    if (state.destroyed) return;
    await store.loadStatus();
    if (state.destroyed) return;
    if (state.expanded.size <= 10) {
      await store.refreshAll({ status: false, tree: true, file: false });
      state.staleTree = false;
      store.notify();
    }
  }, delay);
}

async function pollOnce() {
  if (state.destroyed || !state.wsId) return;
  if (!state.caps.git || !state.git || !state.git.isRepo || !state.git.gitInstalled) return;
  if (document.visibilityState !== "visible") return;
  const before = state.statusError;
  await store.loadStatus();
  if (state.statusError) pollDelay = POLL_BACKOFF_MS;
  else if (before) pollDelay = POLL_INTERVAL_MS;
}

/** 按 pollDelay 自调度下一次轮询：失败退避 30s，恢复后回到 15s。 */
async function pollLoop() {
  pollTimer = null;
  if (state.destroyed) return;
  await pollOnce();
  if (state.destroyed) return;
  pollTimer = setTimeout(pollLoop, pollDelay);
}

function onVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  if (state.staleTree) {
    store.refreshAll({ status: false, tree: true, file: false }).then(function () {
      state.staleTree = false;
      store.notify();
    });
  } else if (Date.now() - state.lastStatusAt > POLL_INTERVAL_MS) {
    store.loadStatus();
  }
}

async function bindSSE() {
  if (!window.__agent_listen) return;
  try {
    const unlisten = await window.__agent_listen("agent-sse-event", function (event) {
      const payload = event && event.payload;
      if (!payload || payload.workspace_id !== state.wsId) return;
      const type = payload.type;
      if (type !== "file" && type !== "run_complete") return;
      scheduleRefresh(SSE_DEBOUNCE_MS);
    });
    if (state.destroyed) {
      try {
        unlisten();
      } catch (_) {}
      return;
    }
    state.unlisten = unlisten;
  } catch (_) {}
}

/** @param {HTMLElement} root */
export function bind(root) {
  boundRoot = root;
  root.addEventListener("click", onClick);
  root.addEventListener("dblclick", onDblClick);
  document.addEventListener("click", onDocumentClick);
  const splitter = root.querySelector("#projects-splitter");
  if (splitter) splitter.addEventListener("mousedown", onSplitterDown);
  document.addEventListener("visibilitychange", onVisibilityChange);
  pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
  bindSSE();
}

export function unbind() {
  if (boundRoot) {
    boundRoot.removeEventListener("click", onClick);
    boundRoot.removeEventListener("dblclick", onDblClick);
    document.removeEventListener("click", onDocumentClick);
    const splitter = boundRoot.querySelector("#projects-splitter");
    if (splitter) splitter.removeEventListener("mousedown", onSplitterDown);
    boundRoot = null;
  }
  document.removeEventListener("visibilitychange", onVisibilityChange);
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  if (state.unlisten) {
    try {
      state.unlisten();
    } catch (_) {}
    state.unlisten = null;
  }
}

