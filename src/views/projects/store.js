// 项目管理视图：单一状态源、请求序号与选择器
import { t as _t, tV } from "../../i18n.js";
import * as api from "./api.js";
import { basename, buildDirIndex } from "./git.js";
import { normalizePath, wsIdByPath } from "../shared/paths.js";

/**
 * @typedef {{name:string,path:string,source:"workdir"|"workspace",isDefault:boolean,wsId:string|null,loadState:string,error:string}} Project
 * @typedef {{name:string,path:string,is_dir:boolean,size:number,mtime:number,symlink:boolean,external?:boolean,hidden:boolean,deleted?:boolean}} DirEntry
 */

export const state = {
  /** @type {HTMLElement|null} */
  root: null,
  caps: { files: false, write: false, git: false },
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
  /** 下载到本机的进度（workspace-download-progress 事件驱动；按 path 匹配当前选中文件） */
  download: { path: "", received: 0, total: 0, active: false },
  /** 文本编辑：draft 只在前端，保存走 PUT files/content（带 mtime/size 乐观锁）。 */
  editor: { active: false, path: "", draft: "", dirty: false, saving: false, error: "", scrollTop: 0, needFocus: false },
  /** 文件树内联重命名：value 由输入框实时写回，Enter 提交、Esc 取消。 */
  rename: { path: "", isDir: false, value: "", saving: false, error: "", needFocus: false },
  pageError: "",
  seq: 0,
  destroyed: false,
  /** @type {any[]} */
  timers: [],
  /** @type {null|(() => void)} */
  unlisten: null,
};

let renderFn = () => {};
/** @type {(text: string) => void} */
let toastFn = () => {};

/** ui.js 注册渲染入口；store 只负责在数据变化后调用它。 */
export function onRender(fn) {
  renderFn = fn;
}

/** ui.js 注册全局 toast（写操作成功/失败提示）。 */
export function onToast(fn) {
  toastFn = fn;
}

function toast(text) {
  try {
    toastFn(text);
  } catch (_) {}
}

export function notify() {
  if (!state.destroyed) renderFn();
}

export function init(root) {
  state.root = root;
  state.destroyed = false;
  state.pageError = "";
  state.caps = { files: false, write: false, git: false };
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
  state.download = { path: "", received: 0, total: 0, active: false };
  state.editor = blankEditor();
  state.rename = blankRename();
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

// 进入页面默认展示当前工作目录：服务端 work_directories 的默认项就是代理
// 当前使用的工作目录（Agent 页切换目录会同步改默认项），不恢复上次浏览的项目。
export async function selectInitialProject() {
  let target = state.projects.find(function (p) {
    return p.isDefault;
  });
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
  state.download = { path: "", received: 0, total: 0, active: false };
  state.editor = blankEditor();
  state.rename = blankRename();
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
  if (state.editor.active) {
    if (state.selection.path === path) return;
    if (state.editor.dirty) {
      toast(_t("当前文件有未保存的修改，请先保存或取消"));
      return;
    }
    state.editor = blankEditor();
  }
  if (state.rename.path && state.rename.path !== path) {
    state.rename = blankRename();
  }
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
  if (state.editor.active) {
    toast(state.editor.dirty ? _t("当前文件有未保存的修改，请先保存或取消") : _t("请先保存或取消编辑"));
    return;
  }
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

// ===== 文件内容编辑（PUT files/content，带 mtime/size 乐观锁） =====

function blankEditor() {
  return { active: false, path: "", draft: "", dirty: false, saving: false, error: "", scrollTop: 0, needFocus: false };
}

function blankRename() {
  return { path: "", isDir: false, value: "", saving: false, error: "", needFocus: false };
}

/** 编辑器文本：剥离 BOM，并把 textarea 会规范化的 CRLF 统一成 LF（作为脏检查基线）。 */
function editorText(data) {
  const content = ((data && data.content) || "").replace(/\r\n/g, "\n");
  return content.charCodeAt(0) === 0xfeff ? content.substring(1) : content;
}

/** 原文件是否使用 CRLF（保存时按原换行风格写回）。 */
function usesCRLF(data) {
  return ((data && data.content) || "").indexOf("\r\n") !== -1;
}

/** 当前选中文件是否可以进入编辑（二进制/被截断/旧服务端都不行）。 */
export function canEditSelection() {
  if (!state.caps.write || !state.wsId || !state.selection.path) return false;
  const file = state.file;
  if (file.loading || file.error || !file.data) return false;
  if (file.path !== state.selection.path) return false;
  return !file.data.binary && !file.data.truncated;
}

export function editBlockedReason() {
  if (!state.caps.write) return _t("服务端版本过低，请升级服务端后使用文件编辑");
  const data = state.file.data;
  if (data && data.binary) return _t("二进制文件无法编辑");
  if (data && data.truncated) return _t("文件过大，暂不支持编辑");
  return _t("文件尚未加载完成");
}

export function startEdit() {
  if (state.editor.active || !state.selection.path) return;
  if (!canEditSelection()) {
    toast(editBlockedReason());
    return;
  }
  state.selection.mode = "preview";
  state.editor = {
    active: true,
    path: state.selection.path,
    draft: editorText(state.file.data),
    dirty: false,
    saving: false,
    error: "",
    scrollTop: 0,
    needFocus: true,
  };
  notify();
}

/** 输入框实时写回草稿；不触发渲染，避免每敲一个字符重建 textarea 丢焦点。 */
export function setDraft(value) {
  if (!state.editor.active) return;
  state.editor.draft = value;
  state.editor.dirty = value !== editorText(state.file.data);
}

export function setEditorScroll(top) {
  if (state.editor.active) state.editor.scrollTop = Number(top) || 0;
}

export function cancelEdit() {
  if (!state.editor.active || state.editor.saving) return;
  state.editor = blankEditor();
  notify();
}

export async function saveEdit() {
  if (!state.editor.active || state.editor.saving || !state.editor.dirty) return;
  const path = state.selection.path;
  const data = state.file.data;
  if (!data || !state.wsId) return;
  state.editor.saving = true;
  state.editor.error = "";
  notify();
  try {
    let content = state.editor.draft;
    // textarea 会把 CRLF 规范成 LF；原文件是 CRLF 时按原换行风格写回。
    if (usesCRLF(data) && content.indexOf("\r\n") === -1) {
      content = content.replace(/\n/g, "\r\n");
    }
    const res = await api.put("/v1/workspaces/" + state.wsId + "/files/content", {
      path,
      content,
      expected_mtime: data.mtime,
      expected_size: data.size,
    });
    if (state.destroyed) return;
    // 保存后留在编辑态：只把服务端返回的新 mtime/size 写回基线，
    // 不重拉文件，光标/滚动位置保持不变。
    const sameEditor = state.editor.active && state.editor.path === path;
    const sameSelection = state.selection.path === path;
    if (sameEditor || sameSelection) {
      const savedPath = res && typeof res.path === "string" && res.path ? res.path : path;
      const savedContent = data.encoding === "utf-8-bom" ? "\uFEFF" + content : content;
      state.file = {
        path: savedPath,
        loading: false,
        error: "",
        data: {
          ...data,
          path: savedPath,
          size: res && typeof res.size === "number" ? res.size : data.size,
          mtime: res && typeof res.mtime === "number" ? res.mtime : data.mtime,
          content: savedContent,
          truncated: false,
          binary: false,
        },
      };
      if (sameSelection) state.selection.path = savedPath;
      if (sameEditor) {
        state.editor.path = savedPath;
        state.editor.saving = false;
        state.editor.dirty = false;
      }
    }
    notify();
    toast(_t("已保存"));
    if (state.caps.git) await loadStatus();
  } catch (e) {
    if (state.destroyed) return;
    state.editor.saving = false;
    const message = api.errorMessage(e);
    state.editor.error = api.httpStatus(e) === 409 ? message : tV("保存失败: {err}", { err: message });
    notify();
  }
}

// ===== 文件/目录重命名（同目录内改 basename） =====

export function startRename(path, isDir) {
  if (!state.caps.write) {
    toast(_t("服务端版本过低，请升级服务端后使用重命名"));
    return;
  }
  if (!path) return;
  state.rename = { path, isDir: !!isDir, value: basename(path), saving: false, error: "", needFocus: true };
  notify();
}

/** 输入框实时写回名称；不触发渲染，保持焦点与光标。 */
export function setRenameValue(value) {
  if (!state.rename.path) return;
  state.rename.value = value;
}

export function cancelRename() {
  if (!state.rename.path || state.rename.saving) return;
  state.rename = blankRename();
  notify();
}

export async function commitRename() {
  if (!state.rename.path || state.rename.saving || !state.wsId) return;
  const oldPath = state.rename.path;
  const name = String(state.rename.value || "").trim();
  if (!name) {
    state.rename.error = _t("名称不能为空");
    notify();
    return;
  }
  if (name === basename(oldPath)) {
    state.rename = blankRename();
    notify();
    return;
  }
  state.rename.saving = true;
  state.rename.error = "";
  notify();
  try {
    const res = await api.post("/v1/workspaces/" + state.wsId + "/files/rename", { path: oldPath, name });
    if (state.destroyed) return;
    const newPath = (res && res.path) || oldPath;
    state.rename = blankRename();
    applyRename(oldPath, newPath);
    notify();
    toast(tV("已重命名为 {path}", { path: newPath }));
    await refreshAfterRename();
  } catch (e) {
    if (state.destroyed) return;
    state.rename.saving = false;
    state.rename.error = api.errorMessage(e);
    state.rename.needFocus = true;
    notify();
  }
}

function replacePrefix(path, oldPrefix, newPrefix) {
  if (!path) return path;
  if (path === oldPrefix) return newPrefix;
  if (path.indexOf(oldPrefix + "/") === 0) return newPrefix + path.substring(oldPrefix.length);
  return path;
}

/** 重命名成功后同步选中项/展开项/编辑器路径（目录重命名会迁移整棵子树前缀）。 */
function applyRename(oldPath, newPath) {
  if (state.selection.path) state.selection.path = replacePrefix(state.selection.path, oldPath, newPath);
  if (state.file.path) state.file.path = replacePrefix(state.file.path, oldPath, newPath);
  if (state.file.data && state.file.data.path) state.file.data.path = replacePrefix(state.file.data.path, oldPath, newPath);
  if (state.editor.active) state.editor.path = replacePrefix(state.editor.path, oldPath, newPath);
  const expanded = new Set();
  for (const dir of state.expanded) expanded.add(replacePrefix(dir, oldPath, newPath));
  state.expanded = expanded;
}

async function refreshAfterRename() {
  // 旧路径的目录缓存全部作废；已展开目录按新前缀重新加载。
  state.dirs.clear();
  await refreshAll({ status: true, tree: true, file: !state.editor.active });
}
