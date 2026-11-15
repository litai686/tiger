// 项目管理视图：单一状态源、请求序号与选择器
import * as api from "./api.js";
import { basename, buildDirIndex } from "./git.js";
import { normalizePath, wsIdByPath } from "../shared/paths.js";

const ACTIVE_KEY = "projects.activePath";

/**
 * @typedef {{name:string,path:string,source:"workdir"|"workspace",isDefault:boolean,wsId:string|null,loadState:string,error:string}} Project
 * @typedef {{name:string,path:string,is_dir:boolean,size:number,mtime:number,symlink:boolean,external?:boolean,hidden:boolean,deleted?:boolean}} DirEntry
 */

export const state = {
  /** @type {HTMLElement|null} */
  root: null,
  caps: { files: false, git: false },
  /** @type {Project[]} */
  projects: [],
  projectsLoading: false,
  projectsError: "",
  projectsMenuOpen: false,
  activePath: "",
  wsId: "",
  clientId: "",
  /** @type {Map<string,{entries:DirEntry[],loading:boolean,error:string,truncated:boolean}>} */
  dirs: new Map(),
  /** @type {Set<string>} */
  expanded: new Set(),
  /** @type {any} */
  git: null,
  statusLoading: false,
  statusError: "",
  statusStatus: 0,
  lastStatusAt: 0,
  staleTree: false,
  selection: { path: "", mode: "preview", staged: false },
  file: { path: "", loading: false, error: "", data: null },
  diff: { path: "", staged: false, loading: false, error: "", data: null },
  pageError: "",
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

export function init(root) {
  state.root = root;
  state.destroyed = false;
  state.pageError = "";
  state.caps = { files: false, git: false };
  state.projects = [];
  state.projectsLoading = false;
  state.projectsError = "";
  state.projectsMenuOpen = false;
  state.statusLoading = false;
  state.statusError = "";
  state.statusStatus = 0;
  state.staleTree = false;
  state.clientId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
}

export function reset() {
  state.seq++;
  state.destroyed = true;
  state.root = null;
  state.projects = [];
  state.activePath = "";
  state.wsId = "";
  state.dirs.clear();
  state.expanded.clear();
  state.git = null;
  state.pageError = "";
  state.statusLoading = false;
  state.statusError = "";
  state.statusStatus = 0;
  state.staleTree = false;
  state.selection = { path: "", mode: "preview", staged: false };
  state.file = { path: "", loading: false, error: "", data: null };
  state.diff = { path: "", staged: false, loading: false, error: "", data: null };
  for (const timer of state.timers) clearTimeout(timer);
  state.timers = [];
  if (state.unlisten) {
    try {
      state.unlisten();
    } catch (_) {}
    state.unlisten = null;
  }
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
  const remembered = localStorage.getItem(ACTIVE_KEY) || "";
  let target = state.projects.find(function (p) {
    return p.path === remembered;
  });
  if (!target) {
    target = state.projects.find(function (p) {
      return p.isDefault;
    });
  }
  if (!target) target = state.projects[0];
  if (target) await selectProject(target);
}

/** @param {Project} project */
export async function selectProject(project) {
  if (!project) return;
  if (state.activePath === project.path && state.wsId) {
    notify();
    return;
  }
  state.seq++;
  const seq = state.seq;
  state.activePath = project.path;
  state.wsId = "";
  state.dirs.clear();
  state.expanded = new Set();
  state.git = null;
  state.lastStatusAt = 0;
  state.statusError = "";
  state.statusLoading = false;
  state.selection = { path: "", mode: "preview", staged: false };
  state.file = { path: "", loading: false, error: "", data: null };
  state.diff = { path: "", staged: false, loading: false, error: "", data: null };
  state.projectsMenuOpen = false;
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
    localStorage.setItem(ACTIVE_KEY, project.path);
    notify();
    const tasks = [loadDir("", true)];
    if (state.caps.git) tasks.push(loadStatus());
    await Promise.all(tasks);
  } catch (e) {
    if (seq !== state.seq || state.destroyed) return;
    project.loadState = "error";
    project.error = api.errorMessage(e);
    notify();
  }
}

export async function loadDir(relDir, force) {
  if (!state.wsId) return;
  const cur = state.dirs.get(relDir);
  if (!force && cur && !cur.error && (cur.loading || cur.entries)) return;
  const seq = state.seq;
  state.dirs.set(relDir, {
    entries: (cur && cur.entries) || [],
    loading: true,
    error: "",
    truncated: !!(cur && cur.truncated),
  });
  notify();
  try {
    const res = await api.get("/v1/workspaces/" + state.wsId + "/files" + api.qs({ path: relDir }));
    if (seq !== state.seq || state.destroyed) return;
    state.dirs.set(relDir, { entries: res.entries || [], loading: false, error: "", truncated: !!res.truncated });
  } catch (e) {
    if (seq !== state.seq || state.destroyed) return;
    state.dirs.set(relDir, { entries: [], loading: false, error: api.errorMessage(e), truncated: false });
  }
  notify();
}

export async function toggleDir(relDir) {
  if (state.expanded.has(relDir)) {
    state.expanded.delete(relDir);
    notify();
    return;
  }
  state.expanded.add(relDir);
  notify();
  const cur = state.dirs.get(relDir);
  if (!cur || cur.error) await loadDir(relDir, !!(cur && cur.error));
}

export async function loadStatus() {
  if (!state.wsId || !state.caps.git) return;
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
    if (seq === state.seq) {
      state.statusLoading = false;
      notify();
    }
  }
}

/** @param {any} res */
function applyStatus(res) {
  /** @type {Map<string, any>} */
  const entries = new Map();
  for (const e of res.entries || []) {
    entries.set(e.path, {
      path: e.path,
      orig_path: e.orig_path || "",
      index: e.index,
      worktree: e.worktree,
      untracked: !!e.untracked,
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
    dirIndex: buildDirIndex(entries),
    truncated: !!res.truncated,
    nestedRepos: res.nested_repos || [],
    fetchedAt: Date.now(),
  };
  state.lastStatusAt = Date.now();
}

/** Windows 大小写兜底：只建一次小写索引。 */
export function statusOf(relPath) {
  if (!state.git || (!state.git.isRepo && !(state.git.nestedRepos || []).length)) return null;
  if (state.git.entries.has(relPath)) return state.git.entries.get(relPath);
  if (!state.git.lowerIndex) {
    const map = new Map();
    for (const [p, e] of state.git.entries) map.set(p.toLowerCase(), e);
    state.git.lowerIndex = map;
  }
  return state.git.lowerIndex.get(String(relPath).toLowerCase()) || null;
}

export function aggregateDir(relDir) {
  if (!state.git || (!state.git.isRepo && !(state.git.nestedRepos || []).length)) return null;
  return state.git.dirIndex.get(relDir) || null;
}

export async function selectFile(path, mode) {
  if (!state.wsId || !path) return;
  const entry = statusOf(path);
  state.selection.path = path;
  state.selection.mode = mode === "diff" && entry && state.caps.git ? "diff" : "preview";
  state.selection.staged = false;
  state.file = { path, loading: false, error: "", data: null };
  state.diff = { path: "", staged: false, loading: false, error: "", data: null };
  const tasks = [loadFile()];
  if (state.selection.mode === "diff") tasks.push(loadDiff());
  await Promise.all(tasks);
}

export async function setMode(mode) {
  const next = mode === "diff" && statusOf(state.selection.path) && state.caps.git ? "diff" : "preview";
  if (state.selection.mode === next) return;
  state.selection.mode = next;
  notify();
  if (next === "diff") await loadDiff();
  if (next === "preview" && !state.file.data && state.selection.path) await loadFile();
}

export async function setStaged(staged) {
  if (state.selection.staged === staged) return;
  state.selection.staged = staged;
  await loadDiff();
}

export async function loadFile() {
  const path = state.selection.path;
  if (!state.wsId || !path) {
    state.file = { path: "", loading: false, error: "", data: null };
    notify();
    return;
  }
  const seq = state.seq;
  state.file = { path, loading: true, error: "", data: null };
  notify();
  try {
    const data = await api.get("/v1/workspaces/" + state.wsId + "/files/content" + api.qs({ path }));
    if (seq !== state.seq || state.destroyed || state.selection.path !== path) return;
    state.file = { path, loading: false, error: "", data };
  } catch (e) {
    if (seq !== state.seq || state.destroyed || state.selection.path !== path) return;
    state.file = { path, loading: false, error: api.errorMessage(e), data: null };
  }
  notify();
}

export async function loadDiff() {
  const path = state.selection.path;
  if (!state.wsId || !path || !state.caps.git) return;
  const staged = !!state.selection.staged;
  const seq = state.seq;
  state.diff = { path, staged, loading: true, error: "", data: null };
  notify();
  try {
    const data = await api.get("/v1/workspaces/" + state.wsId + "/git/diff" + api.qs({ path, staged: staged ? "1" : "" }));
    if (seq !== state.seq || state.destroyed || state.selection.path !== path || state.selection.staged !== staged) return;
    state.diff = { path, staged, loading: false, error: "", data };
  } catch (e) {
    if (seq !== state.seq || state.destroyed || state.selection.path !== path || state.selection.staged !== staged) return;
    state.diff = { path, staged, loading: false, error: api.errorMessage(e), data: null };
  }
  notify();
}

export async function reloadSelection() {
  if (!state.selection.path) return;
  if (state.selection.mode === "diff") await loadDiff();
  else await loadFile();
}

/**
 * 刷新状态 + 树 + 当前预览/差异。
 * @param {{status?:boolean,tree?:boolean,file?:boolean}} [opts]
 */
export async function refreshAll(opts) {
  opts = opts || {};
  if (!state.wsId) return;
  const seq = state.seq;
  const tasks = [];
  if (opts.status !== false && state.caps.git) tasks.push(loadStatus());
  if (opts.tree !== false) {
    tasks.push(loadDir("", true));
    for (const dir of state.expanded) {
      if (dir !== "") tasks.push(loadDir(dir, true));
    }
  }
  await Promise.all(tasks);
  if (seq !== state.seq || state.destroyed) return;
  if (opts.file !== false) await reloadSelection();
}
