// 项目管理视图：右侧内容区（默认预览源文件，可编辑保存，有变更时可切到差异）
import { t as _t, tV } from "../../i18n.js";
import { state, statusOf, canEditSelection, editBlockedReason } from "./store.js";
import * as store from "./store.js";
import { badgeOf, BADGE_LABEL, hasStaged } from "./git.js";
import { fullAddRows, parseUnifiedDiff, renderDiffPlaceholder, renderDiffRows } from "./diff.js";

/** 重绘前编辑器的光标位置；渲染后恢复，避免 SSE/轮询刷新丢焦点。 */
let pendingEditorCaret = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function badgeNode(badge, title) {
  const span = el("span", "projects-tree-badge projects-git-" + badge, BADGE_LABEL[badge] || "");
  if (title) span.title = title;
  return span;
}

/** 当前选中文件是否应展示差异（有 Git 变更且服务端支持 Git）。 */
function diffEntry() {
  if (!state.caps.git || !state.selection.path) return null;
  return statusOf(state.selection.path);
}

function buildHeader(hasFile) {
  const header = el("div", "projects-content-header");
  const crumb = el("div", "projects-breadcrumb");
  const path = state.selection.path;
  if (path) {
    const parts = path.split("/");
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? acc + "/" + parts[i] : parts[i];
      const isLast = i === parts.length - 1;
      const span = el("span", "projects-crumb" + (isLast ? " projects-crumb-file" : ""));
      span.textContent = parts[i];
      if (isLast) {
        const status = statusOf(path);
        if (status) span.classList.add("projects-git-" + badgeOf(status));
      }
      if (!isLast) {
        span.setAttribute("data-action", "crumb-dir");
        span.setAttribute("data-path", acc);
        span.title = acc;
      }
      crumb.appendChild(span);
      if (!isLast) crumb.appendChild(el("span", "projects-crumb", "/"));
    }
    const entry = statusOf(path);
    if (entry) {
      const badge = badgeOf(entry);
      crumb.appendChild(badgeNode(badge, entry.orig_path ? entry.orig_path + " → " + path : badge));
      if (hasStaged(entry)) {
        const stagedMark = el("span", "projects-tree-dot");
        stagedMark.style.background = "var(--git-modified)";
        stagedMark.title = _t("包含已暂存变更");
        crumb.appendChild(stagedMark);
      }
    }
  } else {
    crumb.appendChild(el("span", "projects-crumb", state.activePath || ""));
  }
  header.appendChild(crumb);

  const row = el("div", "projects-header-row");
  const entry = diffEntry();
  const showDiff = !!entry && state.selection.mode === "diff";
  const tabs = el("div", "projects-tabs");
  const previewTab = el("div", "projects-tab" + (showDiff ? "" : " active"), _t("预览"));
  previewTab.setAttribute("data-action", "tab");
  previewTab.setAttribute("data-mode", "preview");
  tabs.appendChild(previewTab);
  if (entry && !state.editor.active) {
    const diffTab = el("div", "projects-tab" + (showDiff ? " active" : ""), _t("差异"));
    diffTab.setAttribute("data-action", "tab");
    diffTab.setAttribute("data-mode", "diff");
    tabs.appendChild(diffTab);
  }
  row.appendChild(tabs);
  // 「预览」旁的下载按钮：下载中按 workspace-download-progress 事件显示百分比进度
  if (hasFile) {
    const dl = state.download;
    const active = !!(dl && dl.active && dl.path === state.selection.path);
    let label = _t("下载");
    if (active) {
      label = dl.total > 0
        ? tV("下载中 {p}%", { p: Math.min(100, Math.floor((dl.received / dl.total) * 100)) })
        : _t("下载中...");
    }
    const download = el("button", "projects-btn", label);
    download.setAttribute("data-action", "download-file");
    if (active) download.disabled = true;
    row.appendChild(download);
  }
  row.appendChild(el("span", "projects-tab-spacer"));

  const tools = el("div", "projects-toolbar");
  if (showDiff) {
    const seg = el("div", "projects-seg");
    const worktreeOk = entry.worktree !== " " || entry.untracked;
    const stagedOk = hasStaged(entry);
    const work = el("div", "projects-seg-item" + (!state.selection.staged ? " active" : "") + (worktreeOk ? "" : " disabled"), _t("工作区"));
    if (worktreeOk) {
      work.setAttribute("data-action", "staged");
      work.setAttribute("data-staged", "0");
    }
    const staged = el("div", "projects-seg-item" + (state.selection.staged ? " active" : "") + (stagedOk ? "" : " disabled"), _t("暂存"));
    if (stagedOk) {
      staged.setAttribute("data-action", "staged");
      staged.setAttribute("data-staged", "1");
    }
    seg.appendChild(work);
    seg.appendChild(staged);
    tools.appendChild(seg);
  }
  if (hasFile) {
    if (state.editor.active) {
      const save = el("button", "projects-btn", state.editor.saving ? _t("保存中...") : _t("保存"));
      save.id = "projects-save-btn";
      save.setAttribute("data-action", "save-edit");
      if (state.editor.saving || !state.editor.dirty) save.disabled = true;
      tools.appendChild(save);
      const cancel = el("button", "projects-btn", state.editor.dirty ? _t("取消") : _t("退出编辑"));
      cancel.setAttribute("data-action", "cancel-edit");
      if (state.editor.saving) cancel.disabled = true;
      tools.appendChild(cancel);
      const dirty = el("span", "projects-dirty", state.editor.dirty ? _t("未保存") : "");
      dirty.id = "projects-dirty-mark";
      tools.appendChild(dirty);
    } else {
      if (state.caps.write) {
        const editable = canEditSelection();
        const edit = el("button", "projects-btn", _t("编辑"));
        edit.setAttribute("data-action", "edit");
        if (!editable) {
          edit.disabled = true;
          edit.title = editBlockedReason();
        }
        tools.appendChild(edit);
        const status = statusOf(state.selection.path);
        const deleted = !!status && (status.index === "D" || status.worktree === "D");
        if (!deleted) {
          const rename = el("button", "projects-btn", _t("重命名"));
          rename.setAttribute("data-action", "rename");
          tools.appendChild(rename);
        }
      }
      const refresh = el("button", "projects-btn", _t("刷新"));
      refresh.setAttribute("data-action", "refresh-file");
      tools.appendChild(refresh);
      const copy = el("button", "projects-btn", _t("复制路径"));
      copy.setAttribute("data-action", "copy-path");
      tools.appendChild(copy);
    }
  }
  row.appendChild(tools);
  header.appendChild(row);
  return header;
}

function syncDirtyMark() {
  if (!state.root) return;
  const mark = /** @type {HTMLElement|null} */ (state.root.querySelector("#projects-dirty-mark"));
  if (mark) mark.textContent = state.editor.dirty ? _t("未保存") : "";
  const save = /** @type {HTMLButtonElement|null} */ (state.root.querySelector("#projects-save-btn"));
  if (save) save.disabled = state.editor.saving || !state.editor.dirty;
  const cancel = /** @type {HTMLElement|null} */ (state.root.querySelector('[data-action="cancel-edit"]'));
  if (cancel) cancel.textContent = state.editor.dirty ? _t("取消") : _t("退出编辑");
}

/** 编辑态：草稿在 state.editor.draft，Ctrl/Cmd+S 保存，Esc（无改动时）取消。 */
function renderEditor(body) {
  body.classList.add("editing");
  if (state.editor.error) {
    body.appendChild(el("div", "projects-notice error", state.editor.error));
  }
  const ta = document.createElement("textarea");
  ta.className = "projects-editor";
  ta.value = state.editor.draft;
  ta.spellcheck = false;
  ta.setAttribute("wrap", "off");
  ta.addEventListener("input", function () {
    store.setDraft(ta.value);
    syncDirtyMark();
  });
  ta.addEventListener("scroll", function () {
    store.setEditorScroll(ta.scrollTop);
  });
  ta.addEventListener("keydown", function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === "s" || ev.key === "S")) {
      ev.preventDefault();
      store.saveEdit();
    } else if (ev.key === "Escape" && !state.editor.dirty) {
      ev.preventDefault();
      store.cancelEdit();
    }
  });
  body.appendChild(ta);
  ta.scrollTop = state.editor.scrollTop || 0;
  if (state.editor.needFocus) {
    state.editor.needFocus = false;
    ta.focus();
  } else if (pendingEditorCaret) {
    const caret = pendingEditorCaret;
    pendingEditorCaret = null;
    ta.focus();
    try {
      ta.setSelectionRange(caret.start, caret.end);
    } catch (_) {}
  }
}

function renderPreview(body) {
  if (state.editor.active) {
    renderEditor(body);
    return;
  }
  const file = state.file;
  if (file.loading) {
    body.appendChild(el("div", "projects-placeholder", _t("加载中...")));
    return;
  }
  if (file.error) {
    const box = el("div", "projects-placeholder error", file.error);
    body.appendChild(box);
    return;
  }
  const data = file.data;
  if (!data) {
    body.appendChild(el("div", "projects-placeholder", _t("请从左侧选择一个文件")));
    return;
  }
  if (data.binary) {
    body.appendChild(el("div", "projects-placeholder", _t("二进制文件，无法预览")));
    return;
  }
  if (data.truncated) {
    body.appendChild(el("div", "projects-notice", _t("文件过大，仅显示前 1 MB")));
  }
  if (!data.content) {
    body.appendChild(el("div", "projects-placeholder", _t("文件为空")));
    return;
  }
  const code = el("div", "projects-code");
  const frag = document.createDocumentFragment();
  let content = data.content;
  if (data.encoding === "utf-8-bom" && content.charCodeAt(0) === 0xfeff) content = content.substring(1);
  const lines = content.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const row = el("div", "projects-code-row");
    row.appendChild(el("span", "projects-code-no", String(i + 1)));
    row.appendChild(el("span", "projects-code-text", lines[i]));
    frag.appendChild(row);
  }
  code.appendChild(frag);
  body.appendChild(code);
}

function renderDiff(body) {
  const diff = state.diff;
  if (diff.loading) {
    body.appendChild(el("div", "projects-placeholder", _t("加载中...")));
    return;
  }
  if (diff.error) {
    body.appendChild(el("div", "projects-placeholder error", diff.error));
    return;
  }
  const data = diff.data;
  if (!data) {
    body.appendChild(el("div", "projects-placeholder", _t("请从左侧选择一个文件")));
    return;
  }
  const host = el("div", "projects-diff");
  if (data.binary) {
    body.appendChild(el("div", "projects-placeholder", _t("二进制文件，无法显示差异")));
    return;
  }
  if (data.untracked) {
    const file = state.file;
    if (file.loading || (!file.data && !file.error)) {
      body.appendChild(el("div", "projects-placeholder", _t("加载中...")));
      return;
    }
    if (file.error) {
      body.appendChild(el("div", "projects-placeholder error", file.error));
      return;
    }
    if (file.data.binary) {
      body.appendChild(el("div", "projects-placeholder", _t("二进制文件，无法显示差异")));
      return;
    }
    body.appendChild(el("div", "projects-notice", _t("未跟踪文件：显示完整内容")));
    const rows = fullAddRows(file.data.content || "");
    if (rows.length === 0) {
      body.appendChild(el("div", "projects-placeholder", _t("文件为空")));
      return;
    }
    renderDiffRows(host, rows);
    body.appendChild(host);
    return;
  }
  if (!data.diff) {
    renderDiffPlaceholder(host, data.staged ? "暂存区无差异" : "工作区无差异");
    body.appendChild(host);
    return;
  }
  if (data.truncated) {
    body.appendChild(el("div", "projects-notice", _t("差异过大，仅显示前 2 MB")));
  }
  renderDiffRows(host, parseUnifiedDiff(data.diff));
  body.appendChild(host);
}

/** @param {HTMLElement} container */
export function renderContent(container) {
  pendingEditorCaret = null;
  const active = document.activeElement;
  if (active && active.classList && active.classList.contains("projects-editor")) {
    const ta = /** @type {HTMLTextAreaElement} */ (active);
    pendingEditorCaret = { start: ta.selectionStart || 0, end: ta.selectionEnd || 0 };
  }
  container.textContent = "";
  if (!state.activePath) {
    container.appendChild(el("div", "projects-placeholder", _t("还没有加载项目")));
    return;
  }
  if (!state.wsId) {
    container.appendChild(el("div", "projects-placeholder", _t("正在加载项目...")));
    return;
  }
  const hasFile = !!state.selection.path;
  container.appendChild(buildHeader(hasFile));
  const body = el("div", "projects-content-body");
  container.appendChild(body);
  if (!state.caps.files) {
    body.appendChild(el("div", "projects-placeholder", _t("服务端版本过低，请升级服务端后使用项目管理")));
    return;
  }
  if (!hasFile) {
    body.appendChild(el("div", "projects-placeholder", _t("请从左侧选择一个文件")));
    return;
  }
  if (state.selection.mode === "diff" && diffEntry()) renderDiff(body);
  else renderPreview(body);
}
