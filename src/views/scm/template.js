// 源码管理视图：模板与样式（选择器全部带 scm- 前缀，颜色走壳层变量 + Git 语义变量）
export const template = `
<style>
  .scm-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--c-bg);
    color: var(--c-text);
    --scm-sidebar-width: 300px;
    --git-modified: #e5c07b;
    --git-added: #98c379;
    --git-deleted: #ef596f;
    --git-renamed: #61afef;
    --git-conflict: #ff5c8a;
    --git-added-bg: rgba(152, 195, 121, 0.14);
    --git-deleted-bg: rgba(239, 89, 111, 0.14);
  }
  html[data-theme="light"] .scm-view {
    --git-modified: #9a6700;
    --git-added: #1a7f37;
    --git-deleted: #cf222e;
    --git-renamed: #0969da;
    --git-conflict: #a40e26;
    --git-added-bg: rgba(26, 127, 55, 0.12);
    --git-deleted-bg: rgba(207, 34, 46, 0.12);
  }

  .scm-banner {
    display: none;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    font-size: 12px;
    border-bottom: 1px solid var(--c-border);
    flex-shrink: 0;
  }
  .scm-banner.show { display: flex; }
  .scm-banner.warn { background: rgba(229, 192, 123, 0.12); color: var(--git-modified); }
  .scm-banner.error { background: rgba(239, 89, 111, 0.12); color: var(--git-deleted); }
  .scm-banner-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .scm-main { flex: 1; min-height: 0; display: flex; overflow: hidden; }
  .scm-sidebar {
    width: var(--scm-sidebar-width);
    min-width: 240px;
    max-width: 520px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--c-border);
    background: var(--c-panel);
    min-height: 0;
  }
  .scm-sidebar-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px 6px;
    flex-shrink: 0;
  }
  .scm-sidebar-title {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--c-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scm-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 3px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--c-text-3);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
  }
  .scm-icon-btn:hover { background: var(--c-overlay); color: var(--c-text-hi); }
  .scm-icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .scm-icon-btn.danger:hover { color: var(--git-deleted); }

  .scm-select-wrap { position: relative; padding: 0 10px 2px; flex-shrink: 0; }
  .scm-select {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    box-sizing: border-box;
    background: var(--c-panel-2);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    color: var(--c-text-hi);
    padding: 5px 8px;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }
  .scm-select:hover, .scm-select.open { border-color: var(--c-accent); }
  .scm-select-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scm-select-arrow { color: var(--c-text-3); font-size: 11px; flex-shrink: 0; }
  .scm-select-menu {
    display: none;
    position: absolute;
    left: 10px;
    right: 10px;
    top: calc(100% - 2px);
    max-height: 320px;
    overflow: auto;
    padding: 4px 0;
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    z-index: 40;
  }
  .scm-select-menu.show { display: block; }
  .scm-repo-item {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
    border-left: 2px solid transparent;
  }
  .scm-repo-item:hover { background: var(--c-panel-2); }
  .scm-repo-item.active { background: rgba(var(--c-accent-rgb), 0.16); border-left-color: var(--c-accent); }
  .scm-repo-item-name { color: var(--c-text-hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scm-repo-item-path {
    color: var(--c-text-3);
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .scm-group-label { padding: 4px 10px; font-size: 10px; color: var(--c-text-3); text-transform: uppercase; }

  .scm-branch-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 12px 6px;
    font-size: 11px;
    color: var(--c-text-2);
    flex-shrink: 0;
    white-space: nowrap;
    overflow: hidden;
  }
  .scm-branch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--c-text);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .scm-ahead { color: var(--git-added); }
  .scm-behind { color: var(--git-modified); }

  .scm-commit-box { padding: 0 10px 8px; flex-shrink: 0; }
  .scm-commit-input {
    width: 100%;
    box-sizing: border-box;
    min-height: 56px;
    max-height: 180px;
    resize: vertical;
    background: var(--c-panel-2);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    color: var(--c-text);
    padding: 6px 8px;
    font-size: 12px;
    font-family: inherit;
    line-height: 1.5;
  }
  .scm-commit-input:focus { outline: none; border-color: var(--c-accent); }
  .scm-commit-input:disabled { opacity: 0.55; cursor: not-allowed; }
  .scm-commit-actions { display: flex; margin-top: 6px; position: relative; }
  .scm-commit-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 0;
    padding: 6px 10px;
    background: var(--c-accent);
    color: #fff;
    border: none;
    border-radius: 6px 0 0 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .scm-commit-btn:hover { background: var(--c-accent-2); }
  .scm-commit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .scm-commit-more {
    width: 28px;
    background: var(--c-accent-2);
    color: #fff;
    border: none;
    border-left: 1px solid rgba(0, 0, 0, 0.25);
    border-radius: 0 6px 6px 0;
    font-size: 11px;
    cursor: pointer;
  }
  .scm-commit-more:hover { background: var(--c-accent); }
  .scm-commit-more:disabled { opacity: 0.5; cursor: not-allowed; }
  .scm-commit-menu {
    display: none;
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    min-width: 180px;
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    padding: 4px 0;
    z-index: 45;
  }
  .scm-commit-menu.show { display: block; }
  .scm-menu-item {
    padding: 6px 12px;
    font-size: 12px;
    color: var(--c-text);
    cursor: pointer;
    white-space: nowrap;
  }
  .scm-menu-item:hover { background: var(--c-panel-2); color: var(--c-text-hi); }
  .scm-menu-item.disabled { opacity: 0.4; cursor: not-allowed; }

  .scm-output {
    display: none;
    margin-top: 6px;
    padding: 6px 8px;
    background: var(--c-panel-2);
    border: 1px solid var(--c-border-soft);
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    line-height: 1.5;
    max-height: 160px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .scm-output.show { display: block; }
  .scm-output.error { border-color: rgba(239, 89, 111, 0.5); }
  .scm-output-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: inherit;
    color: var(--c-text-2);
    margin-bottom: 3px;
  }
  .scm-output-head .scm-output-dismiss {
    margin-left: auto;
    cursor: pointer;
    color: var(--c-text-3);
  }
  .scm-output-head .scm-output-dismiss:hover { color: var(--c-text-hi); }
  .scm-output-ok { color: var(--git-added); }
  .scm-output-bad { color: var(--git-deleted); }

  .scm-lists { flex: 1; min-height: 0; overflow: auto; }
  .scm-section { display: flex; flex-direction: column; }
  .scm-section-head {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--c-text-2);
    flex-shrink: 0;
    user-select: none;
    position: sticky;
    top: 0;
    background: var(--c-panel);
    z-index: 2;
  }
  .scm-collapse { width: 14px; text-align: center; cursor: pointer; color: var(--c-text-3); flex-shrink: 0; }
  .scm-collapse:hover { color: var(--c-text-hi); }
  .scm-section-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scm-count {
    min-width: 16px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--c-overlay);
    color: var(--c-text-2);
    font-size: 10px;
    font-weight: 600;
    text-align: center;
    line-height: 15px;
  }
  .scm-section-actions { margin-left: auto; display: flex; align-items: center; gap: 1px; }
  .scm-auto {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-right: 4px;
    font-size: 10px;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: var(--c-text-2);
    cursor: pointer;
  }
  .scm-auto input { margin: 0; cursor: pointer; }
  .scm-file {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 8px 0 14px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .scm-file:hover { background: var(--c-panel-2); }
  .scm-file.selected { background: rgba(var(--c-accent-rgb), 0.16); }
  .scm-file-badge { width: 13px; flex-shrink: 0; text-align: center; font-weight: 600; font-size: 11px; }
  .scm-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .scm-file-dir {
    flex-shrink: 0;
    max-width: 42%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    font-size: 10px;
    color: var(--c-text-3);
  }
  .scm-file-actions { display: none; align-items: center; gap: 1px; flex-shrink: 0; }
  .scm-file:hover .scm-file-actions, .scm-file.selected .scm-file-actions { display: flex; }
  .scm-file.deleted .scm-file-name { text-decoration: line-through; }
  .scm-git-conflict { color: var(--git-conflict) !important; font-weight: 700; }
  .scm-git-deleted { color: var(--git-deleted) !important; }
  .scm-git-modified { color: var(--git-modified) !important; }
  .scm-git-renamed { color: var(--git-renamed) !important; }
  .scm-git-added { color: var(--git-added) !important; }
  .scm-git-untracked { color: var(--git-added) !important; }

  .scm-graph-section {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    max-height: 45%;
    min-height: 0;
    border-top: 1px solid var(--c-border-soft);
  }
  .scm-graph { overflow-y: auto; overflow-x: hidden; min-height: 0; padding: 2px 0 6px; }
  .scm-graph-line {
    display: flex;
    align-items: center;
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    line-height: 1.5;
    white-space: nowrap;
    overflow: hidden;
    padding: 0 10px;
    cursor: default;
    color: var(--c-text);
  }
  .scm-graph-line.clickable { cursor: pointer; }
  .scm-graph-line.clickable:hover { background: var(--c-panel-2); }
  .scm-graph-caret { display: inline-block; width: 12px; flex-shrink: 0; color: var(--c-text-3); }
  .scm-graph-mark { color: var(--c-accent); flex-shrink: 0; margin-right: 4px; white-space: pre; }
  .scm-graph-hash { color: var(--git-modified); flex-shrink: 0; margin-right: 4px; }
  .scm-graph-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scm-graph-ref { color: var(--git-renamed); }
  .scm-graph-ref.head { color: var(--c-accent); font-weight: 600; }
  .scm-graph-ref.tag { color: var(--git-added); }
  .scm-graph-ref.remote { color: var(--c-text-3); }
  .scm-graph-subject { color: var(--c-text); }
  .scm-graph-empty { padding: 10px 12px; font-size: 11px; color: var(--c-text-3); }
  .scm-commit-files {
    margin: 0 0 4px 15px;
    padding: 2px 0 2px 8px;
    border-left: 1px solid var(--c-border-soft);
  }
  .scm-commit-file {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 8px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .scm-commit-file:hover { background: var(--c-panel-2); }
  .scm-commit-file.selected { background: rgba(var(--c-accent-rgb), 0.16); }
  .scm-commit-file.deleted .scm-file-name { text-decoration: line-through; }

  .scm-commit-pop {
    display: none;
    position: fixed;
    z-index: 210;
    width: min(520px, 62vw);
    max-height: 62vh;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--c-panel);
    border: 1px solid var(--c-border-hi);
    border-radius: 8px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
    padding: 10px 12px;
    font-size: 12px;
    color: var(--c-text);
    pointer-events: auto;
  }
  .scm-commit-pop.show { display: block; }
  .scm-pop-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 6px;
    color: var(--c-text-2);
    font-size: 11px;
  }
  .scm-pop-icon { color: var(--c-accent); font-size: 10px; }
  .scm-pop-hash { color: var(--git-modified); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .scm-pop-author { color: var(--c-text-2); }
  .scm-pop-date { color: var(--c-text-3); }
  .scm-pop-subject { color: var(--c-text-hi); font-weight: 600; margin-bottom: 6px; white-space: pre-wrap; word-break: break-word; }
  .scm-pop-body {
    color: var(--c-text-2);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 32vh;
    overflow-y: auto;
    overflow-x: hidden;
    margin-bottom: 8px;
  }
  .scm-pop-stats { border-top: 1px solid var(--c-border-soft); padding-top: 6px; color: var(--c-text-2); }
  .scm-pop-empty { color: var(--c-text-3); }

  .scm-splitter { width: 5px; cursor: col-resize; background: transparent; flex-shrink: 0; }
  .scm-splitter:hover { background: rgba(var(--c-accent-rgb), 0.25); }

  .scm-content { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  .scm-content-header { flex-shrink: 0; border-bottom: 1px solid var(--c-border); background: var(--c-panel); }
  .scm-breadcrumb {
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
  .scm-crumb-file { color: var(--c-text-hi); }
  .scm-crumb-badge { margin-left: 4px; }
  .scm-crumb-mode {
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--c-overlay);
    color: var(--c-text-2);
    font-size: 10px;
  }
  .scm-header-row { display: flex; align-items: center; gap: 8px; padding: 0 12px 6px; }
  .scm-seg { display: flex; border: 1px solid var(--c-border); border-radius: 6px; overflow: hidden; }
  .scm-seg-item {
    padding: 3px 10px;
    font-size: 11px;
    color: var(--c-text-2);
    cursor: pointer;
    background: var(--c-panel-2);
  }
  .scm-seg-item.active { background: var(--c-accent); color: #fff; }
  .scm-seg-item.disabled { opacity: 0.4; cursor: not-allowed; }
  .scm-spacer { flex: 1; }
  .scm-stat { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
  .scm-stat-add { color: var(--git-added); }
  .scm-stat-del { color: var(--git-deleted); }
  .scm-btn {
    background: var(--c-panel-2);
    color: var(--c-text-2);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 11px;
    cursor: pointer;
  }
  .scm-btn:hover { color: var(--c-text-hi); border-color: var(--c-accent); }
  .scm-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .scm-btn.danger { color: var(--git-deleted); border-color: rgba(239, 89, 111, 0.5); }

  .scm-content-body { flex: 1; min-height: 0; overflow: auto; position: relative; }
  .scm-placeholder { padding: 28px 20px; color: var(--c-text-3); font-size: 12px; text-align: center; }
  .scm-placeholder.error { color: var(--git-deleted); }
  .scm-placeholder-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 28px 20px; }
  .scm-notice {
    padding: 5px 12px;
    font-size: 11px;
    color: var(--git-modified);
    background: rgba(229, 192, 123, 0.12);
    border-bottom: 1px solid var(--c-border-soft);
  }
  .scm-spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid var(--c-border);
    border-top-color: var(--c-accent);
    border-radius: 50%;
    animation: scm-spin 0.8s linear infinite;
    vertical-align: middle;
  }
  @keyframes scm-spin { to { transform: rotate(360deg); } }

  .scm-diff { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; padding-bottom: 16px; }
  .scm-diff-row { display: flex; min-height: 19px; white-space: pre; }
  .scm-diff-no {
    width: 46px;
    flex-shrink: 0;
    text-align: right;
    padding-right: 8px;
    color: var(--c-text-3);
    user-select: none;
  }
  .scm-diff-sign { width: 14px; flex-shrink: 0; text-align: center; }
  .scm-diff-text { flex: 1; padding-right: 16px; }
  .scm-diff-add { background: var(--git-added-bg); }
  .scm-diff-add .scm-diff-sign { color: var(--git-added); }
  .scm-diff-del { background: var(--git-deleted-bg); }
  .scm-diff-del .scm-diff-sign { color: var(--git-deleted); }
  .scm-diff-hunk {
    position: sticky;
    top: 0;
    background: var(--c-panel-2);
    color: var(--c-text-2);
    padding: 2px 12px;
    border-top: 1px solid var(--c-border-soft);
    border-bottom: 1px solid var(--c-border-soft);
    z-index: 1;
  }
  .scm-diff-meta { color: var(--c-text-3); padding: 0 12px; font-style: italic; }
  .scm-diff-nonewline { color: var(--c-text-3); font-style: italic; padding: 0 12px; }

  .scm-split-row { display: flex; min-height: 19px; }
  .scm-split-side { width: 50%; min-width: 0; display: flex; white-space: pre; overflow: hidden; }
  .scm-split-side.right { border-left: 1px solid var(--c-border-soft); }
  .scm-split-side .scm-diff-no { width: 42px; }
  .scm-split-side.del { background: var(--git-deleted-bg); }
  .scm-split-side.del .scm-diff-sign { color: var(--git-deleted); }
  .scm-split-side.add { background: var(--git-added-bg); }
  .scm-split-side.add .scm-diff-sign { color: var(--git-added); }
  .scm-split-side.empty { background: rgba(127, 127, 127, 0.04); }
  .scm-split-side .scm-diff-text { overflow: hidden; }

  .scm-statusbar {
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
  .scm-status-item { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  .scm-status-error { color: var(--git-deleted); }
  .scm-status-spacer { flex: 1; }

  .scm-toast {
    display: none;
    position: fixed;
    left: 50%;
    bottom: 72px;
    transform: translateX(-50%);
    max-width: min(560px, 86vw);
    padding: 8px 16px;
    border-radius: 8px;
    background: var(--c-panel);
    border: 1px solid var(--c-border-hi);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
    color: var(--c-text-hi);
    font-size: 12px;
    z-index: 220;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 40vh;
    overflow: auto;
  }
  .scm-toast.show { display: block; }
  .scm-toast.error { border-color: rgba(239, 89, 111, 0.6); color: var(--git-deleted); }

  .scm-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 230;
  }
  .scm-modal-overlay.show { display: flex; }
  .scm-modal {
    width: min(520px, 92vw);
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 10px;
    padding: 16px 18px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  }
  .scm-modal.danger { border-color: rgba(239, 89, 111, 0.6); }
  .scm-modal-title { font-size: 14px; color: var(--c-text-hi); margin-bottom: 8px; font-weight: 600; }
  .scm-modal.danger .scm-modal-title { color: var(--git-deleted); }
  .scm-modal-body { font-size: 12px; color: var(--c-text-2); white-space: pre-wrap; margin-bottom: 10px; word-break: break-all; }
  .scm-modal-field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--c-text-2); margin-top: 8px; }
  .scm-modal-field input {
    background: var(--c-panel-2);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    color: var(--c-text);
    padding: 5px 8px;
    font-size: 12px;
  }
  .scm-modal-check { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; color: var(--c-text-2); margin-top: 8px; }
  .scm-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .scm-modal-warn { color: var(--git-deleted); }
</style>
<div class="scm-view" id="scm-view">
  <div class="scm-banner" id="scm-banner">
    <span class="scm-banner-text" id="scm-banner-text"></span>
    <button class="scm-btn" data-action="reload-workspace" data-i18n="重新加载">重新加载</button>
  </div>
  <div class="scm-main">
    <aside class="scm-sidebar" id="scm-sidebar">
      <div class="scm-sidebar-head">
        <span class="scm-sidebar-title" data-i18n="源代码管理">源代码管理</span>
        <button class="scm-icon-btn" data-action="refresh" title="刷新">&#8635;</button>
      </div>
      <div class="scm-select-wrap" id="scm-select-wrap">
        <button class="scm-select" id="scm-select" data-action="toggle-repo-menu">
          <span>&#128193;</span>
          <span class="scm-select-name" id="scm-select-name"></span>
          <span class="scm-select-arrow" id="scm-select-arrow">&#9662;</span>
        </button>
        <div class="scm-select-menu" id="scm-select-menu"></div>
      </div>
      <div class="scm-branch-row" id="scm-branch-row"></div>
      <div class="scm-commit-box">
        <textarea class="scm-commit-input" id="scm-commit-input" rows="3" spellcheck="false"></textarea>
        <div class="scm-commit-actions">
          <button class="scm-commit-btn" id="scm-commit-btn" data-action="commit">
            <span id="scm-commit-btn-text" data-i18n="提交">提交</span>
          </button>
          <button class="scm-commit-more" id="scm-commit-more" data-action="toggle-commit-menu" title="更多提交操作">&#9662;</button>
          <div class="scm-commit-menu" id="scm-commit-menu"></div>
        </div>
        <div class="scm-output" id="scm-output"></div>
      </div>
      <div class="scm-lists" id="scm-lists">
        <div class="scm-section" id="scm-changes-section">
          <div class="scm-section-head">
            <span class="scm-collapse" id="scm-changes-caret" data-action="toggle-section" data-section="changes">&#9662;</span>
            <span class="scm-section-title" data-i18n="更改">更改</span>
            <span class="scm-count" id="scm-changes-count"></span>
            <span class="scm-section-actions">
              <button class="scm-icon-btn" data-action="stage-all" title="暂存全部更改">&#65291;</button>
              <button class="scm-icon-btn danger" data-action="discard-all" title="丢弃全部更改">&#8634;</button>
            </span>
          </div>
          <div class="scm-changes-list" id="scm-changes-list"></div>
        </div>
        <div class="scm-section" id="scm-staged-section">
          <div class="scm-section-head">
            <span class="scm-collapse" id="scm-staged-caret" data-action="toggle-section" data-section="staged">&#9662;</span>
            <span class="scm-section-title" data-i18n="已暂存的更改">已暂存的更改</span>
            <span class="scm-count" id="scm-staged-count"></span>
            <span class="scm-section-actions">
              <button class="scm-icon-btn" data-action="unstage-all" title="取消暂存全部">&#65293;</button>
            </span>
          </div>
          <div class="scm-changes-list" id="scm-staged-list"></div>
        </div>
      </div>
      <div class="scm-graph-section" id="scm-graph-section">
        <div class="scm-section-head">
          <span class="scm-collapse" id="scm-graph-caret" data-action="toggle-section" data-section="graph">&#9662;</span>
          <span class="scm-section-title" data-i18n="图表">图表</span>
          <span class="scm-section-actions">
            <label class="scm-auto" title="状态变化时自动刷新提交图表">
              <input type="checkbox" id="scm-graph-auto" data-action="toggle-graph-auto" />
              <span data-i18n="自动">自动</span>
            </label>
            <button class="scm-icon-btn" data-action="refresh-graph" title="刷新图表">&#8635;</button>
          </span>
        </div>
        <div class="scm-graph" id="scm-graph"></div>
      </div>
    </aside>
    <div class="scm-splitter" id="scm-splitter"></div>
    <main class="scm-content" id="scm-content"></main>
  </div>
  <div class="scm-statusbar" id="scm-statusbar"></div>
  <div class="scm-commit-pop" id="scm-commit-pop"></div>
  <div class="scm-toast" id="scm-toast"></div>
  <div class="scm-modal-overlay" id="scm-modal"></div>
</div>
`;
