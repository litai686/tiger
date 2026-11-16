// 终端视图状态与数据流。
// 终端是服务端交互 PTY（内置本机目标或 SSH 目标）：输出走 SSE 增量 +
// output 轮询补齐，输入/尺寸走 POST；页面离开不结束会话。
import { t as _t } from "../../i18n.js";
import * as api from "./api.js";
import * as pty from "./pty.js";

const ACTIVE_PATH_KEY = "projects.activePath";
const ACTIVE_ID_PREFIX = "terminal.activeId.";
const LIST_POLL = 1500;
const JOB_TAIL_BYTES = 65536;

/** @type {any} */
export const state = {
  refs: null,
  destroyed: false,
  connecting: false,
  caps: null,
  pageError: "",
  banner: "",
  bannerKind: "info",

  workdirs: [],
  activePath: "",
  wsId: "",
  clientId: "",
  terminals: [],
  // 已点击关闭、等待服务端确认删除的会话 id：列表刷新时继续过滤，避免
  // 关闭前发出的列表响应把刚消失的会话又带回来（表现为“闪一下又出现”）。
  closingIds: new Set(),
  limits: null,
  jobs: [],
  targets: [],
  targetsError: "",
  modalOpen: false,
  modalTarget: "",
  modalName: "",
  modalBusy: false,
  modalError: "",

  activeId: "",
  activeJobId: "",
  jobOutput: null,

  visible: true,
  listTimer: null,
  sseUnlisten: null,
};

let renderFn = null;
let visibilityHandler = null;
// connectSeq invalidates in-flight connect() calls: switching workdirs or
// remounting bumps it so a late create_workspace response cannot overwrite
// the newer workspace.
let connectSeq = 0;

export function onRender(fn) {
  renderFn = fn;
}

function notify() {
  if (renderFn) renderFn();
}

export function init(root) {
  state.destroyed = false;
  state.refs = collectRefs(root);
  state.closingIds = new Set();
  state.modalOpen = false;
  state.modalBusy = false;
  state.modalError = "";
  state.clientId = crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
  pty.configure({
    wsId: "",
    clientId: state.clientId,
    container: state.refs.pty,
    onUpdate: notify,
    onError: handleError,
  });
  startSSE();
  visibilityHandler = function () {
    state.visible = document.visibilityState !== "hidden";
    if (!state.visible) {
      stopTimers();
      return;
    }
    refresh();
    // stopTimers 在隐藏时清掉了 LIST_POLL，恢复可见必须重新起表：否则列表/作业
    // 状态只在切工作区或重进页面时才会再刷新。
    scheduleList();
  };
  document.addEventListener("visibilitychange", visibilityHandler);
}

export function reset() {
  state.destroyed = true;
  connectSeq++;
  stopTimers();
  state.closingIds = new Set();
  pty.reset();
  state.modalOpen = false;
  state.modalBusy = false;
  state.modalError = "";
  if (state.sseUnlisten) {
    try { state.sseUnlisten(); } catch (_) {}
    state.sseUnlisten = null;
  }
  if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
  visibilityHandler = null;
  state.refs = null;
}

function collectRefs(root) {
  const pick = function (name) {
    return root.querySelector('[data-ref="' + name + '"]');
  };
  return {
    workdir: pick("workdir"),
    create: pick("create"),
    sshTargetHint: pick("ssh-target-hint"),
    banner: pick("banner"),
    side: pick("side"),
    statusName: pick("status-name"),
    statusCwd: pick("status-cwd"),
    statusTarget: pick("status-target"),
    statusState: pick("status-state"),
    attach: pick("attach"),
    reconnect: pick("reconnect"),
    output: pick("output"),
    pty: pick("pty"),
    killJob: pick("kill-job"),
    modal: pick("modal"),
    modalTarget: pick("modal-target"),
    modalName: pick("modal-name"),
    modalCreate: pick("modal-create"),
    modalCancel: pick("modal-cancel"),
    modalError: pick("modal-error"),
  };
}

async function startSSE() {
  if (state.sseUnlisten || typeof window.__agent_listen !== "function") return;
  try {
    state.sseUnlisten = await window.__agent_listen("agent-sse-event", function (event) {
      if (state.destroyed) return;
      pty.handleEvent(event);
    });
  } catch (_) {}
}

export async function bootstrap() {
  try {
    state.caps = await api.probeTerminal();
  } catch (_) {
    setPageError(_t("未连接服务端"));
    return;
  }
  if (state.destroyed) return;
  if (!state.caps || !state.caps.terminal || !state.caps.ssh) {
    setPageError(_t("服务端版本过低，请升级服务端后使用终端"));
    return;
  }
  await loadTerminalTargets();
  if (state.destroyed) return;
  await loadWorkdirs();
  if (state.destroyed) return;
  if (!state.activePath) {
    setPageError(_t("请先在 Agent 页的工作目录下拉中添加项目目录"));
    return;
  }
  await connect();
}

async function loadWorkdirs() {
  let dirs = [];
  let workspaces = [];
  try {
    dirs = await api.getWorkdirs();
  } catch (_) {}
  try {
    workspaces = await api.listWorkspaces();
  } catch (_) {}
  const map = new Map();
  (dirs || []).forEach(function (dir) {
    if (dir && dir.path) map.set(dir.path, { path: dir.path, isDefault: !!dir.is_default });
  });
  (workspaces || []).forEach(function (ws) {
    if (ws && ws.path && !map.has(ws.path)) map.set(ws.path, { path: ws.path, isDefault: false });
  });
  state.workdirs = Array.from(map.values());
  const saved = localStorage.getItem(ACTIVE_PATH_KEY) || "";
  const found = state.workdirs.find(function (w) { return w.path === saved; });
  const fallback = state.workdirs.find(function (w) { return w.isDefault; }) || state.workdirs[0];
  state.activePath = (found || fallback || {}).path || "";
}

async function connect() {
  const seq = ++connectSeq;
  const path = state.activePath;
  state.connecting = true;
  state.pageError = "";
  notify();
  try {
    const info = await api.createWorkspace(path, state.clientId);
    if (state.destroyed || seq !== connectSeq) return;
    if (!info || !info.workspace_id) throw new Error("server returned no workspace id");
    state.wsId = info.workspace_id;
    if (info.client_id) state.clientId = info.client_id;
    pty.configure({ wsId: state.wsId, clientId: state.clientId });
    localStorage.setItem(ACTIVE_PATH_KEY, path);
  } catch (_) {
    if (state.destroyed || seq !== connectSeq) return;
    state.connecting = false;
    setPageError(_t("未连接服务端"));
    return;
  }
  if (state.destroyed || seq !== connectSeq) return;

  try {
    await refreshListOnce();
  } catch (e) {
    if (state.destroyed || seq !== connectSeq) return;
    state.connecting = false;
    handleError(e);
    return;
  }
  if (state.destroyed || seq !== connectSeq) return;
  if (!state.terminals.length) {
    await createDefaultSession();
  } else {
    const savedId = localStorage.getItem(ACTIVE_ID_PREFIX + path) || "";
    const target = state.terminals.find(function (t) { return t.id === savedId; }) || state.terminals[0];
    selectTerminal(target.id);
  }
  if (state.destroyed || seq !== connectSeq) return;
  state.connecting = false;
  state.banner = "";
  state.bannerKind = "info";
  notify();
  scheduleList();
}

// reconnectWorkspace discards the stale workspace id and re-runs the
// create_workspace handshake. It is used when the server reports
// "workspace not found" (typically after a server restart).
function reconnectWorkspace() {
  if (state.connecting) return;
  state.wsId = "";
  state.terminals = [];
  state.closingIds = new Set();
  state.jobs = [];
  state.activeId = "";
  state.activeJobId = "";
  state.jobOutput = null;
  state.bannerKind = "warn";
  state.banner = _t("工作区已失效，正在重新连接...");
  notify();
  connect();
}

async function refreshListOnce() {
  const wsId = state.wsId;
  if (!wsId) return;
  const results = await Promise.all([
    api.listTerminals(wsId, "all"),
    api.listShellJobs(wsId),
  ]);
  // A workdir switch or reconnect may have replaced wsId while we waited.
  if (state.wsId !== wsId) return;
  const list = results[0] || {};
  const jobs = results[1] || {};
  // 过滤掉正在关闭的会话：服务端删除完成前，任何在途的列表响应都可能还
  // 带着它；本地已经移除了，就不能让它再出现在列表里。
  state.terminals = (list.terminals || []).filter(function (t) {
    return !state.closingIds.has(t.id);
  });
  state.limits = list.limits || null;
  state.jobs = jobs.jobs || [];
  if (state.activeId && !state.terminals.some(function (t) { return t.id === state.activeId; })) {
    resetActive();
  }
  if (state.activeJobId && !state.jobs.some(function (j) { return j.id === state.activeJobId; })) {
    state.activeJobId = "";
    state.jobOutput = null;
  }
  const active = state.terminals.find(function (t) { return t.id === state.activeId; });
  if (active && !pty.has(active.id)) pty.activate(active);
  notify();
}

async function loadTerminalTargets() {
  try {
    const res = await api.listTerminalTargets();
    state.targets = (res && res.targets) || [];
    state.targetsError = "";
  } catch (e) {
    state.targets = [];
    state.targetsError = api.errorMessage(e) || _t("无法读取服务端目标机配置");
  }
  if (!state.modalTarget || !state.targets.some(function (t) { return t.id === state.modalTarget; })) {
    state.modalTarget = state.targets.length ? state.targets[0].id : "";
  }
  if (state.modalOpen && !state.modalName && state.modalTarget) {
    const target = state.targets.find(function (t) { return t.id === state.modalTarget; });
    if (target) state.modalName = target.name || target.id;
  }
  notify();
}

export async function refresh() {
  try {
    await refreshListOnce();
  } catch (e) {
    handleError(e);
  }
  notify();
}

function scheduleList() {
  if (state.destroyed) return;
  clearTimeout(state.listTimer);
  state.listTimer = setTimeout(async function () {
    if (state.destroyed || !state.visible || !state.wsId) return;
    try {
      await refreshListOnce();
    } catch (e) {
      handleError(e);
    }
    scheduleList();
  }, LIST_POLL);
}

// createDefaultSession opens the interactive terminal on the built-in local
// target (the deployed server host) on first entry, so the page starts in a
// real PTY. It falls back to the first configured target when the server
// does not expose one.
async function createDefaultSession() {
  const target = state.targets.find(function (t) { return t.transport === "local"; }) || state.targets[0];
  if (!target) {
    setBanner("warn", state.targetsError || _t("服务端未配置目标机：请在 terminal-targets.json 中添加 SSH 目标"));
    return;
  }
  let terminal = null;
  try {
    terminal = await createPTYForTarget(target.id, target.name || "");
  } catch (e) {
    handleError(e);
  }
  if (!terminal) return;
  state.banner = "";
  state.bannerKind = "info";
  state.activeJobId = "";
  state.jobOutput = null;
  state.activeId = terminal.id;
  saveActiveId();
  try {
    await refreshListOnce();
  } catch (e) {
    handleError(e);
  }
  selectTerminal(terminal.id);
}

export function openTerminalModal() {
  if (!state.caps || !state.caps.ssh) return;
  state.modalOpen = true;
  state.modalError = "";
  loadTerminalTargets();
  if (!state.modalTarget && state.targets.length) state.modalTarget = state.targets[0].id;
  if (!state.modalName && state.modalTarget) {
    const target = state.targets.find(function (t) { return t.id === state.modalTarget; });
    state.modalName = target ? (target.name || target.id) : "";
  }
  notify();
}

export function closeTerminalModal() {
  state.modalOpen = false;
  state.modalBusy = false;
  state.modalError = "";
  notify();
}

export function setModalTarget(id) {
  state.modalTarget = id;
  const target = state.targets.find(function (t) { return t.id === id; });
  if (target) state.modalName = target.name || target.id;
  notify();
}

export function setModalName(name) {
  state.modalName = name;
}

async function createPTYForTarget(targetId, name) {
  const wsId = state.wsId;
  if (!wsId) return null;
  const res = await api.createTerminal(wsId, {
    kind: "pty",
    target_id: targetId,
    name: name || "",
    // Creating the session can block on the SSH dial timeout for remote
    // targets; the local target starts immediately.
    cols: 120,
    rows: 32,
    client_id: state.clientId,
  });
  if (state.destroyed || state.wsId !== wsId) return null;
  return res.terminal;
}

export async function createPTYTerminal() {
  if (!state.wsId || state.modalBusy || state.destroyed) return;
  if (!state.modalTarget) {
    state.modalError = _t("请选择目标机");
    notify();
    return;
  }
  state.modalBusy = true;
  state.modalError = "";
  notify();
  try {
    const terminal = await createPTYForTarget(state.modalTarget, state.modalName);
    if (!terminal) return;
    state.modalOpen = false;
    state.modalBusy = false;
    state.banner = "";
    state.bannerKind = "info";
    state.activeJobId = "";
    state.jobOutput = null;
    state.activeId = terminal.id;
    saveActiveId();
    await refreshListOnce();
    selectTerminal(terminal.id);
  } catch (e) {
    state.modalBusy = false;
    state.modalError = api.errorMessage(e) || _t("创建终端失败");
    handleError(e);
  } finally {
    state.modalBusy = false;
    notify();
  }
}

// closeTerminal closes one specific terminal. The active one is cleared and
// replaced by the next session; closing another row only refreshes the list.
export async function closeTerminal(id) {
  const targetId = id || state.activeId;
  if (!state.wsId || !targetId) return;
  const wsId = state.wsId;
  const ok = window.confirm(_t("关闭该终端？正在运行的程序会被终止。"));
  if (!ok) return;

  // 本端先移除并立即重绘，DELETE 放到后面等：服务端关闭会话要等 PTY 进程
  // 退出（CloseGrace 上限 5s），把关闭的视觉反馈绑在请求上会表现为“点了
  // 没反应”。DELETE 失败时，下一步的 refreshListOnce / 1.5s 轮询会把仍然
  // 存在的会话重新带回来。
  state.closingIds.add(targetId);
  const t0 = performance.now();
  pty.dispose(targetId);
  if (state.activeId === targetId) resetActive();
  state.terminals = state.terminals.filter(function (t) { return t.id !== targetId; });
  notify();
  const t1 = performance.now();

  let deleteErr = null;
  try {
    await api.deleteTerminal(wsId, targetId);
  } catch (e) {
    deleteErr = e;
  }
  const t2 = performance.now();
  if (state.wsId !== wsId) return;
  if (deleteErr) {
    // 关闭失败：会话还在服务端，解除过滤后由下一轮刷新带回来。
    state.closingIds.delete(targetId);
    handleError(deleteErr);
  } else {
    // 服务端已确认删除：再保留 10s，防止关闭前发出的列表响应把会话带回。
    setTimeout(function () { state.closingIds.delete(targetId); }, 10000);
  }
  try {
    await refreshListOnce();
  } catch (e) {
    handleError(e);
  }
  const t3 = performance.now();
  // 正常关闭是毫秒级；只在慢的时候记一行，避免刷日志。
  if (t3 - t0 > 500) {
    pty.terminalLog("close terminal=" + targetId +
      " dispose=" + (t1 - t0).toFixed(1) + "ms" +
      " delete=" + (t2 - t1).toFixed(1) + "ms" +
      " refresh=" + (t3 - t2).toFixed(1) + "ms");
  }
  if (!state.activeId && state.terminals.length) selectTerminal(state.terminals[0].id);
  notify();
}

// closeActive closes the selected terminal (the sidebar header button).
export async function closeActive() {
  return closeTerminal(state.activeId);
}

export async function takeoverActive() {
  if (!state.activeId) return;
  await pty.takeover(state.activeId);
}

export async function reconnectActive() {
  const terminal = state.terminals.find(function (t) { return t.id === state.activeId; });
  if (!terminal || !state.wsId) return;
  const wsId = state.wsId;
  const oldId = terminal.id;
  try {
    const res = await api.createTerminal(wsId, {
      kind: "pty",
      target_id: terminal.target_id,
      name: terminal.name || "",
      cols: 120,
      rows: 32,
      client_id: state.clientId,
    });
    if (state.wsId !== wsId) return;
    pty.dispose(oldId);
    await api.deleteTerminal(wsId, oldId).catch(function () {});
    state.activeId = res.terminal.id;
    saveActiveId();
    await refreshListOnce();
    selectTerminal(res.terminal.id);
  } catch (e) {
    handleError(e);
  }
}

export function selectTerminal(id) {
  if (!id) return;
  const terminal = state.terminals.find(function (t) { return t.id === id; });
  state.activeId = id;
  state.activeJobId = "";
  state.jobOutput = null;
  saveActiveId();
  if (terminal) pty.activate(terminal);
  notify();
}

export async function selectJob(id) {
  if (!state.wsId || !id) return;
  const wsId = state.wsId;
  pty.setActive("");
  state.activeJobId = id;
  state.jobOutput = null;
  notify();
  try {
    const out = await api.shellJobOutput(wsId, id, JOB_TAIL_BYTES);
    if (state.wsId !== wsId || state.activeJobId !== id) return;
    state.jobOutput = out;
  } catch (e) {
    handleError(e);
  }
  notify();
}

export async function killJob(id) {
  if (!state.wsId || !id) return;
  const wsId = state.wsId;
  try {
    await api.killShellJob(wsId, id);
  } catch (e) {
    handleError(e);
  }
  if (state.wsId !== wsId) return;
  if (state.activeJobId === id) {
    state.activeJobId = "";
    state.jobOutput = null;
  }
  try {
    await refreshListOnce();
  } catch (e) {
    handleError(e);
  }
  notify();
}

export async function changePath(path) {
  if (!path || path === state.activePath) return;
  pty.disposeAll();
  state.activePath = path;
  state.wsId = "";
  state.terminals = [];
  state.closingIds = new Set();
  state.jobs = [];
  state.activeId = "";
  state.activeJobId = "";
  state.jobOutput = null;
  notify();
  await connect();
}

function saveActiveId() {
  try {
    if (state.activeId) {
      localStorage.setItem(ACTIVE_ID_PREFIX + state.activePath, state.activeId);
    } else {
      localStorage.removeItem(ACTIVE_ID_PREFIX + state.activePath);
    }
  } catch (_) {}
}

function resetActive() {
  if (state.activeId) {
    pty.release(state.activeId);
    pty.dispose(state.activeId);
  }
  pty.setActive("");
  state.activeId = "";
  state.activeJobId = "";
  state.jobOutput = null;
  saveActiveId();
}

function stopTimers() {
  clearTimeout(state.listTimer);
  state.listTimer = null;
}

function setPageError(text) {
  state.pageError = text;
  stopTimers();
  notify();
}

function setBanner(kind, text) {
  state.bannerKind = kind;
  state.banner = text;
  notify();
}

function handleError(e) {
  const code = api.httpStatus(e);
  const message = api.errorMessage(e) || _t("请求失败");
  if (code === 403 && message.indexOf("[terminal:disabled]") >= 0) {
    setPageError(_t("服务端已关闭终端功能（options.terminal_enabled=false）"));
    return;
  }
  if (message.indexOf("[terminal:targets_invalid]") >= 0) {
    setBanner("error", _t("服务端目标机配置有误，请检查 terminal-targets.json"));
    return;
  }
  if (message.indexOf("[terminal:target_not_found]") >= 0) {
    setBanner("warn", _t("目标机不存在，请刷新后重试"));
    return;
  }
  if (message.indexOf("[terminal:target_disabled]") >= 0) {
    setBanner("warn", _t("目标机已被禁用"));
    return;
  }
  if (message.indexOf("[terminal:readonly]") >= 0) {
    setBanner("warn", _t("当前为只读，点击「接管控制」后输入"));
    return;
  }
  if (message.indexOf("[terminal:input_overflow]") >= 0) {
    setBanner("warn", _t("输入积压，正在重试"));
    return;
  }
  if (message.indexOf("[terminal:ssh_auth]") >= 0) {
    setBanner("error", _t("SSH 认证失败，请检查服务端目标机密钥/密码配置"));
    return;
  }
  if (message.indexOf("[terminal:ssh_hostkey]") >= 0) {
    setBanner("error", message);
    return;
  }
  if (message.indexOf("[terminal:ssh_dial]") >= 0) {
    setBanner("error", _t("无法连接目标机（超时或网络不可达）"));
    return;
  }
  if (code === 404) {
    if (message.indexOf("workspace not found") >= 0) {
      // Server restarted (or the workspace was reaped): the stored wsId is
      // dead, so rebuild it instead of resetting a terminal that no longer
      // exists. Without this the list poll would 404 forever.
      reconnectWorkspace();
      return;
    }
    resetActive();
    state.bannerKind = "warn";
    state.banner = _t("会话已失效（服务端可能已重启）");
    notify();
    return;
  }
  if (code === 409 && message.indexOf("[terminal:limit]") >= 0) {
    setBanner("warn", _t("已达终端会话上限，请先关闭不用的会话"));
    return;
  }
  if (code === 503) {
    setBanner("warn", _t("服务端正在退出，稍后重试"));
    return;
  }
  if (code === 403) {
    setBanner("warn", message);
    return;
  }
  setBanner("error", message);
}
