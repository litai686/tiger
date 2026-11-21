// 项目管理视图：事件绑定、布局、刷新调度、状态栏与 SSE 联动
import { t as _t, tV } from "../../i18n.js";
import { copyText } from "../shared/clipboard.js";
import { state } from "./store.js";
import * as store from "./store.js";
import * as api from "./api.js";
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
  const newBtn = /** @type {HTMLElement|null} */ (state.root.querySelector("#projects-new-btn"));
  if (newBtn) {
    newBtn.title = _t("新建 / 上传");
    // 老服务端没有 workspace_files_create：隐藏入口（否则点了只会报错）
    newBtn.style.display = state.caps.create ? "" : "none";
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
  syncUploadProgressUI();
}

// ===== 上传进度条（预览按钮那一栏；事件驱动，不触发整页 render） =====
/** 把字节数格式化成紧凑的 B / KB / MB / GB 文本。 */
function formatBytes(n) {
  const value = Number(n) || 0;
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return (unit === 0 || size >= 100 ? Math.round(size) : size.toFixed(1)) + " " + units[unit];
}

function uploadNode(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/** 按 store 的上传快照填充预览栏的 #projects-upload-progress（无上传时隐藏）。 */
export function syncUploadProgressUI() {
  const box = document.getElementById("projects-upload-progress");
  if (!box) return;
  const up = store.uploadState();
  if (!up.active) {
    box.style.display = "none";
    box.textContent = "";
    return;
  }
  box.style.display = "";
  const pct = up.total > 0 ? Math.min(100, Math.floor((up.received / up.total) * 100)) : 0;
  const name = uploadNode("span", "projects-upload-name", up.name || "");
  name.title = up.name || "";
  const label = up.index > 0
    ? tV("上传中 {i}/{n} · {p}%", { i: up.index, n: up.count || up.index, p: pct })
    : _t("上传中...");
  const text = uploadNode("span", "projects-upload-text", label);
  const bar = uploadNode("span", "projects-upload-bar");
  const fill = uploadNode("i");
  fill.style.width = pct + "%";
  bar.appendChild(fill);
  const bytes = uploadNode("span", "projects-upload-bytes", formatBytes(up.received) + " / " + formatBytes(up.total));
  box.replaceChildren(name, text, bar, bytes);
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
  } else if (state.deletedRoot) {
    message = _t("项目根目录已删除");
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
  if (
    state.rename.path &&
    (action === "select-file" || action === "toggle-dir" || action === "retry-dir") &&
    path !== state.rename.path
  ) {
    store.cancelRename();
  }
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
    case "edit":
      await editFile(state.selection.path);
      break;
    case "save-edit":
      await store.saveEdit();
      break;
    case "cancel-edit":
      store.cancelEdit();
      break;
    case "rename":
      store.startRename(state.selection.path, false);
      break;
    case "delete-file":
      if (state.selection.path) confirmDelete(state.selection.path, false);
      break;
    case "new-menu": {
      const rect = target.getBoundingClientRect();
      openEntryMenu("", { clientX: rect.left, clientY: rect.bottom });
      break;
    }
    case "delete-project": {
      const project = state.projects.find(function (p) {
        return p.path === path;
      });
      if (!project) break;
      state.projectsMenuOpen = false;
      store.notify();
      confirmDeleteProject(project);
      break;
    }
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
    case "download-file":
      await downloadFileToLocal(state.selection.path);
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

// ===== 右键菜单：文件行 → 编辑/下载/重命名；目录行 → 重命名；空白区一律屏蔽浏览器默认菜单 =====

function hideCtxMenu() {
  const old = document.getElementById("projects-ctx-menu");
  if (old) old.remove();
}

function showToast(text) {
  if (/** @type {any} */ (window).showGlobalToast) /** @type {any} */ (window).showGlobalToast(text);
}

/** 选中并进入编辑；脏草稿未保存时 selectFile 会拒绝切文件，这里同步放弃。 */
async function editFile(path) {
  if (!path || !state.wsId) return;
  if (state.selection.path !== path || !state.file.data) {
    await store.selectFile(path);
    if (state.destroyed || state.selection.path !== path) return;
  }
  if (!store.canEditSelection()) {
    showToast(store.editBlockedReason());
    return;
  }
  store.startEdit();
}

function addCtxItem(menu, label, onPick) {
  const item = document.createElement("div");
  item.textContent = _t(label);
  item.style.cssText = "padding:6px 16px;font-size:12px;cursor:pointer;color:var(--c-text-2);";
  item.addEventListener("mouseenter", function () { item.style.background = "var(--c-raise-2)"; });
  item.addEventListener("mouseleave", function () { item.style.background = "transparent"; });
  item.addEventListener("click", function () {
    menu.remove();
    onPick();
  });
  menu.appendChild(item);
}

async function downloadFileToLocal(path) {
  if (!state.wsId || !path) return;
  // 立即进入下载态：事件未到前按钮先显示「下载中...」
  state.download = { path, received: 0, total: 0, active: true };
  store.notify();
  try {
    const saved = await api.invokeCmd("download_workspace_file", { workspaceId: state.wsId, path });
    state.download = { path: "", received: 0, total: 0, active: false };
    store.notify();
    if (saved) showToast(_t("已下载到: ") + saved);
  } catch (e) {
    state.download = { path: "", received: 0, total: 0, active: false };
    store.notify();
    const message = api.errorMessage(e);
    // 用户在保存对话框点取消不是错误，不弹提示
    if (message.indexOf("取消") !== -1) return;
    showToast(_t("下载文件失败: ") + message);
  }
}

function newCtxMenu(event) {
  const menu = document.createElement("div");
  menu.id = "projects-ctx-menu";
  menu.style.cssText = "position:fixed;background:var(--c-raise);border:1px solid var(--c-border);border-radius:8px;padding:4px 0;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.4);min-width:120px;";
  // 靠近窗口右/下边缘时回退，避免菜单溢出屏幕
  menu.style.left = Math.min(event.clientX, window.innerWidth - 140) + "px";
  menu.style.top = Math.min(event.clientY, window.innerHeight - 60) + "px";
  return menu;
}

function showCtxMenu(menu, event, items) {
  // 菜单高度按条目数计算，靠下时向上回退
  menu.style.top = Math.min(event.clientY, window.innerHeight - (items * 30 + 12)) + "px";
  document.body.appendChild(menu);
  setTimeout(function () {
    document.addEventListener("mousedown", function closeHandler(ev) {
      if (!menu.contains(/** @type {Node} */ (ev.target))) {
        menu.remove();
        document.removeEventListener("mousedown", closeHandler);
      }
    });
  }, 0);
}

function onContextMenu(event) {
  // 空白区（非文件行）也一律屏蔽 WebView 默认右键菜单
  event.preventDefault();
  hideCtxMenu();
  if (!state.wsId) return;
  const target = /** @type {Element|null} */ (event.target);
  if (!target || !target.closest) return;

  // 项目列表行：删除项目根目录（物理删除，并同步移除 Agent 工作目录列表）
  const projectRow = /** @type {HTMLElement|null} */ (target.closest("[data-project-root]"));
  if (projectRow) {
    const projectPath = projectRow.getAttribute("data-path") || "";
    if (!state.caps.remove || !projectPath) return;
    const project = state.projects.find(function (p) {
      return p.path === projectPath;
    });
    if (!project || !store.canDeleteProject(project)) return;
    const menu = newCtxMenu(event);
    addCtxItem(menu, "删除项目根目录", function () {
      state.projectsMenuOpen = false;
      store.notify();
      confirmDeleteProject(project);
    });
    showCtxMenu(menu, event, 1);
    return;
  }

  const row = /** @type {HTMLElement|null} */ (target.closest("[data-kind]"));
  if (!row) {
    // 根节点行与树空白区：在项目根目录新建/上传
    if (target.closest("[data-root-dir]") || target.closest("#projects-tree")) {
      openEntryMenu("", event);
    }
    return;
  }
  const path = row.getAttribute("data-path") || "";
  const kind = row.getAttribute("data-kind") || "file";
  const deleted = row.hasAttribute("data-deleted");
  const external = row.hasAttribute("data-external");
  if (!path) return;

  const menu = newCtxMenu(event);

  let items = 0;
  if (kind === "file" && !deleted) {
    if (state.caps.write) {
      addCtxItem(menu, "编辑", function () { editFile(path); });
      items++;
    }
    addCtxItem(menu, "下载到本地", function () { downloadFileToLocal(path); });
    items++;
  }
  if (state.caps.create && kind === "dir" && !deleted && !external) {
    addCtxItem(menu, "新建文件", function () { promptCreate(path, false); });
    items++;
    addCtxItem(menu, "新建文件夹", function () { promptCreate(path, true); });
    items++;
    addCtxItem(menu, "上传文件", function () { store.uploadFiles(path); });
    items++;
  }
  if (state.caps.write && !deleted && !external) {
    addCtxItem(menu, "重命名", function () { store.startRename(path, kind === "dir"); });
    items++;
  }
  // 目录删除由服务端递归处理；external 行删的是链接本身，不动目标。
  if (state.caps.remove && !deleted) {
    addCtxItem(menu, "删除", function () { confirmDelete(path, kind === "dir"); });
    items++;
  }
  if (!items) return;

  showCtxMenu(menu, event, items);
}

// ===== 文件树：新建文件/文件夹、上传（新建走 files/create，上传走 Rust 原生多选 + files/upload） =====

/**
 * 在 parentDir（"" = 项目根）打开「新建文件 / 新建文件夹 / 上传文件」菜单。
 * @param {string} parentDir
 * @param {{clientX:number, clientY:number}} event
 */
function openEntryMenu(parentDir, event) {
  if (!state.caps.create || !state.wsId) return;
  hideCtxMenu();
  const menu = newCtxMenu(event);
  addCtxItem(menu, "新建文件", function () { promptCreate(parentDir, false); });
  addCtxItem(menu, "新建文件夹", function () { promptCreate(parentDir, true); });
  addCtxItem(menu, "上传文件", function () { store.uploadFiles(parentDir); });
  showCtxMenu(menu, event, 3);
}

/**
 * 新建文件/文件夹：先弹名称输入框，成功后文件自动选中。
 * @param {string} parentDir
 * @param {boolean} isDir
 */
function promptCreate(parentDir, isDir) {
  openPrompt(
    isDir ? _t("新建文件夹") : _t("新建文件"),
    isDir ? _t("文件夹名称") : _t("文件名（含扩展名）"),
    function (name) {
      store.createEntry(parentDir, name, isDir).then(function (path) {
        if (path && !isDir) store.selectFile(path);
      });
    }
  );
}

/**
 * 输入名称的视图内弹窗：Enter 确认、Esc / 点遮罩取消，空名称时确定按钮禁用。
 * @param {string} title
 * @param {string} placeholder
 * @param {(name: string) => void} onOk
 */
function openPrompt(title, placeholder, onOk) {
  if (!state.root) return;
  const host = /** @type {HTMLElement|null} */ (state.root.querySelector("#projects-view"));
  if (!host) return;
  if (closeOverlay) closeOverlay();

  const overlay = document.createElement("div");
  overlay.className = "projects-overlay";
  const modal = document.createElement("div");
  modal.className = "projects-modal";
  const titleEl = document.createElement("div");
  titleEl.className = "projects-modal-title";
  titleEl.textContent = title;
  const input = document.createElement("input");
  input.className = "projects-prompt-input";
  input.spellcheck = false;
  input.placeholder = placeholder;
  const actions = document.createElement("div");
  actions.className = "projects-modal-actions";
  const cancel = document.createElement("button");
  cancel.className = "projects-btn";
  cancel.textContent = _t("取消");
  const ok = document.createElement("button");
  ok.className = "projects-btn projects-btn-primary";
  ok.textContent = _t("确定");
  ok.disabled = true;
  actions.appendChild(cancel);
  actions.appendChild(ok);
  modal.appendChild(titleEl);
  modal.appendChild(input);
  modal.appendChild(actions);
  overlay.appendChild(modal);

  function submit() {
    const name = input.value.trim();
    if (!name) return;
    close();
    onOk(name);
  }
  function close() {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    if (closeOverlay === close) closeOverlay = null;
  }
  function onKey(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      submit();
    }
  }
  closeOverlay = close;
  input.addEventListener("input", function () {
    ok.disabled = !input.value.trim();
  });
  cancel.addEventListener("click", close);
  ok.addEventListener("click", submit);
  overlay.addEventListener("mousedown", function (ev) {
    if (ev.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  host.appendChild(overlay);
  input.focus();
}

// ===== 删除确认弹窗（Tauri WebView 中原生 confirm() 不可用，视图内自建遮罩） =====

/** @type {null|(() => void)} */
let closeOverlay = null;

/**
 * 打开视图内确认遮罩；Enter 确认、Esc / 点遮罩取消。
 * @param {string} message
 * @param {() => void} onOk
 */
function openConfirm(message, onOk) {
  if (!state.root) return;
  const host = /** @type {HTMLElement|null} */ (state.root.querySelector("#projects-view"));
  if (!host) return;
  if (closeOverlay) closeOverlay();

  const overlay = document.createElement("div");
  overlay.className = "projects-overlay";
  const modal = document.createElement("div");
  modal.className = "projects-modal";
  const title = document.createElement("div");
  title.className = "projects-modal-title";
  title.textContent = _t("确认删除");
  const text = document.createElement("div");
  text.className = "projects-confirm-text";
  text.textContent = message;
  const actions = document.createElement("div");
  actions.className = "projects-modal-actions";
  const cancel = document.createElement("button");
  cancel.className = "projects-btn";
  cancel.textContent = _t("取消");
  const ok = document.createElement("button");
  ok.className = "projects-btn projects-btn-danger";
  ok.textContent = _t("删除");
  actions.appendChild(cancel);
  actions.appendChild(ok);
  modal.appendChild(title);
  modal.appendChild(text);
  modal.appendChild(actions);
  overlay.appendChild(modal);

  function close() {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    if (closeOverlay === close) closeOverlay = null;
  }
  function onKey(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      close();
      onOk();
    }
  }
  closeOverlay = close;
  cancel.addEventListener("click", close);
  ok.addEventListener("click", function () {
    close();
    onOk();
  });
  overlay.addEventListener("mousedown", function (ev) {
    if (ev.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  host.appendChild(overlay);
  cancel.focus();
}

/**
 * 删除文件/目录（目录由服务端递归删除整棵子树）。
 * @param {string} target
 * @param {boolean} isDir
 */
function confirmDelete(target, isDir) {
  const message = isDir
    ? tV("确定删除目录「{path}」及其中的全部文件？此操作不可恢复。", { path: target })
    : tV("确定删除文件「{path}」？此操作不可恢复。", { path: target });
  openConfirm(message, function () {
    store.deleteEntry(target);
  });
}

/**
 * 删除项目根目录：物理删除整个目录，并从 Agent 工作目录列表移除。
 * @param {any} project
 */
function confirmDeleteProject(project) {
  const message = tV(
    "确定删除项目根目录「{path}」及其中的全部内容，并从 Agent 工作目录列表移除？磁盘上的所有文件都会被删除，此操作不可恢复。",
    { path: project.path }
  );
  openConfirm(message, function () {
    store.deleteProjectRoot(project);
  });
}

// ===== 下载进度事件（Rust download_workspace_file 流式读取时按百分比发射） =====

/** @type {null|(() => void)} */
let unlistenProgress = null;

async function bindProgress() {
  if (!window.__agent_listen) return;
  try {
    const unlisten = await window.__agent_listen("workspace-download-progress", function (event) {
      const payload = event && event.payload;
      if (!payload || payload.workspace_id !== state.wsId) return;
      state.download = {
        path: String(payload.path || ""),
        received: Number(payload.received) || 0,
        total: Number(payload.total) || 0,
        active: true,
      };
      store.notify();
    });
    if (state.destroyed) {
      try {
        unlisten();
      } catch (_) {}
      return;
    }
    unlistenProgress = unlisten;
  } catch (_) {}
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
  store.onToast(showToast);
  store.onUploadChange(syncUploadProgressUI);
  root.addEventListener("click", onClick);
  root.addEventListener("dblclick", onDblClick);
  root.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("click", onDocumentClick);
  const splitter = root.querySelector("#projects-splitter");
  if (splitter) splitter.addEventListener("mousedown", onSplitterDown);
  document.addEventListener("visibilitychange", onVisibilityChange);
  pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
  bindSSE();
  bindProgress();
}

export function unbind() {
  if (boundRoot) {
    boundRoot.removeEventListener("click", onClick);
    boundRoot.removeEventListener("dblclick", onDblClick);
    boundRoot.removeEventListener("contextmenu", onContextMenu);
    document.removeEventListener("click", onDocumentClick);
    const splitter = boundRoot.querySelector("#projects-splitter");
    if (splitter) splitter.removeEventListener("mousedown", onSplitterDown);
    boundRoot = null;
  }
  // 清理 body 级右键菜单浮层：视图卸载后残留的 fixed 菜单会挡住新视图交互
  hideCtxMenu();
  // 上传进度条刷新随视图卸载注销；上传本身与事件监听继续（切页不丢进度）
  store.onUploadChange(null);
  // 删除确认遮罩随视图一起关闭，避免 keydown 监听泄漏
  if (closeOverlay) closeOverlay();
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
  if (unlistenProgress) {
    try {
      unlistenProgress();
    } catch (_) {}
    unlistenProgress = null;
  }
}

