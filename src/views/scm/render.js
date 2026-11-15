// 源码管理视图：左栏（仓库 / 提交框 / 更改 / 已暂存 / 图表）+ 右侧差异的 DOM 渲染
// 服务端文本（路径、diff、git log 输出）一律走 textContent / DOM 节点，禁止 innerHTML 拼接。
import { t as _t, tV as _tV } from "../../i18n.js";
import { badgeOf, BADGE_LABEL, basename, parentDir } from "../projects/git.js";
import { state } from "./store.js";
import * as store from "./store.js";
import { diffStats, fullAddRows, parseUnifiedDiff, renderDiffRows, buildSplitRows, renderSplitRows } from "./diff.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** 悬停详情由 ui.js 直接操作；整页重绘时清掉，避免浮层停留在已失效的行旁边。 */
function hideCommitPop() {
  const pop = q("#scm-commit-pop");
  if (!pop) return;
  // 用户正把鼠标放在卡片上阅读时保留，等 ui.js 的 mouseleave 再收起。
  if (pop.matches && pop.matches(":hover")) return;
  pop.classList.remove("show");
  pop.textContent = "";
}

function q(selector) {
  return /** @type {HTMLElement|null} */ (state.root ? state.root.querySelector(selector) : null);
}

function iconBtn(action, path, glyph, title, extraClass) {
  const btn = el("button", "scm-icon-btn" + (extraClass ? " " + extraClass : ""), glyph);
  btn.setAttribute("data-action", action);
  if (path !== undefined && path !== null) btn.setAttribute("data-path", path);
  btn.title = _t(title);
  return btn;
}

/** @param {any} entry */
function sideBadge(entry, staged) {
  const overall = badgeOf(entry);
  if (overall === "conflict") return "conflict";
  if (!staged) return entry.untracked ? "untracked" : overall;
  if (entry.index === "A") return "added";
  if (entry.index === "D") return "deleted";
  if (entry.index === "R" || entry.index === "C") return "renamed";
  return "modified";
}

export function render() {
  if (!state.root || state.destroyed) return;
  const view = q("#scm-view");
  if (!view) return;
  hideCommitPop();

  renderViewModel(view);
  renderRepos();
  renderBranch();
  renderCommitBox();
  renderLists();
  renderGraph();
  renderContent();
  renderStatusBar();
  renderBanner(view);
  renderToast();
}

function renderViewModel(view) {
  const width = Number(localStorage.getItem("scm.sidebarWidth") || 300);
  view.style.setProperty("--scm-sidebar-width", (width >= 240 && width <= 520 ? width : 300) + "px");
}

// ===== 仓库选择 =====

function renderRepos() {
  const active = state.projects.find(function (p) {
    return p.path === state.activePath;
  });
  const name = q("#scm-select-name");
  if (name) {
    if (active) {
      name.textContent = (active.isDefault ? "★ " : "") + (active.name || active.path);
      name.title = active.path;
    } else if (state.projectsLoading) {
      name.textContent = _t("正在加载项目...");
      name.title = "";
    } else {
      name.textContent = state.projects.length ? _t("请选择仓库") : _t("还没有加载项目");
      name.title = "";
    }
  }
  const select = q("#scm-select");
  if (select) select.classList.toggle("open", state.projectsMenuOpen);
  const arrow = q("#scm-select-arrow");
  if (arrow) arrow.textContent = state.projectsMenuOpen ? "\u25B4" : "\u25BE";
  const menu = q("#scm-select-menu");
  if (!menu) return;
  menu.textContent = "";
  if (state.projectsLoading && state.projects.length === 0) {
    menu.appendChild(el("div", "scm-graph-empty", _t("正在加载项目...")));
  } else if (state.projectsError && state.projects.length === 0) {
    menu.appendChild(el("div", "scm-graph-empty", _t("加载项目失败: ") + state.projectsError));
  } else if (state.projects.length === 0) {
    menu.appendChild(el("div", "scm-graph-empty", _t("请先在 Agent 页的工作目录下拉中添加项目目录")));
  } else {
    const groups = [
      { key: "workdir", label: _t("工作目录") },
      { key: "workspace", label: _t("服务端工作区") },
      { key: "nested", label: _t("子目录 Git 仓库") },
    ];
    for (const group of groups) {
      const items = state.projects.filter(function (p) {
        return p.source === group.key;
      });
      if (!items.length) continue;
      menu.appendChild(el("div", "scm-group-label", group.label));
      for (const project of items) {
        const row = el("div", "scm-repo-item" + (project.path === state.activePath ? " active" : ""));
        row.setAttribute("data-action", "select-repo");
        row.setAttribute("data-path", project.path);
        row.title = project.path;
        row.appendChild(el("span", "scm-repo-item-name", (project.isDefault ? "★ " : "") + (project.name || project.path)));
        row.appendChild(el("span", "scm-repo-item-path", project.path));
        menu.appendChild(row);
      }
    }
  }
  menu.classList.toggle("show", state.projectsMenuOpen);
}

// ===== 分支行 =====

function renderBranch() {
  const row = q("#scm-branch-row");
  if (!row) return;
  row.textContent = "";
  if (!state.activePath) {
    row.appendChild(el("span", "", _t("请选择仓库")));
    return;
  }
  const git = state.git;
  if (!git) {
    if (state.activePath) {
      row.appendChild(el("span", "scm-spinner"));
      row.appendChild(el("span", "", _t("加载中...")));
    }
    return;
  }
  if (!git.exists) {
    row.appendChild(el("span", "scm-status-error", _t("项目目录不存在")));
    return;
  }
  if (!git.gitInstalled) {
    row.appendChild(el("span", "scm-status-error", _t("服务端未安装 git")));
    return;
  }
  if (!git.isRepo) {
    const nested = (git.nestedRepos || []).length;
    row.appendChild(el("span", "", _t("非 Git 仓库") + (nested ? " · " + _t("子目录 Git 仓库") + ": " + nested : "")));
    return;
  }
  const branch = el("span", "scm-branch", "\u2387 " + (git.detached ? "HEAD@" + git.head : git.branch || git.head || "-"));
  branch.title = git.detached ? _t("分离 HEAD") : _t("当前分支");
  row.appendChild(branch);
  if (git.ahead > 0) row.appendChild(el("span", "scm-ahead", "\u2191" + git.ahead));
  if (git.behind > 0) row.appendChild(el("span", "scm-behind", "\u2193" + git.behind));
  if (state.statusLoading) row.appendChild(el("span", "scm-spinner"));
}

// ===== 提交框 =====

function renderCommitBox() {
  const input = /** @type {HTMLTextAreaElement|null} */ (q("#scm-commit-input"));
  const btn = /** @type {HTMLButtonElement|null} */ (q("#scm-commit-btn"));
  const btnText = q("#scm-commit-btn-text");
  const more = /** @type {HTMLButtonElement|null} */ (q("#scm-commit-more"));
  const ready = store.isRepoReady() && state.caps.gitExec;
  const branchText = state.git && state.git.isRepo ? (state.git.detached ? "HEAD@" + state.git.head : state.git.branch || state.git.head || "") : "";

  if (input) {
    const placeholder = !ready
      ? state.activePath && !state.git
        ? _t("加载中...")
        : _t("非 Git 仓库，无法提交")
      : branchText
        ? _tV("消息（Ctrl+Enter 在 {branch} 上提交）", { branch: branchText })
        : _t("消息（Ctrl+Enter 提交）");
    input.disabled = !ready;
    input.placeholder = placeholder;
    // 输入时 state.message 与 textarea 始终同步（onInput 里先写 store），
    // 只有提交成功 / 切换仓库这类程序性清空才会出现不一致，此时必须覆盖。
    if (input.value !== state.message) input.value = state.message;
  }
  if (btn) {
    btn.disabled = !ready || state.action.running;
  }
  if (btnText) {
    btnText.textContent = state.action.running ? _t("执行中...") : "\u2713 " + _t("提交");
  }
  if (more) {
    more.disabled = !ready || state.action.running;
  }

  const menu = q("#scm-commit-menu");
  if (menu) {
    menu.textContent = "";
    const counts = store.changeCounts();
    const stagedItem = el("div", "scm-menu-item", _t("提交（已暂存）"));
    stagedItem.setAttribute("data-action", "commit-staged");
    if (!counts.staged) stagedItem.className += " disabled";
    const allItem = el("div", "scm-menu-item", _t("暂存全部并提交"));
    allItem.setAttribute("data-action", "commit-all");
    if (!counts.total) allItem.className += " disabled";
    menu.appendChild(stagedItem);
    menu.appendChild(allItem);
    menu.classList.toggle("show", !!state.commitMenuOpen);
  }
  renderActionOutput();
}

function renderActionOutput() {
  const out = q("#scm-output");
  if (!out) return;
  out.textContent = "";
  const action = state.action;
  if (!action.error && !action.result && !action.running) {
    out.classList.remove("show", "error");
    return;
  }
  out.classList.add("show");
  out.classList.toggle("error", !!action.error);
  const head = el("div", "scm-output-head");
  if (action.running) {
    head.appendChild(el("span", "scm-spinner"));
    head.appendChild(el("span", "", _t("执行中...") + " " + action.label));
  } else if (action.error) {
    head.appendChild(el("span", "scm-output-bad", _t("执行失败")));
  } else if (action.result) {
    const ok = action.result.exit_code === 0;
    head.appendChild(el("span", ok ? "scm-output-ok" : "scm-output-bad", (ok ? _t("完成") : _t("退出码")) + ": " + action.result.exit_code));
  }
  const dismiss = el("span", "scm-output-dismiss", "\u2715");
  dismiss.setAttribute("data-action", "clear-output");
  dismiss.title = _t("清空输出");
  head.appendChild(dismiss);
  out.appendChild(head);
  if (!action.running) {
    const body = action.error
      ? action.error
      : String((action.result && action.result.stdout) || "") + String((action.result && action.result.stderr) || "");
    out.appendChild(el("div", "", body.trim() || _t("无输出")));
  }
}

// ===== 更改列表 =====

function fileRow(entry, staged) {
  const badge = sideBadge(entry, staged);
  const selected = state.selection.path === entry.path && state.selection.staged === staged;
  const row = el("div", "scm-file" + (selected ? " selected" : "") + (badge === "deleted" ? " deleted" : ""));
  row.setAttribute("data-action", "select-entry");
  row.setAttribute("data-path", entry.path);
  row.setAttribute("data-staged", staged ? "1" : "0");
  row.title = entry.orig_path ? entry.orig_path + " \u2192 " + entry.path : entry.path;
  row.appendChild(el("span", "scm-file-badge scm-git-" + badge, BADGE_LABEL[badge] || ""));
  row.appendChild(el("span", "scm-file-name", basename(entry.path)));
  const dir = parentDir(entry.path);
  if (dir) row.appendChild(el("span", "scm-file-dir", dir));

  const actions = el("span", "scm-file-actions");
  // 主目录不是仓库（仅聚合子目录仓库）时，仓库级写命令不可用：只允许查看差异。
  const disabled = state.action.running || !state.caps.gitExec || !store.isRepoReady();
  if (!store.isRepoReady()) {
    row.appendChild(actions);
    return row;
  }
  if (staged) {
    if (store.hasWorktreeSide(entry) && !entry.untracked) {
      actions.appendChild(iconBtn("discard-file", entry.path, "\u21BA", "丢弃更改", "danger"));
    }
    const unstage = iconBtn("unstage-file", entry.path, "\u2212", "取消暂存");
    unstage.disabled = disabled;
    actions.appendChild(unstage);
  } else {
    if (!entry.untracked) {
      const discard = iconBtn("discard-file", entry.path, "\u21BA", "丢弃更改", "danger");
      discard.disabled = disabled;
      actions.appendChild(discard);
    }
    const stage = iconBtn("stage-file", entry.path, "\uFF0B", "暂存更改");
    stage.disabled = disabled;
    actions.appendChild(stage);
  }
  row.appendChild(actions);
  return row;
}

function renderLists() {
  const changes = store.unstagedEntries();
  const staged = store.stagedEntries();
  const counts = store.changeCounts();

  const changesList = q("#scm-changes-list");
  const stagedSection = q("#scm-staged-section");
  const stagedList = q("#scm-staged-list");
  const changesCount = q("#scm-changes-count");
  const stagedCount = q("#scm-staged-count");

  if (changesCount) changesCount.textContent = String(counts.unstaged);
  if (stagedCount) stagedCount.textContent = String(counts.staged);
  const actionsReady = store.isRepoReady() && state.caps.gitExec && !state.action.running;
  const setDisabled = function (selector, disabled) {
    const node = /** @type {HTMLButtonElement|null} */ (q(selector));
    if (node) node.disabled = disabled;
  };
  setDisabled('[data-action="stage-all"]', !actionsReady || counts.unstaged === 0);
  setDisabled('[data-action="discard-all"]', !actionsReady || counts.unstaged === 0);
  setDisabled('[data-action="unstage-all"]', !actionsReady || counts.staged === 0);
  setDisabled('[data-action="refresh-graph"]', !state.caps.gitExec);
  const changesCaret = q("#scm-changes-caret");
  if (changesCaret) changesCaret.textContent = state.sections.changes ? "\u25B8" : "\u25BE";
  const stagedCaret = q("#scm-staged-caret");
  if (stagedCaret) stagedCaret.textContent = state.sections.staged ? "\u25B8" : "\u25BE";

  if (changesList) {
    changesList.textContent = "";
    changesList.style.display = state.sections.changes ? "none" : "";
    const canShow = state.wsId && state.git && (state.git.isRepo || store.hasNestedRepos());
    if (!canShow) {
      // 非仓库 / 未加载：不给「没有更改」的空态，避免与 banner 重复。
    } else if (!changes.length) {
      changesList.appendChild(el("div", "scm-placeholder", _t("没有更改")));
    } else {
      for (const entry of changes) changesList.appendChild(fileRow(entry, false));
    }
  }
  if (stagedSection) stagedSection.style.display = staged.length ? "" : "none";
  if (stagedList) {
    stagedList.textContent = "";
    stagedList.style.display = state.sections.staged ? "none" : "";
    for (const entry of staged) stagedList.appendChild(fileRow(entry, true));
  }
}

// ===== 提交图表 =====

const COMMIT_BADGE = {
  A: { cls: "added", label: "A" },
  C: { cls: "added", label: "C" },
  D: { cls: "deleted", label: "D" },
  R: { cls: "renamed", label: "R" },
  U: { cls: "conflict", label: "U" },
  T: { cls: "modified", label: "T" },
  M: { cls: "modified", label: "M" },
};

function commitBadgeOf(status) {
  return COMMIT_BADGE[String(status || "M").charAt(0)] || COMMIT_BADGE.M;
}

/** @returns {{row:HTMLElement,hash:string}} */
function graphLine(line) {
  const row = el("div", "scm-graph-line");
  const m = String(line).match(/^([*|\\/_. ]*?)\s+([0-9a-f]{7,40})(?:\s+\(([^)]*)\))?\s?(.*)$/);
  if (!m) {
    row.appendChild(el("span", "scm-graph-mark", line));
    return { row, hash: "" };
  }
  const hash = m[2];
  const expanded = state.expandedCommits.has(hash);
  row.appendChild(el("span", "scm-graph-caret", expanded ? "\u25BE" : "\u25B8"));
  if (m[1]) row.appendChild(el("span", "scm-graph-mark", m[1]));
  const hashEl = el("span", "scm-graph-hash", hash.substring(0, 7));
  hashEl.setAttribute("data-action", "copy-hash");
  hashEl.setAttribute("data-hash", hash);
  hashEl.title = _t("点击复制提交哈希");
  row.appendChild(hashEl);
  // 提交说明（含分支/标签装饰）放进可截断容器：图表不出横向滚动条，悬停看完整详情。
  const textWrap = el("span", "scm-graph-text");
  if (m[3]) {
    textWrap.appendChild(document.createTextNode("("));
    const refs = String(m[3]).split(",").map(function (s) {
      return s.trim();
    }).filter(Boolean);
    refs.forEach(function (ref, i) {
      if (i) textWrap.appendChild(document.createTextNode(", "));
      let cls = "scm-graph-ref";
      if (/^HEAD/.test(ref)) cls += " head";
      else if (/^tag:/.test(ref)) cls += " tag";
      else if (ref.indexOf("/") >= 0) cls += " remote";
      textWrap.appendChild(el("span", cls, ref));
    });
    textWrap.appendChild(document.createTextNode(")"));
    if (m[4]) textWrap.appendChild(document.createTextNode(" "));
  }
  const subject = m[4] || "";
  if (subject) textWrap.appendChild(document.createTextNode(subject));
  row.appendChild(textWrap);
  row.classList.add("clickable");
  row.setAttribute("data-action", "toggle-commit");
  row.setAttribute("data-rev", hash);
  return { row, hash };
}

function commitFileRow(hash, file) {
  const badge = commitBadgeOf(file.status);
  const selected = state.selection.rev === hash && state.selection.path === file.path;
  const row = el("div", "scm-commit-file" + (selected ? " selected" : "") + (badge.cls === "deleted" ? " deleted" : ""));
  row.setAttribute("data-action", "select-commit-file");
  row.setAttribute("data-rev", hash);
  row.setAttribute("data-path", file.path);
  row.title = file.origPath ? file.origPath + " \u2192 " + file.path : file.path;
  row.appendChild(el("span", "scm-file-badge scm-git-" + badge.cls, badge.label));
  row.appendChild(el("span", "scm-file-name", basename(file.path)));
  const dir = parentDir(file.path);
  if (dir) row.appendChild(el("span", "scm-file-dir", dir));
  return row;
}

function renderCommitFiles(hash) {
  const wrap = el("div", "scm-commit-files");
  const cached = state.commitCache.get(hash);
  if (!cached || (cached.loading && !(cached.files || []).length)) {
    wrap.appendChild(el("div", "scm-graph-empty", _t("加载中...")));
    return wrap;
  }
  if (cached.error) {
    wrap.appendChild(el("div", "scm-graph-empty scm-status-error", _t("加载失败") + ": " + cached.error));
    return wrap;
  }
  const files = cached.files || [];
  if (!files.length) {
    wrap.appendChild(el("div", "scm-graph-empty", _t("本次提交没有文件变更")));
    return wrap;
  }
  for (const file of files) wrap.appendChild(commitFileRow(hash, file));
  return wrap;
}

function renderGraph() {
  const section = q("#scm-graph-section");
  const host = q("#scm-graph");
  const caret = q("#scm-graph-caret");
  const auto = /** @type {HTMLInputElement|null} */ (q("#scm-graph-auto"));
  if (caret) caret.textContent = state.sections.graph ? "\u25B8" : "\u25BE";
  if (auto) auto.checked = !!state.graph.auto;
  if (!host) return;
  host.style.display = state.sections.graph ? "none" : "";
  if (section) {
    section.style.flex = state.sections.graph ? "0 0 auto" : "";
    // 展开提交文件列表时给图表更多高度，避免文件列表被压在 45% 里反复滚动。
    section.style.maxHeight = !state.sections.graph && state.expandedCommits.size ? "65%" : "";
  }
  // 整段重建会丢失滚动位置：展开提交/选中文件都会触发 notify，这里记住再恢复。
  const scrollTop = host.scrollTop;
  host.textContent = "";
  if (state.sections.graph) return;
  if (!state.wsId) return;
  if (!state.caps.gitExec) {
    host.appendChild(el("div", "scm-graph-empty", _t("服务端版本过低，无法加载提交图表")));
    return;
  }
  if (!state.git) return;
  if (!state.git.isRepo) {
    host.appendChild(el("div", "scm-graph-empty", _t("非 Git 仓库，无法加载提交图表")));
    return;
  }
  if (state.graph.loading && !state.graph.lines.length) {
    host.appendChild(el("div", "scm-graph-empty", _t("加载中...")));
    return;
  }
  if (state.graph.error) {
    host.appendChild(el("div", "scm-graph-empty scm-status-error", _t("图表加载失败: ") + state.graph.error));
    return;
  }
  if (!state.graph.lines.length) {
    host.appendChild(el("div", "scm-graph-empty", _t("尚无提交记录")));
    return;
  }
  for (const line of state.graph.lines) {
    const parsed = graphLine(line);
    host.appendChild(parsed.row);
    if (parsed.hash && state.expandedCommits.has(parsed.hash)) host.appendChild(renderCommitFiles(parsed.hash));
  }
  host.scrollTop = scrollTop;
}

// ===== 右侧差异 =====

export function renderContent() {
  const host = q("#scm-content");
  if (!host) return;
  host.textContent = "";
  if (state.pageError) {
    const wrap = el("div", "scm-placeholder-wrap");
    wrap.appendChild(el("div", "scm-placeholder", _t(state.pageError)));
    if (state.pageError === "未连接服务端") {
      const button = el("button", "scm-btn", _t("去设置连接服务端"));
      button.setAttribute("data-action", "goto-settings");
      wrap.appendChild(button);
    }
    host.appendChild(wrap);
    return;
  }
  if (!state.wsId) {
    const waiting = state.projectsLoading || state.projects.length > 0;
    host.appendChild(el("div", "scm-placeholder", waiting ? _t("加载中...") : _t("请先在 Agent 页的工作目录下拉中添加项目目录")));
    return;
  }
  if (!state.git) {
    host.appendChild(el("div", "scm-placeholder", _t("加载中...")));
    return;
  }
  if (!state.git.exists) {
    host.appendChild(el("div", "scm-placeholder error", _t("服务端上该目录不存在或已失去访问权限")));
    return;
  }
  if (!state.git.gitInstalled) {
    host.appendChild(el("div", "scm-placeholder error", _t("服务端未安装 git")));
    return;
  }
  if (!state.git.isRepo && !store.hasNestedRepos()) {
    host.appendChild(el("div", "scm-placeholder", _t("非 Git 仓库，无法使用源码管理")));
    return;
  }
  if (!state.selection.path) {
    host.appendChild(el("div", "scm-placeholder", _t("请从左侧选择一个更改")));
    return;
  }

  const path = state.selection.path;
  const entry = store.entryOf(path);
  host.appendChild(buildHeader(path, entry));

  const body = el("div", "scm-content-body");
  host.appendChild(body);
  const diff = state.diff;
  if (diff.loading && !diff.data) {
    body.appendChild(el("div", "scm-placeholder", _t("加载中...")));
    return;
  }
  if (diff.error) {
    body.appendChild(el("div", "scm-placeholder error", diff.error));
    return;
  }
  const data = diff.data;
  if (!data) {
    body.appendChild(el("div", "scm-placeholder", _t("请从左侧选择一个更改")));
    return;
  }
  const diffHost = el("div", "scm-diff" + (state.diffView === "split" ? " scm-diff-split" : ""));
  if (data.binary) {
    body.appendChild(el("div", "scm-placeholder", _t("二进制文件，无法显示差异")));
    return;
  }
  if (data.untracked) {
    const file = state.file;
    if (file.loading && !file.data) {
      body.appendChild(el("div", "scm-placeholder", _t("加载中...")));
      return;
    }
    if (file.error) {
      body.appendChild(el("div", "scm-placeholder error", file.error));
      return;
    }
    if (file.data && file.data.binary) {
      body.appendChild(el("div", "scm-placeholder", _t("二进制文件，无法显示差异")));
      return;
    }
    body.appendChild(el("div", "scm-notice", _t("未跟踪文件：显示完整内容")));
    const rows = fullAddRows((file.data && file.data.content) || "");
    setDiffStat(rows);
    if (!rows.length) {
      body.appendChild(el("div", "scm-placeholder", _t("文件为空")));
      return;
    }
    renderRows(diffHost, rows);
    body.appendChild(diffHost);
    return;
  }
  if (!data.diff) {
    setDiffStat([]);
    const text = state.selection.rev
      ? _t("该提交未改动此文件")
      : data.staged
        ? _t("暂存区无差异")
        : _t("工作区无差异");
    body.appendChild(el("div", "scm-placeholder", text));
    return;
  }
  if (data.truncated) {
    body.appendChild(el("div", "scm-notice", state.selection.rev ? _t("差异过大，仅显示部分内容") : _t("差异过大，仅显示前 2 MB")));
  }
  const rows = parseUnifiedDiff(data.diff);
  setDiffStat(rows);
  renderRows(diffHost, rows);
  body.appendChild(diffHost);
}

/** 按当前布局偏好渲染差异行：并排（默认，VSCode 风格）/ 统一。 */
function renderRows(host, rows) {
  if (state.diffView === "unified") renderDiffRows(host, rows);
  else renderSplitRows(host, buildSplitRows(rows));
}

function setDiffStat(rows) {
  const node = q("#scm-diff-stat");
  if (!node) return;
  node.textContent = "";
  const stats = diffStats(rows || []);
  if (!stats.adds && !stats.dels) return;
  if (stats.adds) node.appendChild(el("span", "scm-stat-add", "+" + stats.adds));
  if (stats.dels) {
    if (stats.adds) node.appendChild(document.createTextNode(" "));
    node.appendChild(el("span", "scm-stat-del", "\u2212" + stats.dels));
  }
}

function buildHeader(path, entry) {
  const rev = state.selection.rev;
  const commitFile = rev ? store.commitFileOf(rev, path) : null;
  const header = el("div", "scm-content-header");
  const crumb = el("div", "scm-breadcrumb");
  const parts = String(path).split("/");
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    acc = acc ? acc + "/" + parts[i] : parts[i];
    const isLast = i === parts.length - 1;
    const span = el("span", isLast ? "scm-crumb-file" : "");
    span.textContent = parts[i];
    crumb.appendChild(span);
    if (!isLast) {
      crumb.appendChild(el("span", "", "/"));
    }
  }
  if (rev) {
    if (commitFile) {
      const badge = commitBadgeOf(commitFile.status);
      crumb.appendChild(el("span", "scm-file-badge scm-crumb-badge scm-git-" + badge.cls, badge.label));
    }
    crumb.appendChild(el("span", "scm-crumb-mode", _tV("提交 {rev}", { rev: rev.substring(0, 7) })));
  } else {
    if (entry) {
      const badge = sideBadge(entry, state.selection.staged);
      crumb.appendChild(el("span", "scm-file-badge scm-crumb-badge scm-git-" + badge, BADGE_LABEL[badge] || ""));
    }
    crumb.appendChild(el("span", "scm-crumb-mode", state.selection.staged ? _t("暂存") : _t("工作区")));
  }
  header.appendChild(crumb);

  const row = el("div", "scm-header-row");
  if (rev) {
    const back = el("button", "scm-btn", _t("返回工作区"));
    back.setAttribute("data-action", "clear-commit-view");
    row.appendChild(back);
  } else if (entry) {
    const seg = el("div", "scm-seg");
    const work = el("div", "scm-seg-item" + (!state.selection.staged ? " active" : "") + (store.hasWorktreeSide(entry) ? "" : " disabled"), _t("工作区"));
    if (store.hasWorktreeSide(entry)) {
      work.setAttribute("data-action", "diff-mode");
      work.setAttribute("data-staged", "0");
    }
    const staged = el("div", "scm-seg-item" + (state.selection.staged ? " active" : "") + (store.hasStagedSide(entry) ? "" : " disabled"), _t("暂存"));
    if (store.hasStagedSide(entry)) {
      staged.setAttribute("data-action", "diff-mode");
      staged.setAttribute("data-staged", "1");
    }
    seg.appendChild(work);
    seg.appendChild(staged);
    row.appendChild(seg);
  }
  const viewSeg = el("div", "scm-seg");
  const splitItem = el("div", "scm-seg-item" + (state.diffView === "split" ? " active" : ""), _t("并排"));
  splitItem.setAttribute("data-action", "diff-view");
  splitItem.setAttribute("data-view", "split");
  const unifiedItem = el("div", "scm-seg-item" + (state.diffView === "unified" ? " active" : ""), _t("统一"));
  unifiedItem.setAttribute("data-action", "diff-view");
  unifiedItem.setAttribute("data-view", "unified");
  viewSeg.appendChild(splitItem);
  viewSeg.appendChild(unifiedItem);
  row.appendChild(viewSeg);
  row.appendChild(el("span", "scm-spacer"));
  row.appendChild(el("span", "scm-stat", ""));
  const stat = row.querySelector(".scm-stat");
  if (stat) stat.id = "scm-diff-stat";
  const refresh = el("button", "scm-btn", _t("刷新"));
  refresh.setAttribute("data-action", "refresh-diff");
  row.appendChild(refresh);
  const copy = el("button", "scm-btn", _t("复制路径"));
  copy.setAttribute("data-action", "copy-path");
  row.appendChild(copy);
  header.appendChild(row);
  return header;
}

// ===== 状态栏 / 横幅 / 提示 =====

function renderStatusBar() {
  const bar = q("#scm-statusbar");
  if (!bar) return;
  bar.textContent = "";
  const item = function (text, className) {
    const node = el("span", "scm-status-item" + (className ? " " + className : ""), text);
    return node;
  };
  if (!state.activePath) {
    bar.appendChild(item(_t("请选择仓库")));
    return;
  }
  if (!state.caps.git) {
    bar.appendChild(item(_t("服务端版本过低，请升级服务端后使用源码管理")));
    return;
  }
  if (state.statusLoading) bar.appendChild(el("span", "scm-spinner"));
  const git = state.git;
  if (!git) {
    bar.appendChild(item(_t("加载中...")));
    return;
  }
  if (!git.exists) {
    bar.appendChild(item(_t("服务端上该目录不存在或已失去访问权限"), "scm-status-error"));
    return;
  }
  if (!git.isRepo) {
    const nested = (git.nestedRepos || []).length;
    bar.appendChild(item(nested ? _t("子目录 Git 仓库") + ": " + nested : _t("非 Git 仓库")));
    if (!git.gitInstalled) bar.appendChild(item(_t("服务端未安装 git"), "scm-status-error"));
    return;
  }
  const branchText = git.detached ? "HEAD@" + git.head : "\u2387 " + (git.branch || git.head || "-");
  bar.appendChild(item(branchText));
  if (git.ahead > 0) bar.appendChild(item("\u2191" + git.ahead, "scm-ahead"));
  if (git.behind > 0) bar.appendChild(item("\u2193" + git.behind, "scm-behind"));
  const counts = store.changeCounts();
  const parts = [];
  if (counts.unstaged) parts.push(counts.unstaged + " " + _t("更改"));
  if (counts.staged) parts.push(counts.staged + " " + _t("暂存"));
  if (parts.length) bar.appendChild(item(parts.join(" · ")));
  if (git.truncated) bar.appendChild(item(_t("状态已截断")));
  if (state.statusError) {
    bar.appendChild(item(_t("状态刷新失败: ") + state.statusError, "scm-status-error"));
  } else if (state.lastStatusAt) {
    const spacer = el("span", "scm-status-spacer");
    bar.appendChild(spacer);
    bar.appendChild(item(_t("最近刷新 ") + new Date(state.lastStatusAt).toLocaleTimeString()));
  }
}

function activeProjectError() {
  const active = state.projects.find(function (p) {
    return p.path === state.activePath;
  });
  return active && active.loadState === "error" ? active.error || _t("未知错误") : "";
}

function renderBanner(view) {
  const banner = q("#scm-banner");
  const text = q("#scm-banner-text");
  if (!banner || !text) return;
  banner.className = "scm-banner";
  let message = "";
  let level = "warn";
  if (state.pageError) {
    message = state.pageError;
    level = "error";
  } else if (state.statusStatus === 404 && state.activePath) {
    message = _t("工作区失效，请重新加载");
    level = "error";
  } else if (state.git && state.git.exists === false) {
    message = _t("服务端上该目录不存在或已失去访问权限");
    level = "error";
  } else if (state.statusError) {
    message = _t("状态刷新失败: ") + state.statusError;
    level = "error";
  } else if (activeProjectError()) {
    message = _t("加载项目失败: ") + activeProjectError();
    level = "error";
  } else if (!state.caps.gitExec && state.activePath) {
    message = _t("服务端版本过低，仅可查看变更与差异");
  } else if (store.hasNestedRepos()) {
    message = _t("当前目录不是 Git 仓库，仅展示子目录仓库的聚合状态");
  } else if (state.git && state.git.truncated) {
    message = _t("状态已截断");
  }
  if (!message) return;
  banner.classList.add("show", level);
  text.textContent = message;
  text.title = message;
}

function renderToast() {
  const node = q("#scm-toast");
  if (!node) return;
  const toast = state.toast;
  if (!toast || Date.now() > toast.until) {
    node.classList.remove("show", "error");
    return;
  }
  node.textContent = toast.text;
  node.classList.add("show");
  node.classList.toggle("error", !!toast.error);
}
