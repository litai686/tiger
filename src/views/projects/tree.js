// 项目管理视图：左栏下部的懒加载文件树
import { t as _t } from "../../i18n.js";
import { aggregateDir, state, statusOf } from "./store.js";
import * as store from "./store.js";
import { BADGE_LABEL, badgeOf, basename, parentDir } from "./git.js";

/** 重命名输入框在重绘前的光标位置（重绘后恢复，避免轮询/SSE 刷新丢焦点）。 */
let pendingRenameFocus = null;

function badgeSpan(badge) {
  const el = document.createElement("span");
  el.className = "projects-tree-badge projects-git-" + badge;
  el.textContent = BADGE_LABEL[badge] || "";
  return el;
}

function rowBase(level) {
  const row = document.createElement("div");
  row.className = "projects-tree-row";
  row.style.paddingLeft = 6 + level * 14 + "px";
  return row;
}

function renderRenameInput(row) {
  const input = document.createElement("input");
  input.className = "projects-rename-input";
  input.value = state.rename.value;
  input.spellcheck = false;
  input.disabled = !!state.rename.saving;
  input.title = _t("回车确认，Esc 取消");
  // 行本身带 toggle-dir/select-file，输入框内的点击不能冒泡。
  input.addEventListener("click", function (ev) {
    ev.stopPropagation();
  });
  input.addEventListener("dblclick", function (ev) {
    ev.stopPropagation();
  });
  input.addEventListener("input", function () {
    store.setRenameValue(input.value);
  });
  input.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      store.commitRename();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      store.cancelRename();
    }
  });
  row.appendChild(input);
  if (state.rename.needFocus) {
    state.rename.needFocus = false;
    setTimeout(function () {
      input.focus();
      input.select();
    }, 0);
  } else if (pendingRenameFocus) {
    const caret = pendingRenameFocus;
    pendingRenameFocus = null;
    setTimeout(function () {
      input.focus();
      try {
        input.setSelectionRange(caret.start, caret.end);
      } catch (_) {}
    }, 0);
  }
  return input;
}

function arrow(expanded, placeholder) {
  const el = document.createElement("span");
  el.className = "projects-tree-arrow";
  el.textContent = placeholder ? " " : expanded ? "▾" : "▸";
  return el;
}

function renderEntries(container, relDir, level) {
  const dirState = state.dirs.get(relDir);
  if (dirState && dirState.loading) {
    const row = rowBase(level);
    const spinner = document.createElement("span");
    spinner.className = "projects-spinner";
    row.appendChild(spinner);
    const text = document.createElement("span");
    text.className = "projects-tree-meta";
    text.textContent = _t("加载中...");
    row.appendChild(text);
    container.appendChild(row);
  }
  if (dirState && dirState.error) {
    const row = rowBase(level);
    row.setAttribute("data-action", "retry-dir");
    row.setAttribute("data-path", relDir);
    const mark = document.createElement("span");
    mark.className = "projects-tree-meta projects-git-deleted";
    mark.textContent = "! " + _t("无法读取该目录");
    mark.title = dirState.error;
    row.appendChild(mark);
    container.appendChild(row);
    return;
  }

  const entries = (dirState && dirState.entries ? dirState.entries.slice() : []);
  const seen = new Set(
    entries.map(function (e) {
      return e.path;
    })
  );
  if (state.git && state.git.isRepo) {
    for (const [p, e] of state.git.entries) {
      if (parentDir(p) !== relDir) continue;
      if (seen.has(p)) continue;
      if (e.index !== "D" && e.worktree !== "D") continue;
      let isDir = false;
      for (const other of state.git.entries.keys()) {
        if (other.indexOf(p + "/") === 0) {
          isDir = true;
          break;
        }
      }
      entries.push({ name: basename(p), path: p, is_dir: isDir, size: 0, mtime: 0, symlink: false, hidden: false, deleted: true });
    }
  }

  if (entries.length === 0 && dirState && !dirState.loading) {
    const row = rowBase(level);
    const text = document.createElement("span");
    text.className = "projects-tree-meta";
    text.textContent = _t("目录为空");
    row.appendChild(text);
    container.appendChild(row);
    return;
  }

  for (const entry of entries) {
    const renaming = !!state.rename.path && state.rename.path === entry.path;
    const row = rowBase(level);
    row.setAttribute("data-path", entry.path);
    if (!renaming) row.setAttribute("data-kind", entry.is_dir ? "dir" : "file");
    if (entry.deleted) row.setAttribute("data-deleted", "1");
    if (entry.external) row.setAttribute("data-external", "1");
    if (entry.is_dir) {
      row.className += " projects-tree-dir";
      if (!renaming && !entry.external && !entry.deleted) row.setAttribute("data-action", "toggle-dir");
    } else {
      if (!renaming) row.setAttribute("data-action", "select-file");
      if (state.selection.path === entry.path) row.className += " selected";
    }
    if (entry.external) {
      row.className += " external";
      row.title = _t("链接指向项目外");
    } else if (entry.path) {
      row.title = entry.path;
    }
    if (entry.symlink) {
      const link = document.createElement("span");
      link.className = "projects-tree-link";
      link.textContent = "↗";
      row.appendChild(link);
    }
    const expanded = entry.is_dir && state.expanded.has(entry.path);
    // 只有可折叠的目录显示箭头；文件与不可展开的节点留空白占位，保持名称对齐。
    const togglable = entry.is_dir && !entry.external && !entry.deleted;
    row.appendChild(arrow(expanded, !togglable));
    const entryStatus = entry.is_dir ? null : statusOf(entry.path);
    const badge = entry.is_dir ? aggregateDir(entry.path) : entryStatus ? badgeOf(entryStatus) : null;
    if (renaming) {
      renderRenameInput(row);
    } else {
      const name = document.createElement("span");
      name.className = "projects-tree-name";
      name.textContent = entry.name;
      if (entry.deleted) name.classList.add("projects-git-deleted");
      if (badge) name.classList.add("projects-git-" + badge);
      row.appendChild(name);
    }

    if (badge) {
      if (entry.is_dir) {
        const dot = document.createElement("span");
        dot.className = "projects-tree-dot";
        dot.style.background = "var(--git-" + badge + ")";
        dot.title = _t("该目录内有变更");
        row.appendChild(dot);
      } else {
        const el = badgeSpan(badge);
        el.title = entryStatus && entryStatus.orig_path ? entryStatus.orig_path + " → " + entry.path : badge;
        row.appendChild(el);
      }
    }
    if (entry.deleted) row.className += " projects-row-deleted";
    container.appendChild(row);
    if (renaming && state.rename.error) {
      const errorRow = rowBase(level + 1);
      const errorText = document.createElement("span");
      errorText.className = "projects-tree-meta projects-git-deleted";
      errorText.textContent = state.rename.error;
      errorRow.appendChild(errorText);
      container.appendChild(errorRow);
    }
    if (entry.is_dir && expanded) renderEntries(container, entry.path, level + 1);
  }
  if (dirState && dirState.truncated) {
    const row = rowBase(level);
    const text = document.createElement("span");
    text.className = "projects-tree-meta";
    text.textContent = _t("仅显示前 2000 项");
    row.appendChild(text);
    container.appendChild(row);
  }
}

/** @param {HTMLElement} container */
export function renderTree(container) {
  const active = document.activeElement;
  if (active && active.classList && active.classList.contains("projects-rename-input")) {
    const input = /** @type {HTMLInputElement} */ (active);
    pendingRenameFocus = { start: input.selectionStart || 0, end: input.selectionEnd || 0 };
  } else {
    pendingRenameFocus = null;
  }
  container.textContent = "";
  if (!state.activePath) {
    const empty = document.createElement("div");
    empty.className = "projects-placeholder";
    empty.textContent = _t("还没有加载项目");
    container.appendChild(empty);
    return;
  }
  if (!state.wsId) {
    const loading = document.createElement("div");
    loading.className = "projects-placeholder";
    loading.textContent = _t("正在加载项目...");
    container.appendChild(loading);
    return;
  }
  const rootRow = rowBase(0);
  rootRow.className += " projects-tree-dir";
  rootRow.setAttribute("data-action", "toggle-dir");
  rootRow.setAttribute("data-path", "");
  // 右键根节点（或树空白区）在项目根目录新建/上传，见 ui.js onContextMenu
  rootRow.setAttribute("data-root-dir", "1");
  rootRow.title = state.activePath;
  rootRow.appendChild(arrow(state.expanded.has(""), false));
  const rootName = document.createElement("span");
  rootName.className = "projects-tree-name";
  rootName.textContent = basename(state.activePath.replace(/\\/g, "/")) || state.activePath;
  rootRow.appendChild(rootName);
  container.appendChild(rootRow);
  if (state.expanded.has("")) renderEntries(container, "", 1);
}
