// 项目管理视图：模板与样式（全部选择器带 projects- 前缀，颜色走壳层变量 + Git 语义变量）
export const template = `
<style>
  .projects-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--c-bg);
    color: var(--c-text);
    --projects-sidebar-width: 300px;
    --git-modified: #e5c07b;
    --git-added: #98c379;
    --git-deleted: #ef596f;
    --git-renamed: #61afef;
    --git-conflict: #ff5c8a;
    --git-added-bg: rgba(152, 195, 121, 0.14);
    --git-deleted-bg: rgba(239, 89, 111, 0.14);
  }
  html[data-theme="light"] .projects-view {
    --git-modified: #9a6700;
    --git-added: #1a7f37;
    --git-deleted: #cf222e;
    --git-renamed: #0969da;
    --git-conflict: #a40e26;
    --git-added-bg: rgba(26, 127, 55, 0.12);
    --git-deleted-bg: rgba(207, 34, 46, 0.12);
  }

  .projects-banner {
    display: none;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    font-size: 12px;
    border-bottom: 1px solid var(--c-border);
    flex-shrink: 0;
  }
  .projects-banner.show { display: flex; }
  .projects-banner.warn { background: rgba(229, 192, 123, 0.12); color: var(--git-modified); }
  .projects-banner.error { background: rgba(239, 89, 111, 0.12); color: var(--git-deleted); }
  .projects-banner .projects-banner-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .projects-main {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow: hidden;
  }
  .projects-sidebar {
    width: var(--projects-sidebar-width);
    min-width: 220px;
    max-width: 480px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--c-border);
    background: var(--c-panel);
    min-height: 0;
  }
  .projects-section {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .projects-projects-section { flex-shrink: 0; }
  .projects-tree-section { flex: 1; min-height: 0; }
  .projects-section-title {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--c-text-2);
    border-bottom: 1px solid var(--c-border-soft);
    flex-shrink: 0;
    user-select: none;
  }
  .projects-select-wrap {
    position: relative;
    padding: 6px 8px 2px;
  }
  .projects-select {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    box-sizing: border-box;
    background: var(--c-panel-2);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    color: var(--c-text-hi);
    padding: 6px 10px;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }
  .projects-select:hover, .projects-select.open { border-color: var(--c-accent); }
  .projects-select-text {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    white-space: nowrap;
  }
  .projects-select-name { overflow: hidden; text-overflow: ellipsis; }
  .projects-select-arrow { color: var(--c-text-3); font-size: 12px; flex-shrink: 0; }
  .projects-select-menu {
    display: none;
    position: absolute;
    left: 8px;
    right: 8px;
    top: calc(100% - 2px);
    max-height: 340px;
    overflow: auto;
    padding: 4px 0;
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    z-index: 40;
  }
  .projects-select-menu.show { display: block; }
  .projects-select-menu::-webkit-scrollbar,
  .projects-tree::-webkit-scrollbar,
  .projects-content-body::-webkit-scrollbar { width: 6px; height: 6px; }
  .projects-select-menu::-webkit-scrollbar-thumb,
  .projects-tree::-webkit-scrollbar-thumb,
  .projects-content-body::-webkit-scrollbar-thumb {
    background: var(--c-border); border-radius: 3px;
  }
  .projects-tree {
    overflow: auto;
    min-height: 0;
    padding: 4px 0;
    flex: 1;
  }

  .projects-group-label {
    padding: 4px 12px;
    font-size: 10px;
    color: var(--c-text-3);
    text-transform: uppercase;
  }
  .projects-project {
    display: flex;
    flex-direction: column;
    padding: 4px 10px;
    cursor: pointer;
    border-left: 2px solid transparent;
    font-size: 12px;
  }
  .projects-project:hover { background: var(--c-panel-2); }
  .projects-project.active {
    background: rgba(var(--c-accent-rgb), 0.16);
    border-left-color: var(--c-accent);
  }
  .projects-project-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .projects-project-name { color: var(--c-text-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .projects-project-star { color: var(--git-modified); font-size: 10px; }
  .projects-project-path {
    font-size: 10px;
    color: var(--c-text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl;
    text-align: left;
  }
  .projects-project-status { font-size: 10px; color: var(--c-text-3); }
  .projects-project-status.error { color: var(--git-deleted); }

  .projects-splitter {
    width: 5px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
  }
  .projects-splitter:hover { background: rgba(var(--c-accent-rgb), 0.25); }

  .projects-tree-row {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 28px;
    padding-right: 8px;
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
  }
  .projects-tree-row:hover { background: var(--c-panel-2); }
  .projects-tree-row.selected { background: rgba(var(--c-accent-rgb), 0.16); }
  .projects-tree-row.external { opacity: 0.55; cursor: not-allowed; }
  .projects-tree-row.deleted .projects-tree-name { text-decoration: line-through; }
  .projects-tree-arrow {
    width: 22px;
    flex-shrink: 0;
    text-align: center;
    font-size: 18px;
    line-height: 1;
    color: var(--c-text-3);
  }
  .projects-tree-link {
    font-size: 14px;
    color: var(--c-text-3);
    flex-shrink: 0;
  }
  .projects-tree-name {
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }
  .projects-tree-dir .projects-tree-name { color: var(--c-text-hi); }
  .projects-tree-meta { font-size: 10px; color: var(--c-text-3); flex-shrink: 0; }
  .projects-tree-badge {
    font-size: 10px;
    font-weight: 600;
    width: 12px;
    text-align: center;
    flex-shrink: 0;
  }
  .projects-tree-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-right: 2px;
  }

  .projects-git-conflict { color: var(--git-conflict) !important; font-weight: 700; }
  .projects-git-deleted { color: var(--git-deleted) !important; }
  .projects-git-modified { color: var(--git-modified) !important; }
  .projects-git-renamed { color: var(--git-renamed) !important; }
  .projects-git-added { color: var(--git-added) !important; }
  .projects-git-untracked { color: var(--git-added) !important; }
  .projects-row-deleted .projects-tree-name { text-decoration: line-through; }

  .projects-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .projects-content-header {
    flex-shrink: 0;
    border-bottom: 1px solid var(--c-border);
    background: var(--c-panel);
  }
  .projects-breadcrumb {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 8px 12px 4px;
    font-size: 12px;
    color: var(--c-text-2);
    min-height: 24px;
    overflow: hidden;
    white-space: nowrap;
  }
  .projects-crumb { cursor: default; }
  .projects-crumb-file { color: var(--c-text-hi); }
  .projects-breadcrumb .projects-tree-badge { margin-left: 4px; }
  .projects-header-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px 6px;
  }
  .projects-tabs { display: flex; gap: 2px; background: var(--c-overlay); border-radius: 8px; padding: 3px; }
  .projects-tab {
    padding: 4px 14px;
    font-size: 12px;
    color: var(--c-text-2);
    border-radius: 6px;
    cursor: pointer;
    user-select: none;
  }
  .projects-tab:hover { color: var(--c-text); }
  .projects-tab.active { background: var(--c-accent); color: #fff; }
  .projects-tab-spacer { flex: 1; }
  .projects-toolbar { display: flex; align-items: center; gap: 6px; }
  .projects-btn {
    background: var(--c-panel-2);
    color: var(--c-text-2);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 11px;
    cursor: pointer;
  }
  .projects-btn:hover { color: var(--c-text-hi); border-color: var(--c-accent); }
  .projects-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .projects-seg { display: flex; border: 1px solid var(--c-border); border-radius: 6px; overflow: hidden; }
  .projects-seg-item {
    padding: 3px 10px;
    font-size: 11px;
    color: var(--c-text-2);
    cursor: pointer;
    background: var(--c-panel-2);
  }
  .projects-seg-item.active { background: var(--c-accent); color: #fff; }
  .projects-seg-item.disabled { opacity: 0.4; cursor: not-allowed; }

  .projects-content-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    position: relative;
  }
  .projects-placeholder {
    padding: 28px 20px;
    color: var(--c-text-3);
    font-size: 12px;
    text-align: center;
  }
  .projects-placeholder.error { color: var(--git-deleted); }
  .projects-notice {
    padding: 5px 12px;
    font-size: 11px;
    color: var(--git-modified);
    background: rgba(229, 192, 123, 0.12);
    border-bottom: 1px solid var(--c-border-soft);
  }
  .projects-spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid var(--c-border);
    border-top-color: var(--c-accent);
    border-radius: 50%;
    animation: projects-spin 0.8s linear infinite;
    vertical-align: middle;
  }
  @keyframes projects-spin { to { transform: rotate(360deg); } }

  .projects-code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.6;
    tab-size: 4;
    padding: 6px 0 16px;
  }
  .projects-code-row { display: flex; min-height: 19px; }
  .projects-code-row:hover { background: var(--c-panel-2); }
  .projects-code-no {
    width: 52px;
    flex-shrink: 0;
    text-align: right;
    padding-right: 10px;
    color: var(--c-text-3);
    user-select: none;
  }
  .projects-code-text {
    flex: 1;
    padding-right: 16px;
    white-space: pre;
    color: var(--c-text);
  }

  .projects-diff { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; padding-bottom: 16px; }
  .projects-diff-row { display: flex; min-height: 19px; white-space: pre; }
  .projects-diff-no {
    width: 46px;
    flex-shrink: 0;
    text-align: right;
    padding-right: 8px;
    color: var(--c-text-3);
    user-select: none;
  }
  .projects-diff-sign { width: 14px; flex-shrink: 0; text-align: center; }
  .projects-diff-text { flex: 1; padding-right: 16px; }
  .projects-diff-add { background: var(--git-added-bg); }
  .projects-diff-add .projects-diff-sign { color: var(--git-added); }
  .projects-diff-del { background: var(--git-deleted-bg); }
  .projects-diff-del .projects-diff-sign { color: var(--git-deleted); }
  .projects-diff-hunk {
    position: sticky;
    top: 0;
    background: var(--c-panel-2);
    color: var(--c-text-2);
    padding: 2px 12px;
    border-top: 1px solid var(--c-border-soft);
    border-bottom: 1px solid var(--c-border-soft);
    z-index: 1;
  }
  .projects-diff-meta { color: var(--c-text-3); padding: 0 12px; font-style: italic; }
  .projects-diff-nonewline { color: var(--c-text-3); font-style: italic; padding: 0 12px; }

  .projects-statusbar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 4px 12px;
    font-size: 11px;
    color: var(--c-text-2);
    border-top: 1px solid var(--c-border);
    background: var(--c-panel-2);
    min-height: 24px;
  }
  .projects-status-item { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  .projects-status-error { color: var(--git-deleted); }
  .projects-status-spacer { flex: 1; }
</style>
<div class="projects-view" id="projects-view">
  <div class="projects-banner" id="projects-banner">
    <span class="projects-banner-text" id="projects-banner-text"></span>
    <button class="projects-btn" data-action="reload-project" data-i18n="重新加载项目">重新加载项目</button>
  </div>
  <div class="projects-main">
    <aside class="projects-sidebar" id="projects-sidebar">
      <div class="projects-section projects-projects-section">
        <div class="projects-section-title"><span data-i18n="工作目录">工作目录</span></div>
        <div class="projects-select-wrap" id="projects-select-wrap">
          <button class="projects-select" id="projects-select" data-action="toggle-project-menu">
            <span class="projects-select-text" id="projects-select-text">
              <span class="projects-select-name" id="projects-select-name"></span>
            </span>
            <span class="projects-select-arrow" id="projects-select-arrow">▾</span>
          </button>
          <div class="projects-select-menu" id="projects-select-menu"></div>
        </div>
      </div>
      <div class="projects-section projects-tree-section">
        <div class="projects-section-title"><span data-i18n="文件">文件</span></div>
        <div class="projects-tree" id="projects-tree"></div>
      </div>
    </aside>
    <div class="projects-splitter" id="projects-splitter"></div>
    <main class="projects-content" id="projects-content"></main>
  </div>
  <div class="projects-statusbar" id="projects-statusbar"></div>
</div>
`;
