// 模型管理视图（hash 路由 #/models）：云端模型（provider）列表 + 添加/修改/删除。
// 原「云端模型管理」从 Agent 设置弹窗迁出——管理的是服务端全局配置，和单个会话/设置无关。
// 数据源与 Agent 页共享 store.js 的 S：所有增删改都走 Rust list/add/update/delete_cloud_provider
// （服务端 POST /v1/settings），成功后必须刷新 S.providers，否则本页列表会停在旧快照
// （表现为「提示添加成功，但列表里看不到」）。
import { t as _t } from "../i18n.js";
import { S, invoke } from "./agent/store.js";
import { parseContextSize, escapeHtml, $input, slugifyProviderKey } from "./agent/utils.js";
import { updateModelDropdown, switchModel, refreshServerProviders, firstCloudModelKey, updateModelBtn } from "./agent/model.js";
import { renderVisionModelSelect } from "./agent/settings_dialog.js";

const state = {
  // 非 null 表示添加弹窗处于「修改」模式，值为正在编辑的 provider key
  editingKey: null,
  // 模型ID 候选请求的序号：迟到的旧响应按序号丢弃
  modelIdSeq: 0,
  lastModelsSig: "",
  // 保存成功后延迟关窗的定时器 id（切页/重新打开弹窗时必须取消）
  closeTimer: null,
};

const template = `
<style>
  /* 样式隔离：全部选择器限定在 #models-app 内，全局 reset 由 index.html 壳层提供 */
  #models-app {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--c-bg);
  }

  .models-header {
    flex-shrink: 0;
    padding: 20px 20px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .models-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--c-text-hi);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .models-title::before {
    content: "";
    display: inline-block;
    width: 4px;
    height: 18px;
    background: var(--c-accent);
    border-radius: 2px;
  }

  .models-hint {
    font-size: 12px;
    color: var(--c-text-3);
  }

  .models-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 20px 20px;
  }

  .models-section-title {
    font-size: 12px;
    color: var(--c-text-3);
    margin: 6px 0 8px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .models-card {
    background: var(--c-bg-deep);
    border: 1px solid var(--c-border);
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 8px;
  }

  .models-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 4px;
  }

  .models-card-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--c-text);
    word-break: break-all;
  }

  .models-card-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .models-action-btn {
    background: rgba(255,255,255,0.08);
    border: none;
    color: var(--c-text-2);
    padding: 3px 10px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
  }
  .models-action-btn:hover { background: rgba(255,255,255,0.15); }
  .models-action-btn.danger:hover { background: #3d1a1a; color: #ff6b6b; }

  .models-card-detail {
    font-size: 11px;
    color: var(--c-text-3);
    word-break: break-all;
  }

  .models-empty {
    color: var(--c-text-4);
    font-size: 12px;
    padding: 12px 0;
  }

  .models-add-btn {
    width: 100%;
    background: rgba(var(--c-accent-rgb), 0.1);
    border: 1px dashed var(--c-accent);
    color: var(--c-accent);
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    text-align: center;
    margin-top: 4px;
  }
  .models-add-btn:hover { background: rgba(var(--c-accent-rgb), 0.2); }

  .models-notice {
    font-size: 12px;
    line-height: 18px;
    min-height: 18px;
    margin-top: 10px;
    color: var(--c-text-3);
  }
  .models-notice.error { color: #ef4444; }
  .models-notice.ok { color: #22c55e; }

  .models-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 9100;
    justify-content: center;
    align-items: center;
  }
  .models-overlay.show { display: flex; }

  .models-modal {
    width: 460px;
    max-width: calc(100vw - 40px);
    max-height: calc(100vh - 40px);
    display: flex;
    flex-direction: column;
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 10px;
    overflow: hidden;
  }

  .models-dialog-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 16px;
    border-bottom: 1px solid var(--c-border-soft);
    font-size: 14px;
    font-weight: 600;
    color: var(--c-text-hi);
    flex-shrink: 0;
  }

  .models-close {
    background: transparent;
    border: none;
    color: var(--c-text-3);
    font-size: 14px;
    cursor: pointer;
  }
  .models-close:hover { color: var(--c-text); }

  .models-dialog-body {
    padding: 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .models-input {
    width: 100%;
    box-sizing: border-box;
    background: var(--c-bg-deep);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    color: var(--c-text);
    font-size: 13px;
    padding: 8px 10px;
    outline: none;
  }
  .models-input:focus { border-color: var(--c-accent); }

  .models-fetch-msg {
    font-size: 12px;
    line-height: 16px;
    min-height: 16px;
    color: var(--c-text-2);
  }

  .models-key-hint {
    font-size: 12px;
    line-height: 16px;
    min-height: 16px;
    color: var(--c-text-2);
  }

  .models-checkbox {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--c-text-2);
    cursor: pointer;
    user-select: none;
  }

  .models-note {
    font-size: 12px;
    color: var(--c-text-4);
    line-height: 16px;
  }

  .models-dialog-msg {
    font-size: 12px;
    line-height: 18px;
    min-height: 18px;
  }

  .models-dialog-actions {
    display: flex;
    gap: 8px;
  }

  .models-btn {
    background: var(--c-overlay-strong);
    border: 1px solid var(--c-border);
    color: var(--c-text);
    padding: 7px 16px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
  }
  .models-btn:hover { background: var(--c-overlay); }
  .models-btn-primary {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: #fff;
  }
  .models-btn-primary:hover { filter: brightness(1.1); }

  .models-confirm-text {
    font-size: 13px;
    color: var(--c-text);
    line-height: 1.6;
    margin-bottom: 16px;
    word-break: break-word;
  }
</style>

<div id="models-app">
  <div class="models-header">
    <div class="models-title">${_t("模型管理")}</div>
    <div class="models-hint">${_t("云端模型写入服务端配置，Agent 的所有会话共享；新增/修改/删除即时生效，无需重启服务端")}</div>
  </div>
  <div class="models-body">
    <div class="models-section-title"><span>${_t("云端模型")}</span></div>
    <div id="models-list"></div>
    <button id="models-add-btn" class="models-add-btn">+ ${_t("添加云端模型")}</button>
    <div id="models-notice" class="models-notice"></div>
  </div>

  <!-- 添加/修改弹窗（标题与提交按钮文案按模式切换） -->
  <div class="models-overlay" id="models-dialog">
    <div class="models-modal">
      <div class="models-dialog-header">
        <span id="models-dialog-title">${_t("添加云端模型")}</span>
        <button class="models-close" id="models-close">✕</button>
      </div>
      <div class="models-dialog-body">
        <input type="text" class="models-input" id="models-baseurl" placeholder="${_t("API Base URL (如 https://api.example.com/v1)")}">
        <input type="text" class="models-input" id="models-apikey" placeholder="API Key">
        <input type="text" class="models-input" id="models-modelid" list="models-modelid-options" placeholder="${_t("模型ID (如 Big Pickle, 可下拉选择或手动填写)")}">
        <datalist id="models-modelid-options"></datalist>
        <div class="models-fetch-msg" id="models-fetch-msg"></div>
        <input type="text" class="models-input" id="models-name" placeholder="${_t("模型名称 (可选, 默认使用模型ID)")}">
        <div class="models-key-hint" id="models-key-hint"></div>
        <input type="text" class="models-input" id="models-ctx" placeholder="${_t("上下文大小 (如 256K, 1M)")}">
        <label class="models-checkbox">
          <input type="checkbox" id="models-images" style="cursor:pointer;"> ${_t("多模态模型（支持图片识别）")}
        </label>
        <div class="models-note">${_t("云端模型一律按支持思考写入；如需关闭，请在工具栏把推理强度设为「关闭」")}</div>
        <div class="models-dialog-msg" id="models-dialog-msg"></div>
        <div class="models-dialog-actions">
          <button class="models-btn models-btn-primary" id="models-submit">${_t("添加")}</button>
        </div>
      </div>
    </div>
  </div>
</div>
`;

// ===== 小工具 =====
// 把 token 数格式化成上下文输入框接受的写法（与 parseContextSize 互逆）
function formatCtxInput(n) {
  if (!n) return "";
  if (n % 1000000 === 0) return (n / 1000000) + "M";
  if (n % 1000 === 0) return (n / 1000) + "K";
  return String(n);
}

function notice(text, level) {
  var el = document.getElementById("models-notice");
  if (!el) return;
  el.className = "models-notice" + (level === "error" ? " error" : level === "ok" ? " ok" : "");
  el.textContent = text || "";
}

function dialogMsg(text, isError) {
  var el = document.getElementById("models-dialog-msg");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = isError ? "#ef4444" : "#22c55e";
}

// ===== 列表渲染 =====
function renderList() {
  var container = document.getElementById("models-list");
  if (!container) return;
  var providers = Array.isArray(S.providers) ? S.providers : [];
  container.innerHTML = "";
  if (providers.length === 0) {
    container.innerHTML = '<div class="models-empty">' + _t("暂无云端模型") + '</div>';
    return;
  }
  providers.forEach(function(p) {
    var card = document.createElement("div");
    card.className = "models-card";
    card.innerHTML =
      '<div class="models-card-header">' +
        '<span class="models-card-name">' + escapeHtml(p.name || p.key) + '</span>' +
        '<div class="models-card-actions">' +
          '<button class="models-action-btn edit">' + _t("修改") + '</button>' +
          '<button class="models-action-btn danger delete">' + _t("删除") + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="models-card-detail">' + escapeHtml(p.base_url || "") + ' · ' +
        escapeHtml(p.model_id || "") + ' · ' + _t("上下文: ") + escapeHtml(String(p.context_window || _t("默认"))) +
        (p.supports_images ? ' · ' + _t("支持图片") : '') +
        (p.can_reason ? ' · ' + _t("思考模式") : '') +
      '</div>';
    card.querySelector(".edit").addEventListener("click", function() { openEditDialog(p); });
    card.querySelector(".delete").addEventListener("click", function() {
      confirmDialog(_t("确定删除云端模型「") + (p.name || p.key) + _t("」？"), function() {
        deleteProvider(p);
      });
    });
    container.appendChild(card);
  });
}

// 视图内确认弹窗：agent/ui.js 的 showConfirm 挂在 .agent-root（切到其它 TAB 时被隐藏），
// 不能复用；这里自建一个挂在本视图内的遮罩。
function confirmDialog(message, onOk) {
  var host = document.getElementById("models-app");
  if (!host) return;
  var overlay = document.createElement("div");
  overlay.className = "models-overlay show";
  overlay.innerHTML =
    '<div class="models-modal" style="width:340px;">' +
      '<div class="models-dialog-header"><span>' + _t("确认操作") + '</span></div>' +
      '<div class="models-dialog-body">' +
        '<div class="models-confirm-text"></div>' +
        '<div class="models-dialog-actions">' +
          '<button class="models-btn" data-act="cancel">' + _t("取消") + '</button>' +
          '<button class="models-btn models-btn-primary" data-act="ok">' + _t("确定") + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  overlay.querySelector(".models-confirm-text").textContent = message;
  function close() { overlay.remove(); }
  overlay.querySelector('[data-act="cancel"]').addEventListener("click", close);
  overlay.querySelector('[data-act="ok"]').addEventListener("click", function() {
    close();
    if (onOk) onOk();
  });
  overlay.addEventListener("click", function(e) { if (e.target === overlay) close(); });
  host.appendChild(overlay);
}

// ===== 添加/修改弹窗 =====
function setDialogMode(isEdit) {
  var title = document.getElementById("models-dialog-title");
  var submit = document.getElementById("models-submit");
  if (title) title.textContent = isEdit ? _t("修改云端模型") : _t("添加云端模型");
  if (submit) submit.textContent = isEdit ? _t("保存") : _t("添加");
}

function updateProviderKeyHint() {
  var el = document.getElementById("models-key-hint");
  if (!el) return;
  // 修改模式：键是既有的，不随名称变化（update_cloud_provider 按原键替换）
  if (state.editingKey !== null) {
    el.textContent = _t("配置键（不随名称改变）：") + state.editingKey;
    el.style.color = "";
    return;
  }
  var name = $input("models-name").value.trim() || $input("models-modelid").value.trim();
  if (!name) {
    el.textContent = "";
    return;
  }
  var key = slugifyProviderKey(name);
  var clash = (Array.isArray(S.providers) ? S.providers : []).some(function(p) { return p && p.key === key; });
  if (clash) {
    el.textContent = _t("名称与已有模型重复，配置键：") + key;
    el.style.color = "#ef4444";
  } else {
    el.textContent = _t("配置键：") + key;
    el.style.color = "";
  }
}

function clearForm() {
  $input("models-baseurl").value = "";
  $input("models-apikey").value = "";
  $input("models-apikey").placeholder = "API Key";
  $input("models-modelid").value = "";
  $input("models-name").value = "";
  $input("models-ctx").value = "";
  $input("models-images").checked = false;
  dialogMsg("");
  clearModelIdOptions();
  updateProviderKeyHint();
}

// ===== 模型ID 候选（OpenAI 兼容 /models，走 Rust 避开 WebView 的 CORS） =====
function clearModelIdOptions() {
  state.modelIdSeq++;
  var dl = document.getElementById("models-modelid-options");
  if (dl) dl.innerHTML = "";
  state.lastModelsSig = "";
  var msgEl = document.getElementById("models-fetch-msg");
  if (msgEl) { msgEl.textContent = ""; msgEl.style.color = ""; }
}

function fetchModelsMsg(text, color) {
  var el = document.getElementById("models-fetch-msg");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = color || "";
}

function probeModels(base, key) {
  return invoke("probe_models_endpoint", { baseUrl: base, apiKey: key || "" });
}

async function fetchModelIds() {
  var base = $input("models-baseurl").value.trim().replace(/\/+$/, "");
  var key = $input("models-apikey").value.trim();
  var dl = document.getElementById("models-modelid-options");
  if (!dl) return;
  if (!base) { clearModelIdOptions(); return; }
  var sig = base + "|" + key;
  if (sig === state.lastModelsSig) return;
  state.lastModelsSig = sig;
  var seq = ++state.modelIdSeq;
  fetchModelsMsg(_t("正在获取模型列表…"), "var(--c-text-2)");
  try {
    var ids = await probeModels(base, key);
    if (seq !== state.modelIdSeq) return; // 已有更新的请求，丢弃旧响应
    dl.innerHTML = "";
    (ids || []).forEach(function(id) {
      if (!id) return;
      var o = document.createElement("option");
      o.value = String(id);
      dl.appendChild(o);
    });
    if (dl.children.length > 0) {
      fetchModelsMsg(_t("已获取 ") + dl.children.length + _t(" 个候选模型，点击模型ID输入框可下拉选择"), "var(--c-text-2)");
    } else {
      fetchModelsMsg(_t("接口返回成功但没有解析到模型，可能不是 OpenAI 兼容格式，请手动填写"), "#f59e0b");
    }
  } catch (e) {
    if (seq !== state.modelIdSeq) return;
    dl.innerHTML = "";
    state.lastModelsSig = "";
    fetchModelsMsg(_t("获取模型列表失败 ") + e + _t("，请检查 Base URL / Key，仍可手动填写模型ID"), "#ef4444");
  }
}

function openAddDialog() {
  // 清掉上一次保存成功后尚未触发的关窗定时器，避免它把这次新弹窗关掉
  cancelCloseTimer();
  // 从修改模式切回添加模式时清空回填的旧值，避免误把旧模型参数当新模型提交
  if (state.editingKey !== null) {
    state.editingKey = null;
    clearForm();
  }
  setDialogMode(false);
  document.getElementById("models-dialog").classList.add("show");
  fetchModelIds();
}

function openEditDialog(p) {
  cancelCloseTimer();
  state.editingKey = p.key;
  $input("models-modelid").value = p.model_id || "";
  $input("models-name").value = p.name || "";
  $input("models-baseurl").value = p.base_url || "";
  $input("models-apikey").value = "";
  // 服务端只回传掩码，永不回传明文 key：留空表示保留已保存的 key。
  $input("models-apikey").placeholder = p.has_key ? _t("已保存，留空则不修改") : "API Key";
  $input("models-ctx").value = formatCtxInput(p.context_window);
  $input("models-images").checked = !!p.supports_images;
  dialogMsg("");
  updateProviderKeyHint();
  setDialogMode(true);
  document.getElementById("models-dialog").classList.add("show");
  fetchModelIds();
}

function closeDialog() {
  var el = document.getElementById("models-dialog");
  if (el) el.classList.remove("show");
}

// 保存成功后的延迟关窗：必须能取消——视图切走时路由会清空 #view-root，
// 旧回调再执行会关掉/清空用户重新打开的弹窗，且 clearForm 里的 $input 已为 null。
function cancelCloseTimer() {
  if (state.closeTimer !== null) {
    clearTimeout(state.closeTimer);
    state.closeTimer = null;
  }
}

function scheduleDialogClose(resetEdit) {
  cancelCloseTimer();
  state.closeTimer = setTimeout(function() {
    state.closeTimer = null;
    closeDialog();
    if (resetEdit) state.editingKey = null;
    clearForm();
  }, 800);
}

// ===== 增删改 =====
async function refreshProviderState() {
  S.providers = await invoke("list_cloud_providers");
  // 有运行中的 workspace 时顺带刷新 /providers 快照，模型下拉与本列表保持一致
  if (S.serverInfo && S.serverInfo.workspace_id) {
    await refreshServerProviders();
  }
  renderVisionModelSelect();
  renderList();
  updateModelDropdown();
}

async function deleteProvider(p) {
  try {
    await invoke("delete_cloud_provider", { key: p.key });
    delete S.pendingProviderKeys[p.key];
    await refreshProviderState();
    // 删的正是当前激活的 provider：立即切到剩余的第一个云端模型，避免 active model
    // 悬空导致 /agent/update 报 "active model provider not configured"
    var active = S.settings.agent_default_provider || "";
    if (active === p.key || active.indexOf(p.key + "/") === 0) {
      var fallback = firstCloudModelKey();
      if (fallback) {
        await switchModel(fallback.key, fallback.name, fallback.context_window);
      } else {
        S.settings.agent_default_provider = "";
        updateModelBtn();
      }
    }
    notice(_t("已删除云端模型：") + (p.name || p.key), "ok");
  } catch (e) {
    notice(_t("删除失败: ") + e, "error");
  }
}

async function submitModel() {
  var modelId = $input("models-modelid").value.trim();
  var name = $input("models-name").value.trim() || modelId;
  var baseUrl = $input("models-baseurl").value.trim();
  var apiKey = $input("models-apikey").value.trim();
  var ctx = parseContextSize($input("models-ctx").value) || 256000;
  var supportsImages = $input("models-images").checked;

  var editing = state.editingKey !== null;
  if (!modelId || !baseUrl || (!apiKey && !editing)) {
    dialogMsg(_t("请填写模型ID、API地址和密钥"), true);
    return;
  }

  // 提交前校验 API 地址与密钥：请求 {base}/models，不通过则阻止写入（新增/修改均校验）。
  // 修改时留空 key 无法探测，直接跳过（服务端会保留原 key）。
  if (apiKey) {
    dialogMsg(_t("正在校验 API 地址与密钥…"), false);
    try {
      await probeModels(baseUrl.replace(/\/+$/, ""), apiKey);
    } catch (verifyErr) {
      dialogMsg(_t("校验失败，API 地址或密钥不正确：") + verifyErr, true);
      return;
    }
    dialogMsg(_t("校验通过，正在保存…"), false);
  }

  // 新增时先查键冲突：slug 后同名的两个名称会指向同一个键，后加的静默覆盖先加的
  if (!editing) {
    var derivedKey = slugifyProviderKey(name);
    var clash = (Array.isArray(S.providers) ? S.providers : []).some(function(p) { return p && p.key === derivedKey; });
    if (clash) {
      dialogMsg(_t("名称与已有模型重复，配置键：") + derivedKey +
        _t("（同名会被覆盖），请改用其它名称或先删除已有条目"), true);
      return;
    }
  }

  try {
    if (editing) {
      var key = state.editingKey;
      await invoke("update_cloud_provider", {
        key: key,
        input: { name: name, base_url: baseUrl, api_key: apiKey, context_window: ctx, model_id: modelId, supports_images: supportsImages, can_reason: true }
      });
      await refreshProviderState();
      // 改的正是当前激活的 provider：重新切换一次，让新 model id / 上下文窗口立即应用
      var active = S.settings.agent_default_provider || "";
      if (active === key || active.indexOf(key + "/") === 0) {
        await switchModel(key, name, ctx);
      }
      dialogMsg(_t("修改成功"), false);
      scheduleDialogClose(true);
      return;
    }

    var addResp = await invoke("add_cloud_provider", {
      input: { name: name, base_url: baseUrl, api_key: apiKey, context_window: ctx, model_id: modelId, supports_images: supportsImages, can_reason: true }
    });
    await refreshProviderState();
    // 有 workspace 时确认 /providers 快照已包含新 key；没连过 Agent 页则只确认配置已落盘
    var hasRuntime = !!(S.serverInfo && S.serverInfo.workspace_id);
    var runtimeConfirmed = !hasRuntime || S.serverProviders.some(function(sp) {
      return sp && sp.id === addResp.key;
    });
    if (!runtimeConfirmed && addResp && addResp.key) S.pendingProviderKeys[addResp.key] = true;
    if (runtimeConfirmed) {
      dialogMsg(_t("添加成功"), false);
    } else {
      dialogMsg(_t("配置已保存到服务端，但当前服务未加载该模型；重启 Agent 后生效"), true);
      return;
    }
    scheduleDialogClose(false);
  } catch (e) {
    dialogMsg((editing ? _t("修改失败: ") : _t("添加失败: ")) + e, true);
  }
}

// ===== 数据加载 =====
async function loadProviders() {
  notice("");
  // 本视图可能先于 Agent 页打开：S.settings 尚未由 agent init 填充（初始为 null），
  // 而删除回退切换/多模态下拉都会读它，这里先补一份
  if (!S.settings) {
    try {
      S.settings = (await invoke("load_settings")) || {};
    } catch (_) {
      S.settings = {};
    }
  }
  try {
    // 本视图可能在 Agent 页建链之前打开：先把保存的连接串应用进全局 target
    try { await invoke("ensure_server_target"); } catch (_) {}
    S.providers = await invoke("list_cloud_providers");
    renderList();
    updateProviderKeyHint();
  } catch (e) {
    S.providers = [];
    renderList();
    notice(_t("读取云端模型列表失败: ") + e, "error");
  }
}

export default {
  template,
  mount(root) {
    root.innerHTML = template;

    var app = document.getElementById("models-app");
    if (app) app.addEventListener("contextmenu", function(e) { e.preventDefault(); });

    document.getElementById("models-add-btn").addEventListener("click", openAddDialog);
    document.getElementById("models-close").addEventListener("click", closeDialog);
    document.getElementById("models-submit").addEventListener("click", submitModel);
    // 名称/模型ID 输入时同步展示派生出的 providers 键（同名冲突标红，避免静默覆盖）
    ["models-name", "models-modelid"].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("input", updateProviderKeyHint);
    });
    // baseurl/apikey 变化时拉取 /models 候选列表（datalist）
    ["models-baseurl", "models-apikey"].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", fetchModelIds);
    });

    loadProviders();
  },
  unmount() {
    cancelCloseTimer();
    closeDialog();
  },
};
