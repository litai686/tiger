// 项目管理视图：左栏下部的懒加载文件树
import { t as _t } from "../../i18n.js";
import { aggregateDir, state, statusOf } from "./store.js";
import { BADGE_LABEL, badgeOf, basename, parentDir } from "./git.js";

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
    const row = rowBase(level);
    row.setAttribute("data-path", entry.path);
    if (entry.is_dir) {
      row.className += " projects-tree-dir";
      if (!entry.external && !entry.deleted) row.setAttribute("data-action", "toggle-dir");
    } else {
      row.setAttribute("data-action", "select-file");
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
    const name = document.createElement("span");
    name.className = "projects-tree-name";
    name.textContent = entry.name;
    if (entry.deleted) name.classList.add("projects-git-deleted");
    const entryStatus = entry.is_dir ? null : statusOf(entry.path);
    const badge = entry.is_dir ? aggregateDir(entry.path) : entryStatus ? badgeOf(entryStatus) : null;
    if (badge) name.classList.add("projects-git-" + badge);
    row.appendChild(name);

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
  rootRow.title = state.activePath;
  rootRow.appendChild(arrow(state.expanded.has(""), false));
  const rootName = document.createElement("span");
  rootName.className = "projects-tree-name";
  rootName.textContent = basename(state.activePath.replace(/\\/g, "/")) || state.activePath;
  rootRow.appendChild(rootName);
  container.appendChild(rootRow);
  if (state.expanded.has("")) renderEntries(container, "", 1);
}
