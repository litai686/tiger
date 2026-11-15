// 源码管理视图：单一状态源、工作区选择、变更操作与提交图表
// 数据全部来自服务端（桌面端可能连远程服务端）：Git 状态/差异走 /git/*，
// 写操作只走受控命令 /git/exec（白名单 id + 结构化参数），不做任意命令拼接。
import { t as _t } from "../../i18n.js";
import * as api from "./api.js";
import { parseNameStatusZ, parseCommitDetail } from "./diff.js";
import { basename } from "../projects/git.js";
import { normalizePath, wsIdByPath } from "../shared/paths.js";

const ACTIVE_KEY = "scm.activePath";
/** 首次进入源码管理时复用项目管理上次选中的目录，两个视图默认操作同一个仓库。 */
const FALLBACK_ACTIVE_KEY = "projects.activePath";
const DRAFT_PREFIX = "scm.draft.";
const GRAPH_AUTO_KEY = "scm.graphAuto";
const SECTIONS_KEY = "scm.sectionsCollapsed";
const DIFF_VIEW_KEY = "scm.diffView";
/** 已发现的子目录 Git 仓库（主目录不是仓库时，服务端在 nested_repos 返回）。 */
const NESTED_KEY = "scm.nestedRepos";
const GRAPH_LIMIT = 40;
const GRAPH_MIN_INTERVAL_MS = 30000;

/**
 * @typedef {{name:string,path:string,source:"workdir"|"workspace"|"nested",isDefault:boolean,wsId:string|null,loadState:string,error:string}} Project
 * @typedef {{path:string,name:string,parentPath:string}} NestedRepo
 * @typedef {{path:string,orig_path:string,index:string,worktree:string,untracked:boolean,ignored:boolean}} StatusEntry
 */

export const state = {
  /** @type {HTMLElement|null} */
  root: null,
  caps: { files: false, git: false, gitExec: false },
  /** @type {Project[]} */
  projects: [],
  /** 本次/上次会话发现的子目录仓库，持久化在 localStorage，重启后仍可从下拉选择。
   * @type {NestedRepo[]} */
  nestedRepos: [],
  projectsLoading: false,
  projectsError: "",
  projectsMenuOpen: false,
  activePath: "",
  wsId: "",
  clientId: "",
  /** @type {any} */
  git: null,
  statusLoading: false,
  statusError: "",
  statusStatus: 0,
  lastStatusAt: 0,
  selection: { path: "", staged: false },
  /** @type {any} */
  diff: { path: "", staged: false, loading: false, error: "", data: null },
  /** @type {any} */
  file: { path: "", loading: false, error: "", data: null },
  message: "",
  action: { running: false, label: "", startedAt: 0, error: "", result: null },
  graph: { open: true, auto: true, loading: false, error: "", lines: [], fetchedAt: 0 },
  /** 折叠状态：true = 已收起 */
  sections: { changes: false, staged: false, graph: false },
  /** 差异布局：split（并排，VSCode 默认）/ unified（统一） */
  diffView: "split",
  /** 图表中已展开的提交哈希 */
  expandedCommits: new Set(),
  /** 展开提交的文件列表缓存：hash -> {loading, error, files} */
  commitCache: new Map(),
  /** 悬停详情缓存：hash -> {loading, error, data}（不参与整页渲染） */
  commitDetail: new Map(),
  commitMenuOpen: false,
  pageError: "",
  /** @type {null|{text:string,error:boolean,until:number}} */
  toast: null,
  seq: 0,
  destroyed: false,
  /** @type {any[]} */
  timers: [],
  /** @type {null|(() => void)} */
  unlisten: null,
};

let renderFn = () => {};

/** ui.js 注册渲染入口；store 只负责在数据变化后调用它。 */
export function onRender(fn) {
  renderFn = fn;
}

export function notify() {
  if (!state.destroyed) renderFn();
}

function readBool(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "1" || raw === "true";
  } catch (_) {
    return fallback;
  }
}

function readSections() {
  const defaults = { changes: false, staged: false, graph: false };
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    if (obj && typeof obj === "object") {
      for (const key of Object.keys(defaults)) {
        if (typeof obj[key] === "boolean") defaults[key] = obj[key];
      }
    }
  } catch (_) {}
  return defaults;
}

function readDiffView() {
  try {
    return localStorage.getItem(DIFF_VIEW_KEY) === "unified" ? "unified" : "split";
  } catch (_) {
    return "split";
  }
}

function readNestedRepos() {
  try {
    const raw = localStorage.getItem(NESTED_KEY);
    const list = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(list)) return [];
    /** @type {NestedRepo[]} */
    const out = [];
    for (const item of list) {
      const path = item && typeof item.path === "string" ? item.path : "";
      if (!path) continue;
      out.push({
        path,
        name: String(item.name || basename(path.replace(/\\/g, "/"))),
        parentPath: typeof item.parentPath === "string" ? item.parentPath : "",
      });
    }
    return out;
  } catch (_) {
    return [];
  }
}

function persistNestedRepos() {
  try {
    localStorage.setItem(NESTED_KEY, JSON.stringify(state.nestedRepos));
  } catch (_) {}
}

/** 拼接服务端绝对路径（Windows 用反斜杠，其余用斜杠；嵌套仓库路径由 workspace 路径 + 相对根拼出）。 */
function joinRepoPath(parent, rel) {
  const sep = String(parent).indexOf("\\") >= 0 || /^[A-Za-z]:/.test(String(parent)) ? "\\" : "/";
  const cleanParent = String(parent).replace(/[\\/]+$/, "");
  const cleanRel = String(rel || "").replace(/^[\\/]+/, "").replace(/[\\/]+/g, sep);
  return cleanParent + sep + cleanRel;
}


export function init(root) {
  state.root = root;
  state.destroyed = false;
  state.pageError = "";
  state.caps = { files: false, git: false, gitExec: false };
  state.projects = [];
  state.projectsLoading = false;
  state.projectsError = "";
  state.projectsMenuOpen = false;
  state.statusLoading = false;
  state.statusError = "";
  state.statusStatus = 0;
  state.git = null;
  state.selection = { path: "", staged: false, rev: "" };
  state.diff = { path: "", staged: false, rev: "", loading: false, error: "", data: null };
  state.file = { path: "", loading: false, error: "", data: null };
  state.action = { running: false, label: "", startedAt: 0, error: "", result: null };
  state.commitMenuOpen = false;
  state.toast = null;
  state.expandedCommits = new Set();
  state.commitCache = new Map();
  state.commitDetail = new Map();
  state.sections = readSections();
  state.diffView = readDiffView();
  state.nestedRepos = readNestedRepos();
  state.graph = { open: !state.sections.graph, auto: readBool(GRAPH_AUTO_KEY, true), loading: false, error: "", lines: [], fetchedAt: 0 };
  state.clientId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
}

export function reset() {
  state.seq++;
  state.destroyed = true;
  state.root = null;
  state.projects = [];
  state.nestedRepos = [];
  state.activePath = "";
  state.wsId = "";
  state.git = null;
  state.pageError = "";
  state.statusLoading = false;
  state.statusError = "";
  state.statusStatus = 0;
  state.lastStatusAt = 0;
  state.selection = { path: "", staged: false, rev: "" };
  state.diff = { path: "", staged: false, rev: "", loading: false, error: "", data: null };
  state.file = { path: "", loading: false, error: "", data: null };
  state.message = "";
  state.action = { running: false, label: "", startedAt: 0, error: "", result: null };
  state.expandedCommits = new Set();
  state.commitCache = new Map();
  state.commitDetail = new Map();
  state.graph = { open: true, auto: state.graph.auto, loading: false, error: "", lines: [], fetchedAt: 0 };
  state.commitMenuOpen = false;
  state.toast = null;
  for (const timer of state.timers) clearTimeout(timer);
  state.timers = [];
  if (state.unlisten) {
    try {
      state.unlisten();
    } catch (_) {}
    state.unlisten = null;
  }
}

// ===== 工作区列表 =====

/**
 * 把服务端 nested_repos（相对 workspace 的仓库根）登记为可选仓库：
 * 下拉里出现「子目录 Git 仓库」分组，并持久化，重启后仍可直接进入。
 * @param {string} parentPath
 * @param {string[]} rels
 */
function registerNestedRepos(parentPath, rels) {
  if (!parentPath) return false;
  let changed = false;
  for (const raw of rels || []) {
    const rel = String(raw || "").trim();
    if (!rel) continue;
    const path = joinRepoPath(parentPath, rel);
    const key = normalizePath(path);
    const name = basename(rel.replace(/\\/g, "/"));
    if (!state.nestedRepos.some(function (n) { return normalizePath(n.path) === key; })) {
      state.nestedRepos.push({ path, name, parentPath });
      changed = true;
    }
    if (!state.projects.some(function (p) { return normalizePath(p.path) === key; })) {
      state.projects.push({
        path,
        name,
        source: "nested",
        isDefault: false,
        wsId: null,
        loadState: "idle",
        error: "",
      });
      changed = true;
    }
  }
  if (changed) persistNestedRepos();
  return changed;
}

/** @returns {Project|null} */
function ensureNestedProject(parentPath, rel) {
  const value = String(rel || "").trim();
  if (!value) return null;
  registerNestedRepos(parentPath, [value]);
  const key = normalizePath(joinRepoPath(parentPath, value));
  return state.projects.find(function (p) { return normalizePath(p.path) === key; }) || null;
}

export async function loadProjects() {
  state.projectsLoading = true;
  state.projectsError = "";
  notify();
  try {
    const [dirs, workspaces] = await Promise.all([
      api.invokeCmd("get_workdirs").catch(function () {
        return [];
      }),
      api.get("/v1/workspaces").catch(function () {
        return [];
      }),
    ]);
    if (state.destroyed) return;
    const seen = new Set();
    /** @type {Project[]} */
    const list = [];
    for (const d of dirs || []) {
      const path = String(d.path || "");
      if (!path) continue;
      const key = normalizePath(path);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        path,
        name: basename(path.replace(/\\/g, "/")),
        source: "workdir",
        isDefault: !!d.is_default,
        wsId: wsIdByPath(workspaces, path),
        loadState: "idle",
        error: "",
      });
    }
    for (const w of workspaces || []) {
      const path = String(w.path || "");
      if (!path) continue;
      const key = normalizePath(path);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        path,
        name: basename(path.replace(/\\/g, "/")),
        source: "workspace",
        isDefault: false,
        wsId: w.id || null,
        loadState: "idle",
        error: "",
      });
    }
    // 上次会话发现的子目录仓库：重启后仍可从下拉直接进入（路径可能已被删除，选中时会报错）。
    for (const nested of state.nestedRepos) {
      const key = normalizePath(nested.path);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        path: nested.path,
        name: nested.name || basename(nested.path.replace(/\\/g, "/")),
        source: "nested",
        isDefault: false,
        wsId: null,
        loadState: "idle",
        error: "",
      });
    }
    list.sort(function (a, b) {
      return a.isDefault === b.isDefault ? 0 : a.isDefault ? -1 : 1;
    });
    state.projects = list;
  } catch (e) {
    state.projectsError = api.errorMessage(e);
  } finally {
    state.projectsLoading = false;
    notify();
  }
}

export async function selectInitialProject() {
  let remembered = "";
  try {
    remembered = localStorage.getItem(ACTIVE_KEY) || localStorage.getItem(FALLBACK_ACTIVE_KEY) || "";
  } catch (_) {}
  let target = state.projects.find(function (p) {
    return p.path === remembered;
  });
  if (!target && remembered) {
    const key = normalizePath(remembered);
    target = state.projects.find(function (p) {
      return normalizePath(p.path) === key;
    });
  }
  if (!target) {
    target = state.projects.find(function (p) {
      return p.isDefault;
    });
  }
  if (!target) target = state.projects[0];
  if (target) await selectProject(target);
}

/**
 * @param {Project} project
 * @param {{autoNested?:boolean}} [opts] autoNested=false 表示用户手动选了容器目录，不要自动跳子目录仓库
 */
export async function selectProject(project, opts) {
  if (!project) return;
  if (state.activePath === project.path && state.wsId) {
    notify();
    return;
  }
  saveDraft();
  state.seq++;
  const seq = state.seq;
  state.activePath = project.path;
  state.wsId = "";
  state.git = null;
  state.lastStatusAt = 0;
  state.statusError = "";
  state.statusStatus = 0;
  state.statusLoading = false;
  state.selection = { path: "", staged: false, rev: "" };
  state.diff = { path: "", staged: false, rev: "", loading: false, error: "", data: null };
  state.file = { path: "", loading: false, error: "", data: null };
  state.action = { running: false, label: "", startedAt: 0, error: "", result: null };
  state.expandedCommits = new Set();
  state.commitCache = new Map();
  state.commitDetail = new Map();
  state.graph = { open: state.graph.open, auto: state.graph.auto, loading: false, error: "", lines: [], fetchedAt: 0 };
  state.commitMenuOpen = false;
  state.toast = null;
  state.projectsMenuOpen = false;
  state.message = loadDraftText(project.path);
  project.loadState = "loading";
  project.error = "";
  notify();
  try {
    const info = await api.invokeCmd("create_workspace", { path: project.path, clientId: state.clientId });
    if (seq !== state.seq || state.destroyed) return;
    if (!info || !info.workspace_id) throw new Error("server returned no workspace id");
    state.wsId = info.workspace_id;
    project.wsId = info.workspace_id;
    project.loadState = "idle";
    try {
      localStorage.setItem(ACTIVE_KEY, project.path);
    } catch (_) {}
    notify();
    await loadStatus();
    if (state.destroyed || seq !== state.seq) return;
    // 主目录不是仓库、子目录里有仓库（例如 tt/pi）：自动切到第一个子目录仓库，
    // 这样暂存/提交/图表等仓库级能力可用；手动选择容器时（autoNested=false）保持聚合只读视图。
    const allowAutoNested = !(opts && opts.autoNested === false);
    if (allowAutoNested && state.git && !state.git.isRepo && (state.git.nestedRepos || []).length) {
      const nestedProject = ensureNestedProject(state.activePath, state.git.nestedRepos[0]);
      if (nestedProject && normalizePath(nestedProject.path) !== normalizePath(state.activePath)) {
        await selectProject(nestedProject, { autoNested: false });
        return;
      }
    }
    if (state.graph.open && isRepoReady()) await loadGraph(true);
  } catch (e) {
    if (seq !== state.seq || state.destroyed) return;
    project.loadState = "error";
    project.error = api.errorMessage(e);
    notify();
  }
}

// ===== 仓库状态 =====

export function isRepoReady() {
  return !!(state.git && state.git.exists && state.git.isRepo && state.git.gitInstalled);
}

/** 目录不是仓库、但子目录里有仓库时，只读展示聚合状态，不允许仓库级写操作。 */
export function hasNestedRepos() {
  return !!(state.git && !state.git.isRepo && (state.git.nestedRepos || []).length);
}

export async function loadStatus() {
  if (!state.wsId || !state.caps.git) return;
  if (state.statusLoading) return;
  const seq = state.seq;
  state.statusLoading = true;
  notify();
  try {
    const res = await api.get("/v1/workspaces/" + state.wsId + "/git/status");
    if (seq !== state.seq || state.destroyed) return;
    applyStatus(res);
    state.statusError = "";
    state.statusStatus = 0;
  } catch (e) {
    if (seq !== state.seq || state.destroyed) return;
    state.statusError = api.errorMessage(e);
    state.statusStatus = api.httpStatus(e);
  } finally {
    if (seq === state.seq && !state.destroyed) {
      state.statusLoading = false;
      state.lastStatusAt = Date.now();
      notify();
    }
  }
  if (state.destroyed || seq !== state.seq) return;
  if (state.graph.open && state.graph.auto && isRepoReady()) void loadGraph(false);
}

/** @param {any} res */
function applyStatus(res) {
  /** @type {Map<string, StatusEntry>} */
  const entries = new Map();
  for (const e of res.entries || []) {
    entries.set(e.path, {
      path: e.path,
      orig_path: e.orig_path || "",
      index: e.index,
      worktree: e.worktree,
      untracked: !!e.untracked,
      ignored: !!e.ignored,
    });
  }
  state.git = {
    exists: !!res.exists,
    isRepo: !!res.is_repo,
    gitInstalled: !!res.git_installed,
    branch: res.branch || "",
    detached: !!res.detached,
    head: res.head || "",
    ahead: res.ahead || 0,
    behind: res.behind || 0,
    entries,
    lowerIndex: null,
    truncated: !!res.truncated,
    nestedRepos: res.nested_repos || [],
    fetchedAt: Date.now(),
  };
  state.lastStatusAt = Date.now();
  // 主目录不是仓库时，服务端把子目录仓库的变更聚合进 entries，并在 nested_repos 返回仓库根。
  // 登记后可由 selectProject 自动切换到子目录仓库；否则这里只展示聚合后的只读状态。
  if (!state.git.isRepo && (state.git.nestedRepos || []).length) {
    registerNestedRepos(state.activePath, state.git.nestedRepos);
  }
  // 选中的文件已没有变更（被暂存/提交/还原/清理）时清空右侧，避免展示过期差异。
  // 提交历史视图（rev 非空）的文件可能不在工作区状态里，不能因此清空。
  if (state.selection.path && !state.selection.rev && !entryOf(state.selection.path)) {
    state.selection = { path: "", staged: false, rev: "" };
    state.diff = { path: "", staged: false, rev: "", loading: false, error: "", data: null };
    state.file = { path: "", loading: false, error: "", data: null };
  }
}

/** Windows 大小写兜底：只建一次小写索引。 */
export function entryOf(path) {
  if (!state.git) return null;
  if (state.git.entries.has(path)) return state.git.entries.get(path);
  if (!state.git.lowerIndex) {
    const map = new Map();
    for (const [p, e] of state.git.entries) map.set(p.toLowerCase(), e);
    state.git.lowerIndex = map;
  }
  return state.git.lowerIndex.get(String(path).toLowerCase()) || null;
}

/** @param {StatusEntry} entry */
export function hasWorktreeSide(entry) {
  if (!entry) return false;
  if (entry.ignored || entry.index === "!" || entry.worktree === "!") return false;
  return entry.worktree !== " " || entry.untracked;
}

/** @param {StatusEntry} entry */
export function hasStagedSide(entry) {
  if (!entry) return false;
  if (entry.ignored || entry.index === "!" || entry.worktree === "!") return false;
  return entry.index !== " " && entry.index !== "?";
}

function byPath(a, b) {
  return a.path.localeCompare(b.path);
}

/** 工作区（未暂存）变更，含未跟踪文件。 */
export function unstagedEntries() {
  if (!state.git) return [];
  return Array.from(state.git.entries.values()).filter(hasWorktreeSide).sort(byPath);
}

/** 已暂存变更（索引 vs HEAD）。 */
export function stagedEntries() {
  if (!state.git) return [];
  return Array.from(state.git.entries.values()).filter(hasStagedSide).sort(byPath);
}

export function changeCounts() {
  return {
    unstaged: unstagedEntries().length,
    staged: stagedEntries().length,
    total: state.git ? state.git.entries.size : 0,
  };
}

// ===== 受控 Git 命令执行 =====

/**
 * @param {string} wsId
 * @param {string} id
 * @param {Record<string,string>} params
 * @param {string} ack
 */
function execGit(wsId, id, params, ack) {
  return api.api("POST", "/v1/workspaces/" + wsId + "/git/exec", {
    id,
    params: params || {},
    ack: ack || "",
  });
}

/** @param {any} res */
function failureText(res) {
  if (!res) return _t("执行失败");
  const err = String(res.stderr || "").trim();
  const out = String(res.stdout || "").trim();
  return err || out || _t("执行失败");
}

/**
 * 写类操作的统一外壳：互斥、错误展示、成功后刷新状态与当前差异。
 * @param {string} label
 * @param {(wsId:string) => Promise<any>} fn
 */
async function runMutation(label, fn) {
  if (!state.wsId || state.action.running || !state.caps.gitExec || !isRepoReady()) return false;
  const seq = state.seq;
  const wsId = state.wsId;
  state.action = { running: true, label, startedAt: Date.now(), error: "", result: null };
  state.commitMenuOpen = false;
  notify();
  let failure = "";
  let result = null;
  try {
    result = await fn(wsId);
    if (result && result.exit_code !== 0) failure = failureText(result);
  } catch (e) {
    failure = api.errorMessage(e);
  }
  if (state.destroyed || seq !== state.seq) return false;
  state.action.running = false;
  state.action.result = result;
  state.action.error = failure;
  if (failure) showToast(failure, true);
  notify();
  await loadStatus();
  await reloadSelection();
  if (state.graph.open && state.graph.auto) void loadGraph(true);
  return !failure;
}

export function stageFile(path) {
  return runMutation(_t("暂存"), function (wsId) {
    return execGit(wsId, "add_file", { path }, "");
  });
}

export function unstageFile(path) {
  return runMutation(_t("取消暂存"), function (wsId) {
    return execGit(wsId, "unstage_file", { path }, "");
  });
}

export function stageAll() {
  return runMutation(_t("暂存全部"), function (wsId) {
    return execGit(wsId, "add_all", {}, "");
  });
}

export function unstageAll() {
  return runMutation(_t("取消暂存全部"), function (wsId) {
    return execGit(wsId, "unstage_all", {}, "");
  });
}

/** 只对已跟踪文件有效（restore 不会删除未跟踪文件）。 */
export function discardFile(path) {
  return runMutation(_t("丢弃更改"), function (wsId) {
    return execGit(wsId, "restore_file", { path }, "strong");
  });
}

/** @param {string[]} paths */
export function discardAll(paths) {
  return runMutation(_t("丢弃全部更改"), async function (wsId) {
    let last = null;
    for (const path of paths) {
      last = await execGit(wsId, "restore_file", { path }, "strong");
      if (!last || last.exit_code !== 0) return last;
    }
    return last || { exit_code: 0, stdout: "", stderr: "", display: "" };
  });
}

/**
 * 提交。stageAll=true 时先暂存全部（服务端 add_all）再提交。
 * 提交按钮本身就是用户显式确认，ack 直接取命令要求的 normal（服务端 §12.6）。
 * @param {string} message
 * @param {{stageAll?:boolean}} [opts]
 */
export async function commit(message, opts) {
  if (!state.wsId || state.action.running || !state.caps.gitExec || !isRepoReady()) return;
  const text = String(message || "").trim();
  if (!text) {
    setActionError(_t("提交信息不能为空"));
    return;
  }
  if (text.length > 2000) {
    setActionError(_t("提交信息过长（最多 2000 字符）"));
    return;
  }
  const stageAllFirst = !!(opts && opts.stageAll);
  await runMutation(stageAllFirst ? _t("暂存并提交") : _t("提交"), async function (wsId) {
    if (stageAllFirst) {
      const add = await execGit(wsId, "add_all", {}, "");
      if (!add || add.exit_code !== 0) return add;
    }
    return execGit(wsId, "commit", { message: text }, "normal");
  }).then(function (ok) {
    if (!ok) return;
    state.message = "";
    clearDraftText(state.activePath);
    showToast(_t("提交成功"));
    notify();
  });
}

export function setActionError(text) {
  state.action.error = String(text || "");
  state.action.result = null;
  notify();
}

export function clearActionOutput() {
  state.action.error = "";
  state.action.result = null;
  notify();
}

// ===== 提交图表（git log --oneline --graph --decorate） =====

/**
 * @param {boolean} force
 */
export async function loadGraph(force) {
  if (!state.wsId || !state.caps.gitExec || !isRepoReady()) return;
  if (state.graph.loading) return;
  if (!force && state.graph.lines.length && Date.now() - state.graph.fetchedAt < GRAPH_MIN_INTERVAL_MS) return;
  const seq = state.seq;
  const wsId = state.wsId;
  state.graph.loading = true;
  notify();
  try {
    const res = await execGit(wsId, "log", { limit: String(GRAPH_LIMIT) }, "");
    if (seq !== state.seq || state.destroyed) return;
    const failed = !res || res.exit_code !== 0;
    state.graph.lines = failed ? [] : String((res && res.stdout) || "").split("\n").filter(function (line) {
      return line.trim().length > 0;
    });
    state.graph.error = failed ? failureText(res) : "";
    state.graph.fetchedAt = Date.now();
  } catch (e) {
    if (seq === state.seq && !state.destroyed) state.graph.error = api.errorMessage(e);
  } finally {
    if (seq === state.seq && !state.destroyed) {
      state.graph.loading = false;
      notify();
    }
  }
}

// ===== 提交历史：展开行 + 单文件差异 =====

/**
 * 展开 / 收起图表里的提交。展开时懒加载该提交改动的文件列表。
 * @param {string} hash 图表行里的缩写 hash（git 保证仓库内唯一）
 */
export async function toggleCommit(hash) {
  const rev = String(hash || "").trim();
  if (!rev) return;
  if (state.expandedCommits.has(rev)) {
    state.expandedCommits.delete(rev);
    notify();
    return;
  }
  state.expandedCommits.add(rev);
  const cached = state.commitCache.get(rev);
  notify();
  if (!cached || (!cached.loading && cached.error)) await loadCommitFiles(rev);
}

/** @param {string} rev */
export async function loadCommitFiles(rev) {
  if (!state.wsId || !state.caps.gitExec || !rev) return;
  const cached = state.commitCache.get(rev);
  if (cached && cached.loading) return;
  const seq = state.seq;
  const wsId = state.wsId;
  state.commitCache.set(rev, { loading: true, error: "", files: (cached && cached.files) || [] });
  notify();
  try {
    const res = await execGit(wsId, "show_commit", { rev }, "");
    if (seq !== state.seq || state.destroyed) return;
    if (!res || res.exit_code !== 0) {
      state.commitCache.set(rev, { loading: false, error: failureText(res), files: [] });
    } else {
      state.commitCache.set(rev, { loading: false, error: "", files: parseNameStatusZ(res.stdout) });
    }
  } catch (e) {
    if (seq === state.seq && !state.destroyed) {
      state.commitCache.set(rev, { loading: false, error: api.errorMessage(e), files: [] });
    }
  }
  if (seq === state.seq && !state.destroyed) notify();
}

/** @returns {{status:string,path:string,origPath:string}|null} */
export function commitFileOf(rev, path) {
  const cached = state.commitCache.get(rev);
  const files = (cached && cached.files) || [];
  const target = String(path || "");
  for (const file of files) {
    if (file.path === target) return file;
  }
  return null;
}

/** 悬停卡片缓存（不触发整页渲染）。 */
export function commitDetailOf(rev) {
  return state.commitDetail.get(rev) || null;
}

/**
 * 拉取提交作者/时间/完整信息与 numstat 统计，供图表悬停卡片使用。
 * 失败条目允许下次悬停重试。
 * @param {string} rev
 */
export async function loadCommitDetail(rev) {
  if (!state.wsId || !state.caps.gitExec || !rev) return null;
  const cached = state.commitDetail.get(rev);
  if (cached && (cached.loading || cached.data)) return cached;
  const seq = state.seq;
  const wsId = state.wsId;
  state.commitDetail.set(rev, { loading: true, error: "", data: null });
  try {
    const res = await execGit(wsId, "commit_detail", { rev }, "");
    if (seq !== state.seq || state.destroyed) return null;
    const entry = !res || res.exit_code !== 0
      ? { loading: false, error: failureText(res), data: null }
      : { loading: false, error: "", data: parseCommitDetail(res.stdout) };
    state.commitDetail.set(rev, entry);
    return entry;
  } catch (e) {
    if (seq !== state.seq || state.destroyed) return null;
    const entry = { loading: false, error: api.errorMessage(e), data: null };
    state.commitDetail.set(rev, entry);
    return entry;
  }
}

/** 点击提交里的文件：右侧展示该提交中此文件的 unified diff。 */
export async function selectCommitFile(rev, path) {
  if (!rev || !path) return;
  state.selection = { path, staged: false, rev };
  state.commitMenuOpen = false;
  state.diff = { path, staged: false, rev, loading: true, error: "", data: null };
  state.file = { path: "", loading: false, error: "", data: null };
  notify();
  await loadCommitDiff();
}

async function loadCommitDiff() {
  const rev = state.selection.rev;
  const path = state.selection.path;
  if (!state.wsId || !rev || !path) return;
  const seq = state.seq;
  const wsId = state.wsId;
  const keep = state.diff.rev === rev && state.diff.path === path ? state.diff.data : null;
  state.diff = { path, staged: false, rev, loading: true, error: "", data: keep };
  notify();
  try {
    const res = await execGit(wsId, "commit_file_diff", { rev, path }, "");
    if (seq !== state.seq || state.destroyed || state.selection.rev !== rev || state.selection.path !== path) return;
    if (!res || res.exit_code !== 0) {
      state.diff = { path, staged: false, rev, loading: false, error: failureText(res), data: null };
    } else {
      const text = String(res.stdout || "");
      const binary = /^Binary files .* differ$/m.test(text) || text.indexOf("GIT binary patch") >= 0;
      state.diff = {
        path,
        staged: false,
        rev,
        loading: false,
        error: "",
        data: { diff: text, binary, truncated: !!res.truncated, untracked: false, staged: false },
      };
    }
  } catch (e) {
    if (seq !== state.seq || state.destroyed || state.selection.rev !== rev || state.selection.path !== path) return;
    state.diff = { path, staged: false, rev, loading: false, error: api.errorMessage(e), data: null };
  }
  notify();
}

/** 返回工作区变更视图（清空提交历史选择）。 */
export function clearCommitSelection() {
  state.selection = { path: "", staged: false, rev: "" };
  state.diff = { path: "", staged: false, rev: "", loading: false, error: "", data: null };
  state.file = { path: "", loading: false, error: "", data: null };
  notify();
}

export function setGraphAuto(enabled) {
  state.graph.auto = !!enabled;
  try {
    localStorage.setItem(GRAPH_AUTO_KEY, state.graph.auto ? "1" : "0");
  } catch (_) {}
  if (state.graph.auto && state.graph.open && isRepoReady() && !state.graph.lines.length) void loadGraph(true);
  notify();
}

export function setDiffView(view) {
  const next = view === "unified" ? "unified" : "split";
  if (state.diffView === next) return;
  state.diffView = next;
  try {
    localStorage.setItem(DIFF_VIEW_KEY, next);
  } catch (_) {}
  notify();
}

export function setSectionCollapsed(section, collapsed) {
  if (!(section in state.sections)) return;
  state.sections[section] = !!collapsed;
  if (section === "graph") state.graph.open = !collapsed;
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(state.sections));
  } catch (_) {}
  if (section === "graph" && !collapsed && !state.graph.lines.length && !state.graph.loading && isRepoReady()) {
    void loadGraph(true);
  }
  notify();
}

export function setCommitMenu(open) {
  state.commitMenuOpen = typeof open === "boolean" ? open : !state.commitMenuOpen;
  notify();
}

export function setProjectsMenu(open) {
  state.projectsMenuOpen = !!open;
  notify();
}

// ===== 差异 / 未跟踪文件内容 =====

export async function selectEntry(path, staged) {
  if (!path) return;
  state.selection = { path, staged: !!staged, rev: "" };
  state.commitMenuOpen = false;
  state.diff = { path, staged: !!staged, rev: "", loading: true, error: "", data: null };
  state.file = { path: "", loading: false, error: "", data: null };
  notify();
  const entry = entryOf(path);
  const tasks = [loadDiff()];
  if (entry && entry.untracked && !staged) tasks.push(loadFileContent());
  await Promise.all(tasks);
}

export function setSelectionMode(staged) {
  if (state.selection.rev) return;
  const mode = !!staged;
  if (state.selection.staged === mode) return;
  const entry = entryOf(state.selection.path);
  if (!entry) return;
  if (mode && !hasStagedSide(entry)) return;
  if (!mode && !hasWorktreeSide(entry)) return;
  state.selection.staged = mode;
  notify();
  void loadDiff();
}

export async function loadDiff() {
  if (state.selection.rev) {
    await loadCommitDiff();
    return;
  }
  const path = state.selection.path;
  if (!state.wsId || !path || !state.caps.git) return;
  const staged = !!state.selection.staged;
  const seq = state.seq;
  const wsId = state.wsId;
  // 刷新时保留旧 diff：避免轮询/SSE 触发时右侧闪烁成「加载中...」并丢失滚动位置。
  const keep = state.diff.path === path && state.diff.staged === staged ? state.diff.data : null;
  state.diff = { path, staged, rev: "", loading: true, error: "", data: keep };
  notify();
  try {
    const data = await api.get("/v1/workspaces/" + wsId + "/git/diff" + api.qs({ path, staged: staged ? "1" : "" }));
    if (seq !== state.seq || state.destroyed || state.selection.path !== path || state.selection.staged !== staged) return;
    state.diff = { path, staged, rev: "", loading: false, error: "", data };
    if (data && data.untracked) await loadFileContent();
  } catch (e) {
    if (seq !== state.seq || state.destroyed || state.selection.path !== path || state.selection.staged !== staged) return;
    state.diff = { path, staged, rev: "", loading: false, error: api.errorMessage(e), data: null };
  }
  notify();
}

async function loadFileContent() {
  const path = state.selection.path;
  if (!state.wsId || !path) return;
  const seq = state.seq;
  const wsId = state.wsId;
  const keep = state.file.path === path ? state.file.data : null;
  state.file = { path, loading: true, error: "", data: keep };
  notify();
  try {
    const data = await api.get("/v1/workspaces/" + wsId + "/files/content" + api.qs({ path }));
    if (seq !== state.seq || state.destroyed || state.selection.path !== path) return;
    state.file = { path, loading: false, error: "", data };
  } catch (e) {
    if (seq !== state.seq || state.destroyed || state.selection.path !== path) return;
    state.file = { path, loading: false, error: api.errorMessage(e), data: null };
  }
  notify();
}

export async function reloadSelection() {
  const path = state.selection.path;
  if (!path) return;
  if (state.selection.rev) {
    await loadCommitDiff();
    return;
  }
  const entry = entryOf(path);
  if (!entry) {
    state.selection = { path: "", staged: false, rev: "" };
    state.diff = { path: "", staged: false, rev: "", loading: false, error: "", data: null };
    state.file = { path: "", loading: false, error: "", data: null };
    notify();
    return;
  }
  if (state.selection.staged && !hasStagedSide(entry)) {
    if (hasWorktreeSide(entry)) state.selection.staged = false;
  } else if (!state.selection.staged && !hasWorktreeSide(entry) && hasStagedSide(entry)) {
    // 暂存后工作区侧消失（如未跟踪文件被 add）：自动切到暂存差异，避免右侧空白。
    state.selection.staged = true;
  }
  const tasks = [loadDiff()];
  if (entry.untracked && !state.selection.staged) tasks.push(loadFileContent());
  await Promise.all(tasks);
}

/**
 * @param {{graph?:boolean}} [opts]
 */
export async function refreshAll(opts) {
  opts = opts || {};
  if (!state.wsId) return;
  await loadStatus();
  if (opts.graph) await loadGraph(true);
  await reloadSelection();
  notify();
}

// ===== 提交信息草稿（按工作目录持久化） =====

function draftKey(path) {
  return DRAFT_PREFIX + normalizePath(path);
}

/** @param {string} path */
function loadDraftText(path) {
  if (!path) return "";
  try {
    return localStorage.getItem(draftKey(path)) || "";
  } catch (_) {
    return "";
  }
}

export function saveDraft() {
  if (!state.activePath) return;
  try {
    if (state.message) localStorage.setItem(draftKey(state.activePath), state.message);
    else localStorage.removeItem(draftKey(state.activePath));
  } catch (_) {}
}

/** @param {string} path */
function clearDraftText(path) {
  if (!path) return;
  try {
    localStorage.removeItem(draftKey(path));
  } catch (_) {}
}

export function setMessage(text) {
  state.message = String(text || "");
}

// ===== 轻量提示 =====

/**
 * @param {string} text
 * @param {boolean} [isError]
 */
export function showToast(text, isError) {
  const until = Date.now() + 4000;
  state.toast = { text: String(text || ""), error: !!isError, until };
  const timer = setTimeout(function () {
    if (state.destroyed) return;
    if (!state.toast || Date.now() < state.toast.until) return;
    state.toast = null;
    notify();
  }, 4100);
  state.timers.push(timer);
  notify();
}
