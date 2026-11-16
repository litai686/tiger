// 终端视图：模板与样式（选择器全部带 terminal- 前缀，颜色走壳层变量）
export const template = `
<style>
  .terminal-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--c-bg);
    color: var(--c-text);
  }
  .terminal-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--c-border);
    flex-shrink: 0;
  }
  .terminal-title { font-size: 14px; font-weight: 600; color: var(--c-text-hi); }
  .terminal-head-hint { font-size: 12px; color: var(--c-text-3); }
  .terminal-select {
    background: var(--c-panel);
    color: var(--c-text);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 12px;
    max-width: 360px;
  }
  .terminal-btn {
    background: var(--c-panel);
    color: var(--c-text);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    transition: border-color 0.2s, color 0.2s;
  }
  .terminal-btn:hover { border-color: var(--c-accent); color: var(--c-text-hi); }
  .terminal-btn:disabled { opacity: 0.45; cursor: default; border-color: var(--c-border); color: var(--c-text-3); }
  .terminal-banner {
    display: none;
    padding: 6px 12px;
    font-size: 12px;
    border-bottom: 1px solid var(--c-border);
    flex-shrink: 0;
    white-space: pre-wrap;
  }
  .terminal-banner.show { display: block; }
  .terminal-banner.warn { background: rgba(229, 192, 123, 0.12); color: #e5c07b; }
  .terminal-banner.error { background: rgba(239, 89, 111, 0.12); color: #ef596f; }
  .terminal-banner.info { background: rgba(var(--c-accent-rgb), 0.12); color: var(--c-text-2); }
  .terminal-main { flex: 1; min-height: 0; display: flex; overflow: hidden; }
  .terminal-side {
    width: 280px;
    min-width: 220px;
    max-width: 520px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--c-border);
    background: var(--c-panel);
    min-height: 0;
  }
  .terminal-side-scroll { flex: 1; overflow: auto; padding: 6px; min-height: 0; }
  .terminal-section {
    font-size: 11px;
    color: var(--c-text-3);
    padding: 10px 6px 4px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .terminal-section-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 6px 4px;
  }
  .terminal-section-row .terminal-section { flex: 1; padding: 0; }
  .terminal-section-actions { display: flex; gap: 4px; }
  .terminal-btn-sm { padding: 2px 8px; font-size: 11px; }
  .terminal-item-close {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    line-height: 16px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--c-text-3);
    font-size: 14px;
    cursor: pointer;
  }
  .terminal-item-close:hover {
    color: #ef596f;
    border-color: var(--c-border);
    background: var(--c-overlay);
  }
  .terminal-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
    user-select: none;
  }
  .terminal-item:hover { background: var(--c-overlay); }
  .terminal-item.active { background: rgba(var(--c-accent-rgb), 0.18); }
  .terminal-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--c-text-4);
    flex-shrink: 0;
  }
  .terminal-dot.running { background: #98c379; box-shadow: 0 0 6px rgba(152, 195, 121, 0.7); }
  .terminal-item-name {
    font-size: 12px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .terminal-item-meta { font-size: 11px; color: var(--c-text-3); white-space: nowrap; }
  .terminal-empty { padding: 12px 8px; font-size: 12px; color: var(--c-text-3); }
  .terminal-right { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .terminal-status {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--c-border-soft);
    font-size: 12px;
    color: var(--c-text-2);
    flex-shrink: 0;
    min-height: 28px;
  }
  .terminal-status .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .terminal-status .running { color: #98c379; }
  .terminal-status .failed { color: #ef596f; }
  .terminal-out {
    flex: 1;
    margin: 0;
    overflow: auto;
    padding: 10px 12px;
    background: var(--c-bg-deep);
    color: var(--c-text);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    min-height: 0;
  }
  .terminal-placeholder {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--c-text-3);
    font-size: 13px;
    padding: 24px;
    text-align: center;
  }
  .terminal-pty {
    flex: 1;
    min-height: 0;
    display: none;
    background: var(--c-bg-deep);
    overflow: hidden;
  }
  .terminal-pty-instance { width: 100%; height: 100%; }
  .terminal-pty-instance .xterm { height: 100%; padding: 8px 10px; box-sizing: border-box; }
  .terminal-kind {
    flex-shrink: 0;
    font-size: 10px;
    line-height: 16px;
    padding: 0 6px;
    border-radius: 4px;
    color: var(--c-text-2);
    background: var(--c-overlay);
  }
  .terminal-kind.ssh { color: #98c379; background: rgba(152, 195, 121, 0.12); }
  .terminal-modal-mask {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(0, 0, 0, 0.55);
    align-items: center;
    justify-content: center;
  }
  .terminal-modal-mask.show { display: flex; }
  .terminal-modal {
    width: 380px;
    max-width: calc(100vw - 32px);
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 10px;
    padding: 16px;
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  }
  .terminal-modal-title { font-size: 14px; font-weight: 600; color: var(--c-text-hi); margin-bottom: 12px; }
  .terminal-modal-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  .terminal-modal-label { font-size: 11px; color: var(--c-text-3); }
  .terminal-modal-field select,
  .terminal-modal-field input {
    background: var(--c-bg-deep);
    color: var(--c-text);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    padding: 7px 9px;
    font-size: 12px;
    outline: none;
  }
  .terminal-modal-error { color: #ef596f; font-size: 12px; min-height: 18px; margin-bottom: 6px; }
  .terminal-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
<div class="terminal-view">
  <div class="terminal-head">
    <span class="terminal-title" data-i18n="终端">终端</span>
    <select class="terminal-select" data-ref="workdir" title="工作区"></select>
    <button class="terminal-btn" data-ref="create" data-i18n="新建终端">新建终端</button>
    <span class="terminal-head-hint" data-ref="ssh-target-hint"></span>
  </div>
  <div class="terminal-banner" data-ref="banner"></div>
  <div class="terminal-main">
    <div class="terminal-side">
      <div class="terminal-side-scroll" data-ref="side"></div>
    </div>
    <div class="terminal-right">
      <div class="terminal-status">
        <span data-ref="status-name"></span>
        <span class="grow" data-ref="status-cwd"></span>
        <span class="terminal-item-meta" data-ref="status-target"></span>
        <span data-ref="status-state"></span>
        <button class="terminal-btn" data-ref="attach" data-i18n="接管控制">接管控制</button>
        <button class="terminal-btn" data-ref="reconnect" data-i18n="重连">重连</button>
        <button class="terminal-btn" data-ref="kill-job" data-i18n="终止">终止</button>
      </div>
      <pre class="terminal-out" data-ref="output"></pre>
      <div class="terminal-pty" data-ref="pty"></div>
    </div>
  </div>
</div>
<div class="terminal-modal-mask" data-ref="modal">
  <div class="terminal-modal">
    <div class="terminal-modal-title" data-i18n="新建终端">新建终端</div>
    <div class="terminal-modal-field">
      <span class="terminal-modal-label" data-i18n="目标机">目标机</span>
      <select data-ref="modal-target"></select>
    </div>
    <div class="terminal-modal-field">
      <span class="terminal-modal-label" data-i18n="名称">名称</span>
      <input data-ref="modal-name" type="text" maxlength="80" />
    </div>
    <div class="terminal-modal-error" data-ref="modal-error"></div>
    <div class="terminal-modal-actions">
      <button class="terminal-btn" data-ref="modal-cancel" data-i18n="取消">取消</button>
      <button class="terminal-btn" data-ref="modal-create" data-i18n="连接">连接</button>
    </div>
  </div>
</div>
`;
