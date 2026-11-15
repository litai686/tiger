// 项目管理视图：右侧内容区（默认预览源文件，有变更时可切到差异）
import { t as _t } from "../../i18n.js";
import { state, statusOf } from "./store.js";
import { badgeOf, BADGE_LABEL, hasStaged } from "./git.js";
import { fullAddRows, parseUnifiedDiff, renderDiffPlaceholder, renderDiffRows } from "./diff.js";

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
  if (entry) {
    const diffTab = el("div", "projects-tab" + (showDiff ? " active" : ""), _t("差异"));
    diffTab.setAttribute("data-action", "tab");
    diffTab.setAttribute("data-mode", "diff");
    tabs.appendChild(diffTab);
  }
  row.appendChild(tabs);
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
    const refresh = el("button", "projects-btn", _t("刷新"));
    refresh.setAttribute("data-action", "refresh-file");
    tools.appendChild(refresh);
    const copy = el("button", "projects-btn", _t("复制路径"));
    copy.setAttribute("data-action", "copy-path");
    tools.appendChild(copy);
  }
  row.appendChild(tools);
  header.appendChild(row);
  return header;
}

function renderPreview(body) {
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
