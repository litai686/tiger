// 源码管理视图：事件绑定、提交流程、强确认弹窗、轮询与 SSE 联动
import { t as _t, tV as _tV } from "../../i18n.js";
import { copyText } from "../shared/clipboard.js";
import { basename } from "../projects/git.js";
import { state } from "./store.js";
import * as store from "./store.js";

const POLL_INTERVAL_MS = 15000;
const POLL_BACKOFF_MS = 30000;
const SSE_DEBOUNCE_MS = 800;
const SIDEBAR_KEY = "scm.sidebarWidth";

let boundRoot = null;
/** @type {ReturnType<typeof setInterval>|null} */
let pollTimer = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let debounceTimer = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let draftTimer = null;

/**
 * 强确认弹窗：danger 操作要求输入目标名或勾选确认。
 * @param {{title:string, body:string, danger?:boolean, requireText?:string, checkLabel?:string, okLabel?:string}} opts
 * @returns {Promise<boolean>}
 */
function openConfirm(opts) {
  return new Promise(function (resolve) {
    const overlay = document.getElementById("scm-modal");
    if (!overlay) {
      resolve(false);
      return;
    }
    overlay.textContent = "";
    const modal = document.createElement("div");
    modal.className = "scm-modal" + (opts.danger ? " danger" : "");
    const title = document.createElement("div");
    title.className = "scm-modal-title";
    title.textContent = (opts.danger ? _t("该操作不可恢复") + " \u00B7 " : "") + _t(opts.title);
    modal.appendChild(title);
    const body = document.createElement("div");
    body.className = "scm-modal-body";
    body.textContent = opts.body ? _t(opts.body) : "";
    modal.appendChild(body);

    let input = null;
    let check = null;
    if (opts.requireText) {
      const label = document.createElement("label");
      label.className = "scm-modal-field";
      label.textContent = _tV("输入 {name} 以确认", { name: opts.requireText });
      input = document.createElement("input");
      input.type = "text";
      input.placeholder = opts.requireText;
      label.appendChild(input);
      modal.appendChild(label);
    }
    if (opts.checkLabel) {
      const label = document.createElement("label");
      label.className = "scm-modal-check";
      check = document.createElement("input");
      check.type = "checkbox";
      label.appendChild(check);
      label.appendChild(document.createTextNode(_t(opts.checkLabel)));
      modal.appendChild(label);
    }

    const actions = document.createElement("div");
    actions.className = "scm-modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "scm-btn";
    cancel.textContent = _t("取消");
    const ok = document.createElement("button");
    ok.className = "scm-btn" + (opts.danger ? " danger" : "");
    ok.textContent = _t(opts.okLabel || "确定");
    actions.appendChild(cancel);
    actions.appendChild(ok);
    modal.appendChild(actions);

    function sync() {
      const typedOk = opts.requireText ? !!input && input.value.trim() === opts.requireText : true;
      const checkedOk = opts.checkLabel ? !!check && check.checked : true;
      ok.disabled = !(typedOk && checkedOk);
    }
    if (input) input.addEventListener("input", sync);
    if (check) check.addEventListener("change", sync);
    sync();

    function close(result) {
      overlay.removeEventListener("click", onOverlayClick);
      overlay.classList.remove("show");
      overlay.textContent = "";
      resolve(result);
    }
    function onOverlayClick(event) {
      if (event.target === overlay) close(false);
    }
    cancel.addEventListener("click", function () {
      close(false);
    });
    ok.addEventListener("click", function () {
      close(true);
    });
    overlay.addEventListener("click", onOverlayClick);
    overlay.appendChild(modal);
    overlay.classList.add("show");
    if (input) input.focus();
  });
}

/** @param {"smart"|"staged"|"all"} mode */
async function doCommit(mode) {
  if (!state.wsId || state.action.running) return;
  const message = String(state.message || "").trim();
  if (!message) {
    store.setActionError(_t("提交信息不能为空"));
    return;
  }
  const counts = store.changeCounts();
  let stageAll = mode === "all";
  if (!stageAll && !counts.staged) {
    if (!counts.total) {
      store.setActionError(_t("没有可提交的更改"));
      return;
    }
    if (mode === "staged") {
      store.setActionError(_t("没有已暂存的更改"));
      return;
    }
    const ok = await openConfirm({
      title: "提交",
      body: "尚未暂存任何更改，是否暂存全部更改并提交？",
      okLabel: "暂存全部并提交",
    });
    if (!ok) return;
    stageAll = true;
  }
  store.setCommitMenu(false);
  await store.commit(message, { stageAll });
}

function activeProject() {
  return state.projects.find(function (p) {
    return p.path === state.activePath;
  });
}

async function onClick(event) {
  const target = /** @type {HTMLElement|null} */ (event.target && event.target.closest ? event.target.closest("[data-action]") : null);
  if (!target) return;
  const action = target.getAttribute("data-action");
  const path = target.getAttribute("data-path") || "";
  switch (action) {
    case "select-repo": {
      const project = state.projects.find(function (p) {
        return p.path === path;
      });
      store.setProjectsMenu(false);
      // 手动选择容器目录时保持聚合只读视图，不自动跳到子目录仓库。
      if (project) await store.selectProject(project, { autoNested: false });
      break;
    }
    case "toggle-repo-menu":
      store.setProjectsMenu(!state.projectsMenuOpen);
      break;
    case "reload-workspace": {
      const project = activeProject();
      if (project) {
        state.wsId = "";
        await store.selectProject(project, { autoNested: false });
      }
      break;
    }
    case "refresh":
      await store.refreshAll({ graph: true });
      break;
    case "refresh-diff":
      await store.reloadSelection();
      break;
    case "refresh-graph":
      await store.loadGraph(true);
      break;
    case "copy-path":
      if (state.selection.path) copyText(state.selection.path, target);
      break;
    case "copy-hash": {
      const hash = target.getAttribute("data-hash") || "";
      if (hash) {
        copyText(hash, null);
        store.showToast(_t("已复制") + " " + hash.substring(0, 7));
      }
      break;
    }
    case "diff-mode":
      store.setSelectionMode(target.getAttribute("data-staged") === "1");
      break;
    case "diff-view":
      store.setDiffView(target.getAttribute("data-view") || "split");
      break;
    case "toggle-commit":
      await store.toggleCommit(target.getAttribute("data-rev") || "");
      break;
    case "select-commit-file":
      await store.selectCommitFile(target.getAttribute("data-rev") || "", path);
      break;
    case "clear-commit-view":
      store.clearCommitSelection();
      break;
    case "select-entry":
      await store.selectEntry(path, target.getAttribute("data-staged") === "1");
      break;
    case "toggle-section": {
      const section = target.getAttribute("data-section") || "";
      if (section in state.sections) store.setSectionCollapsed(section, !state.sections[section]);
      break;
    }
    case "stage-file":
      await store.stageFile(path);
      break;
    case "unstage-file":
      await store.unstageFile(path);
      break;
    case "stage-all":
      await store.stageAll();
      break;
    case "unstage-all":
      await store.unstageAll();
      break;
    case "discard-file": {
      const entry = store.entryOf(path);
      if (!entry) break;
      const ok = await openConfirm({
        title: "丢弃更改",
        body: _tV("将丢弃 {path} 的未提交修改，且不受 Agent 撤销保护。", { path }),
        danger: true,
        requireText: basename(path),
        checkLabel: "我已知晓该操作可能丢失未提交的改动，且不受 Agent 撤销保护",
        okLabel: "丢弃",
      });
      if (ok) await store.discardFile(path);
      break;
    }
    case "discard-all": {
      const paths = store.unstagedEntries().filter(function (entry) {
        return !entry.untracked;
      }).map(function (entry) {
        return entry.path;
      });
      if (!paths.length) {
        store.showToast(_t("没有可丢弃的已跟踪更改"), true);
        break;
      }
      const ok = await openConfirm({
        title: "全部丢弃",
        body: _tV("将丢弃 {n} 个已跟踪文件的未提交修改；未跟踪文件不会被删除。", { n: paths.length }),
        danger: true,
        checkLabel: "我已知晓该操作可能丢失未提交的改动，且不受 Agent 撤销保护",
        okLabel: "全部丢弃",
      });
      if (ok) await store.discardAll(paths);
      break;
    }
    case "toggle-commit-menu":
      store.setCommitMenu();
      break;
    case "commit":
      await doCommit("smart");
      break;
    case "commit-staged":
      store.setCommitMenu(false);
      await doCommit("staged");
      break;
    case "commit-all":
      store.setCommitMenu(false);
      await doCommit("all");
      break;
    case "clear-output":
      store.clearActionOutput();
      break;
    case "goto-settings":
      if (/** @type {any} */ (window).navigateTo) /** @type {any} */ (window).navigateTo("/settings?panel=server");
      break;
    default:
      break;
  }
}

function onInput(event) {
  const target = /** @type {HTMLTextAreaElement|null} */ (event.target);
  if (!target || target.id !== "scm-commit-input") return;
  store.setMessage(target.value);
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(function () {
    store.saveDraft();
  }, 300);
}

function onKeydown(event) {
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
  const target = /** @type {HTMLElement|null} */ (event.target);
  if (!target || target.id !== "scm-commit-input") return;
  event.preventDefault();
  void doCommit("smart");
}

function onChange(event) {
  const target = /** @type {HTMLInputElement|null} */ (event.target);
  if (target && target.id === "scm-graph-auto") store.setGraphAuto(target.checked);
}

/** 点击下拉 / 提交菜单之外的区域时收起。 */
function onDocumentClick(event) {
  if (!state.root) return;
  const node = event.target instanceof Node ? event.target : null;
  if (state.projectsMenuOpen) {
    const wrap = state.root.querySelector("#scm-select-wrap");
    if (!(wrap && node && wrap.contains(node))) store.setProjectsMenu(false);
  }
  if (state.commitMenuOpen) {
    const actions = state.root.querySelector(".scm-commit-actions");
    if (!(actions && node && actions.contains(node))) store.setCommitMenu(false);
  }
}

// ===== 图表提交悬停详情 =====
// 图表不出横向滚动条，提交说明超宽截断；鼠标悬停时在右侧弹出作者/时间/完整信息与增删统计。
let hoverShowTimer = null;
let hoverHideTimer = null;
let popRev = "";

function elNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function cancelPopTimers() {
  if (hoverShowTimer) {
    clearTimeout(hoverShowTimer);
    hoverShowTimer = null;
  }
  if (hoverHideTimer) {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = null;
  }
}

function hideCommitPop() {
  cancelPopTimers();
  popRev = "";
  const pop = document.getElementById("scm-commit-pop");
  if (pop) {
    pop.classList.remove("show");
    pop.textContent = "";
  }
}

function formatCommitDate(iso) {
  const time = Date.parse(String(iso || ""));
  if (!time) return String(iso || "");
  const d = new Date(time);
  const pad = function (n) {
    return String(n).padStart(2, "0");
  };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function renderCommitPop(pop, rev) {
  pop.textContent = "";
  const detail = store.commitDetailOf(rev);
  const head = elNode("div", "scm-pop-head");
  head.appendChild(elNode("span", "scm-pop-icon", "\u25CF"));
  head.appendChild(elNode("span", "scm-pop-hash", rev.substring(0, 7)));
  if (detail && detail.data) {
    if (detail.data.author) head.appendChild(elNode("span", "scm-pop-author", detail.data.author));
    const when = formatCommitDate(detail.data.date);
    if (when) head.appendChild(elNode("span", "scm-pop-date", when));
  }
  pop.appendChild(head);
  if (!detail || detail.loading) {
    pop.appendChild(elNode("div", "scm-pop-empty", _t("加载中...")));
    return;
  }
  if (detail.error) {
    pop.appendChild(elNode("div", "scm-pop-empty scm-status-error", _t("加载失败") + ": " + detail.error));
    return;
  }
  const data = detail.data;
  if (!data) {
    pop.appendChild(elNode("div", "scm-pop-empty", _t("无数据")));
    return;
  }
  if (data.subject) pop.appendChild(elNode("div", "scm-pop-subject", data.subject));
  if (data.body) pop.appendChild(elNode("div", "scm-pop-body", data.body));
  pop.appendChild(elNode("div", "scm-pop-stats", _tV("已更改 {files} 个文件, {adds} 行插入(+), {dels} 行删除(-)", {
    files: data.files,
    adds: data.adds,
    dels: data.dels,
  })));
}

function positionCommitPop(pop, row) {
  const rect = row.getBoundingClientRect();
  const graph = state.root ? state.root.querySelector("#scm-graph") : null;
  const anchor = graph ? graph.getBoundingClientRect() : rect;
  // 底部 TAB 栏（#hardware-bar）始终可见，卡片底边最多到栏顶，不能盖住它。
  const bar = document.getElementById("hardware-bar");
  const bottomLimit = (bar ? bar.getBoundingClientRect().top : window.innerHeight) - 8;
  const minTop = 8;
  const gap = 10;
  pop.style.left = "0px";
  pop.style.top = "0px";
  pop.style.maxHeight = "";
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  let left = anchor.right + gap;
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
  let top = rect.top;
  if (top + height > bottomLimit) top = bottomLimit - height;
  if (top < minTop) {
    // 上方空间不足时压缩卡片高度（正文另有 32vh 限高），而不是越到底部 TAB 栏上。
    top = minTop;
    pop.style.maxHeight = Math.max(0, bottomLimit - minTop) + "px";
  }
  pop.style.left = left + "px";
  pop.style.top = top + "px";
}

async function showCommitPop(row, rev) {
  cancelPopTimers();
  const pop = document.getElementById("scm-commit-pop");
  if (!pop || !row.isConnected) return;
  popRev = rev;
  renderCommitPop(pop, rev);
  pop.classList.add("show");
  positionCommitPop(pop, row);
  const entry = await store.loadCommitDetail(rev);
  if (!entry || state.destroyed || popRev !== rev || !row.isConnected) return;
  renderCommitPop(pop, rev);
  positionCommitPop(pop, row);
}

function graphRowOf(event) {
  const target = /** @type {HTMLElement|null} */ (event.target);
  if (!target || !target.closest) return null;
  return /** @type {HTMLElement|null} */ (target.closest(".scm-graph-line[data-rev]"));
}

function onGraphHoverIn(event) {
  const row = graphRowOf(event);
  if (!row) return;
  const related = event.relatedTarget;
  if (related instanceof Node && row.contains(related)) return;
  const rev = row.getAttribute("data-rev") || "";
  if (!rev) return;
  const pop = document.getElementById("scm-commit-pop");
  // 从卡片移回同一行：卡片已展示就直接取消收起计时，不重播一次加载。
  if (popRev === rev && pop && pop.classList.contains("show")) {
    cancelPopTimers();
    return;
  }
  cancelPopTimers();
  hoverShowTimer = setTimeout(function () {
    if (!state.destroyed) void showCommitPop(row, rev);
  }, 180);
}

function onGraphHoverOut(event) {
  const row = graphRowOf(event);
  if (!row) return;
  const related = event.relatedTarget;
  if (related instanceof Node && row.contains(related)) return;
  if (popRev !== row.getAttribute("data-rev")) return;
  cancelPopTimers();
  hoverHideTimer = setTimeout(hideCommitPop, 220);
}

function onRootScroll(event) {
  const pop = document.getElementById("scm-commit-pop");
  if (pop && event.target instanceof Node && pop.contains(event.target)) return;
  if (popRev) hideCommitPop();
}

function bindCommitPop() {
  const pop = document.getElementById("scm-commit-pop");
  if (!pop) return;
  pop.addEventListener("mouseenter", cancelPopTimers);
  pop.addEventListener("mouseleave", function () {
    cancelPopTimers();
    hoverHideTimer = setTimeout(hideCommitPop, 160);
  });
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
  const view = state.root.querySelector("#scm-view");
  if (!(view instanceof HTMLElement)) return;
  const rect = view.getBoundingClientRect();
  let width = event.clientX - rect.left;
  if (width < 240) width = 240;
  if (width > 520) width = 520;
  view.style.setProperty("--scm-sidebar-width", width + "px");
}

function onSplitterUp() {
  dragging = false;
  document.removeEventListener("mousemove", onSplitterMove);
  document.removeEventListener("mouseup", onSplitterUp);
  if (!state.root) return;
  const view = state.root.querySelector("#scm-view");
  if (!(view instanceof HTMLElement)) return;
  const value = parseInt(view.style.getPropertyValue("--scm-sidebar-width"), 10);
  if (value >= 240 && value <= 520) {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(value));
    } catch (_) {}
  }
}

// ===== 刷新调度 =====
function scheduleRefresh() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async function () {
    if (state.destroyed) return;
    await store.loadStatus();
    if (state.destroyed) return;
    await store.reloadSelection();
  }, SSE_DEBOUNCE_MS);
}

async function pollOnce() {
  if (state.destroyed || !state.wsId || state.action.running) return;
  if (!state.caps.git || !state.git || !state.git.isRepo || !state.git.gitInstalled) return;
  if (document.visibilityState !== "visible") return;
  if (state.statusError && Date.now() - state.lastStatusAt < POLL_BACKOFF_MS) return;
  await store.loadStatus();
}

function onVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  if (state.destroyed || !state.wsId || state.action.running) return;
  if (Date.now() - state.lastStatusAt > POLL_INTERVAL_MS) {
    void store.loadStatus();
    void store.reloadSelection();
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
      scheduleRefresh();
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
  root.addEventListener("input", onInput);
  root.addEventListener("keydown", onKeydown);
  root.addEventListener("change", onChange);
  root.addEventListener("mouseover", onGraphHoverIn);
  root.addEventListener("mouseout", onGraphHoverOut);
  root.addEventListener("scroll", onRootScroll, true);
  bindCommitPop();
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("visibilitychange", onVisibilityChange);
  const splitter = root.querySelector("#scm-splitter");
  if (splitter) splitter.addEventListener("mousedown", onSplitterDown);
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  bindSSE();
}

export function unbind() {
  if (boundRoot) {
    boundRoot.removeEventListener("click", onClick);
    boundRoot.removeEventListener("input", onInput);
    boundRoot.removeEventListener("keydown", onKeydown);
    boundRoot.removeEventListener("change", onChange);
    boundRoot.removeEventListener("mouseover", onGraphHoverIn);
    boundRoot.removeEventListener("mouseout", onGraphHoverOut);
    boundRoot.removeEventListener("scroll", onRootScroll, true);
    const splitter = boundRoot.querySelector("#scm-splitter");
    if (splitter) splitter.removeEventListener("mousedown", onSplitterDown);
    boundRoot = null;
  }
  hideCommitPop();
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  if (state.unlisten) {
    try {
      state.unlisten();
    } catch (_) {}
    state.unlisten = null;
  }
}
