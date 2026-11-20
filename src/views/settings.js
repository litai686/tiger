// @ts-nocheck -- 历史视图暂未类型化（jsconfig checkJs 全局开启，新代码请勿加此标记）
import { t as _t, setLanguage, getLanguage } from "../i18n.js";
import { friendlyError } from "./agent/error.js";
const template = `
<style>
  /* 样式隔离约定：选择器限定在本视图容器内（id/class 带 settings- 前缀），
     全局 reset（*）与 body 样式由 index.html 壳层统一提供，视图内不得重复定义 */

  #settings-app { display: flex; flex-direction: column; height: 100%; }

  #settings-header {
    display: flex;
    align-items: center;
    padding: 10px 16px;
    background: var(--c-panel-2);
    border-bottom: 1px solid var(--c-border-soft);
    flex-shrink: 0;
    gap: 12px;
  }

  .back-btn {
    background: var(--c-overlay);
    border: none;
    color: var(--c-text);
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    transition: background 0.2s;
  }
  .back-btn:hover { background: var(--c-overlay-strong); }

  #settings-header .title { font-size: 16px; font-weight: 600; color: var(--c-text-hi); }

  #settings-layout { display: flex; flex: 1; overflow: hidden; }

  #settings-nav {
    width: 180px;
    background: var(--c-panel);
    border-right: 1px solid var(--c-border-soft);
    padding: 12px 0;
    flex-shrink: 0;
    overflow-y: auto;
  }

  .nav-item {
    padding: 10px 20px;
    cursor: pointer;
    font-size: 14px;
    color: var(--c-text-2);
    transition: all 0.2s;
    border-left: 3px solid transparent;
  }
  .nav-item:hover { background: rgba(var(--c-accent-rgb), 0.08); color: var(--c-text); }
  .nav-item.active {
    background: rgba(var(--c-accent-rgb), 0.12);
    color: var(--c-accent);
    border-left-color: var(--c-accent);
    font-weight: 500;
  }

  #settings-content { flex: 1; overflow-y: auto; padding: 20px 24px; }

  .panel { display: none; }
  .panel.active { display: block; }

  .panel-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--c-text-hi);
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .panel-title::before {
    content: "";
    display: inline-block;
    width: 4px;
    height: 16px;
    background: var(--c-accent);
    border-radius: 2px;
  }

  .param-group { margin-bottom: 24px; }

  .param-group-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--c-accent);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--c-border);
  }

  .param-row { display: flex; align-items: center; margin-bottom: 10px; gap: 12px; }

  .param-label { width: 160px; font-size: 13px; color: var(--c-text-2); flex-shrink: 0; }
  .param-label .param-key { font-size: 11px; color: var(--c-text-4); margin-top: 2px; }

  .param-input { flex: 1; max-width: 300px; }
  .param-input input, .param-input select {
    width: 100%;
    padding: 7px 12px;
    background: var(--c-panel-2);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    color: var(--c-text);
    font-size: 13px;
    outline: none;
    transition: border-color 0.2s;
  }
  .param-input input:focus, .param-input select:focus { border-color: var(--c-accent); }
  .param-input select { cursor: pointer; }
  .param-input select option { background: var(--c-panel-2); color: var(--c-text); }
  .param-input .checkbox-wrap { display: flex; align-items: center; gap: 8px; }
  .param-input input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--c-accent); }

  .param-desc { font-size: 11px; color: var(--c-text-4); margin-top: 2px; }

  /* ===== 主题卡片 ===== */
  .theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; max-width: 660px; }
  .theme-card {
    border: 2px solid var(--c-border);
    border-radius: 10px;
    padding: 10px;
    cursor: pointer;
    background: var(--c-panel);
    transition: border-color 0.2s, transform 0.1s;
  }
  .theme-card:hover { border-color: var(--c-accent); transform: translateY(-2px); }
  .theme-card.active { border-color: var(--c-accent); box-shadow: 0 0 0 1px var(--c-accent); }
  .theme-card .theme-preview { display: flex; height: 46px; border-radius: 6px; overflow: hidden; border: 1px solid var(--c-border-soft); }
  .theme-card .theme-preview span { flex: 1; }
  .theme-card .theme-name { font-size: 13px; color: var(--c-text); margin-top: 8px; display: flex; align-items: center; gap: 6px; }
  .theme-card .theme-check { color: var(--c-accent); font-weight: 700; visibility: hidden; }
  .theme-card.active .theme-check { visibility: visible; }

  .version-table { width: 100%; max-width: 500px; }
  .version-table tr { border-bottom: 1px solid var(--c-border-soft); }
  .version-table td { padding: 12px 0; font-size: 14px; }
  .version-table td:first-child { color: var(--c-text-2); width: 140px; }
  .version-table td:last-child { color: var(--c-text); font-weight: 500; }

  .about-content { max-width: 500px; }
  .about-content h3 { font-size: 20px; color: var(--c-text-hi); margin-bottom: 8px; }
  .about-content .about-subtitle { font-size: 13px; color: var(--c-accent); margin-bottom: 20px; }
  .about-content p { font-size: 14px; color: var(--c-text-2); line-height: 1.8; margin-bottom: 12px; }
  .about-content a { color: var(--c-accent); text-decoration: none; }
  .about-content a:hover { text-decoration: underline; }

  .save-toast {
    position: fixed;
    top: 20px;
    right: 20px;
    background: #2e7d32;
    color: #fff;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 13px;
    z-index: 1000;
    animation: slideIn 0.3s ease;
  }

  .error-toast {
    position: fixed;
    top: 20px;
    right: 20px;
    background: #c62828;
    color: #fff;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 13px;
    z-index: 1000;
    animation: slideIn 0.3s ease;
  }

  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  /* 服务端配置引导 / 检测结果 */
  .server-guide-block { margin-bottom: 16px; padding: 12px 14px; background: var(--c-panel-2); border: 1px solid var(--c-border); border-radius: 8px; }
  .server-guide-title { font-size: 13px; font-weight: 600; color: var(--c-text); margin-bottom: 8px; }
  .server-guide { margin: 0; padding-left: 20px; font-size: 12px; color: var(--c-text-3); line-height: 1.9; }
  .server-guide li { margin-bottom: 2px; }
  .server-guide code { font-family: Consolas, Monaco, monospace; font-size: 12px; color: var(--c-text); background: var(--c-overlay); padding: 1px 5px; border-radius: 4px; word-break: break-all; }
  .server-health-line { white-space: pre-line; line-height: 1.8; font-size: 12px; word-break: break-all; }
</style>
<div id="settings-app">
  <div id="settings-header">
    <button class="back-btn" id="back-btn">&#8592; ${_t("返回")}</button>
    <span class="title">${_t("设置")}</span>
  </div>
  <div id="settings-layout">
    <nav id="settings-nav">
      <div class="nav-item active" data-panel="appearance" id="nav-appearance">${_t("外观主题")}</div>
      <div class="nav-item" data-panel="proxy" id="nav-proxy">${_t("网络代理")}</div>
      <div class="nav-item" data-panel="server" id="nav-server">${_t("服务端连接")}</div>
      <div class="nav-item" data-panel="version" id="nav-version">${_t("系统版本号")}</div>
      <div class="nav-item" data-panel="about" id="nav-about">${_t("关于")}</div>
    </nav>
    <div id="settings-content">
      <div id="panel-appearance" class="panel active">
        <div class="panel-title">${_t("外观主题")}</div>
        <div class="param-group">
          <div class="param-group-title">${_t("语言 / Language")}</div>
          <div class="param-row">
            <div class="param-label">${_t("界面语言")}<div class="param-key">language</div></div>
            <div class="param-input">
              <select id="ui-lang-select">
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
              <div class="param-desc">${_t("切换后立即生效")}</div>
            </div>
          </div>
          <div class="param-group-title">${_t("主题配色")}</div>
          <div class="param-desc" style="margin-bottom:14px;">${_t("选择界面配色，风格参考主流 VS Code 主题，点击即可一键切换（立即生效）")}</div>
          <div id="theme-grid" class="theme-grid"></div>
        </div>
      </div>

      <div id="panel-proxy" class="panel">
        <div class="panel-title">${_t("网络代理")}</div>
        <div class="param-group">
          <div class="param-group-title">${_t("代理设置")}</div>
          <div class="param-row">
                        <div class="param-label">${_t("启用代理")}<div class="param-key">agent_proxy.enabled</div></div>
            <div class="param-input">
              <div class="checkbox-wrap"><input type="checkbox" id="proxy_enabled"><span>${_t("为服务端的 Agent 请求启用代理")}</span></div>
              <div class="param-desc">${_t("代理在服务端主机上生效，作用于 Agent 的 LLM 请求与网络工具；桌面端下载/更新不走代理")}</div>
            </div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("代理地址")}<div class="param-key">agent_proxy.url</div></div>
            <div class="param-input">
              <input type="text" id="proxy_url" placeholder="http://127.0.0.1:7890" style="max-width:400px;">
              <div class="param-desc">${_t("支持 http / https / socks5 协议，如 http://127.0.0.1:7890；地址以服务端主机为准（127.0.0.1 = 服务端本机）")}</div>
            </div>
          </div>
        </div>
      </div>

      <div id="panel-server" class="panel">
        <div class="panel-title">${_t("服务端连接")}</div>
        <div class="param-group">
          <div class="param-group-title">${_t("连接检测")}</div>
          <div class="param-row">
            <div class="param-label">${_t("当前状态")}</div>
            <div class="param-input" style="max-width:none;">
              <span id="server-health" style="font-size:13px;color:var(--c-text-2);">${_t("尚未检测")}</span>
              <div class="param-desc server-health-line" id="server-health-detail" style="margin-top:6px;"></div>
            </div>
          </div>
          <div class="param-row">
            <div class="param-label"></div>
            <div class="param-input" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;max-width:none;">
              <button id="server-check-btn" style="background:var(--c-accent);color:#fff;border:none;padding:8px 20px;border-radius:8px;font-size:13px;cursor:pointer;">${_t("检测服务端")}</button>
              <span class="param-desc" style="margin-top:0;">${_t("检查连接串完整性 → TLS 指纹校验 → /v1/health → 带 token 的接口")}</span>
            </div>
          </div>
        </div>
        <div class="param-group" id="server-migrate-group" style="display:none;">
          <div class="param-group-title">${_t("旧配置迁移")}</div>
          <div class="param-desc" style="margin-bottom:12px;" id="server-migrate-desc"></div>
          <div class="param-row">
            <div class="param-label"></div>
            <div class="param-input" style="max-width:none;">
              <button id="server-migrate-btn" style="background:var(--c-accent);color:#fff;border:none;padding:8px 20px;border-radius:8px;font-size:13px;cursor:pointer;">${_t("导入本机旧配置到服务端")}</button>
              <div class="param-desc" style="margin-top:8px;">${_t("导入内容：provider（含密钥）、MCP、代理、多模态模型、工具开关。工作目录不迁移（本机路径与服务端通常不同）。导入后本机文件只读保留，便于回滚。")}</div>
            </div>
          </div>
        </div>
        <div class="param-group">
          <div class="param-group-title">${_t("配置引导")}</div>
          <div class="param-desc" style="margin-bottom:12px;">${_t("服务端由你自行启动并长期运行；桌面端只负责连接（TCP + TLS 1.3），不会自动拉起或结束任何服务端进程。按下面顺序配置：")}</div>
          <div class="server-guide-block">
            <div class="server-guide-title">${_t("① 在服务端机器启动服务")}</div>
            <ol class="server-guide">
              <li>${_t("启动服务：")} <code>tigerAgent --host tcp://0.0.0.0:18471</code>${_t("（仅本机使用可绑 127.0.0.1），端口按需修改")}</li>
              <li>${_t("保持该进程常驻（systemd / 计划任务 / tmux 等）：桌面端不会自动拉起，也不会随桌面端退出而停止")}</li>
              <li>${_t("复制启动日志里的连接串，或执行 ")}<code>tigerAgent --print-connection</code>${_t(" 重新打印（含地址、服务端指纹与 token）")}</li>
              <li>${_t("管理 token / 查看客户端连接：浏览器打开服务端 ")}<code>https://&lt;服务端地址&gt;/admin/</code>${_t("（用指纹 + 任一 token 登录）")}</li>
            </ol>
          </div>
          <div class="server-guide-block">
            <div class="server-guide-title">${_t("② 在桌面端粘贴连接串")}</div>
            <ol class="server-guide">
              <li>${_t("把整条连接串粘贴到下方输入框，不需要分别填写地址、指纹和 token")}</li>
              <li>${_t("点「保存并应用」：保存后自动检测连通性，成功会立即刷新底部服务端状态栏")}</li>
              <li>${_t("失败时按提示排查：服务端是否在跑、端口/防火墙、指纹是否一致、token 是否最新（服务端执行 --rotate-token 后旧连接串失效）")}</li>
            </ol>
          </div>
        </div>
        <div class="param-group" id="server-remote-group">
          <div class="param-group-title">${_t("服务端参数")}</div>
          <div class="param-row">
            <div class="param-label">${_t("连接串")}<div class="param-key">server.remote.connection</div></div>
            <div class="param-input" style="max-width:none;">
              <textarea id="server-connection" rows="3" style="width:100%;max-width:680px;font-family:monospace;font-size:12px;" placeholder="tigerAgent://192.168.1.20:18471?fp=sha256:...&amp;token=...&#10;tigerAgent://8000-xxx.preview.example.com?fp=sha256:...&amp;token=..."></textarea>
              <div class="param-desc">${_t("服务端启动时打印的完整连接串：地址、服务端指纹（防中间人）与 token（身份凭据）三部分都在这一条串里；端口可省略，默认 443（域名 / 反向代理部署）。反向代理终止 TLS 时按公共根证书校验代理证书，指纹只用于直连")}</div>
            </div>
          </div>
          <div class="param-row">
            <div class="param-label"></div>
            <div class="param-input" style="display:flex;gap:10px;flex-wrap:wrap;max-width:none;">
              <button id="server-save-btn" style="background:var(--c-accent);color:#fff;border:none;padding:8px 20px;border-radius:8px;font-size:13px;cursor:pointer;">${_t("保存并应用")}</button>
            </div>
          </div>
          <div class="param-desc" id="server-status" style="margin-top:6px;"></div>
          <div class="param-desc">${_t("保存并应用会先写入连接串，再自动检测连通性（TLS 指纹 + 健康检查）；成功会立即刷新底部服务端状态栏（CPU / 内存 / 硬盘）")}</div>
        </div>
      </div>

      <div id="panel-version" class="panel">
        <div class="panel-title">${_t("系统版本号")}</div>
        <table class="version-table">
          <tr><td>${_t("Tiger 版本")}</td><td id="v-tiger">${_t("检测中...")} <span id="update-badge" style="display:none;color:#4caf50;font-size:12px;margin-left:6px;">${_t("✓ 最新")}</span></td></tr>
          <tr>
            <td style="padding-top:20px;" colspan="2">
              <button class="btn-save" id="check-update-btn" style="margin-top:0;font-size:13px;padding:8px 20px;">${_t("检查新版本")}</button>
              <span id="update-status" style="font-size:12px;color:var(--c-text-3);margin-left:12px;"></span>
            </td>
          </tr>
          <tr><td>${_t("Tauri 版本")}</td><td id="v-tauri">${_t("检测中...")}</td></tr>
          <tr><td>${_t("Agent 版本")}</td><td id="v-agent">${_t("检测中...")}</td></tr>
          <tr><td>${_t("操作系统")}</td><td id="v-os">${_t("检测中...")}</td></tr>
        </table>
      </div>

      <div id="panel-about" class="panel">
        <div class="panel-title">${_t("关于")}</div>
        <div class="about-content">
          <h3>Tiger</h3>
          <div class="about-subtitle">Tiger Agent</div>
          <p>${_t("Tiger 是一个面向智能体（Agent）工作流的桌面客户端，内置 Agent，接入云端模型即可完成编码与自动化任务。")}</p>
          <p>${_t("如需定制服务 联系方式：微信: litai686")}</p>
          <p>${_t("项目官网：")}<a href="https://adm.tuduoduo.top/" target="_blank">https://adm.tuduoduo.top/</a></p>
        </div>
      </div>
    </div>
  </div>
</div>

`;

const invoke = () => window.__agent_invoke;

// HTML 转义：远端 update.json 下发的版本号 / 地址会拼进弹窗 innerHTML，需真实转义防注入
function escHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function switchPanel(panelId) {
  console.log("[settings] 切换面板:", panelId);
  document.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((el) => el.classList.remove("active"));
  document.querySelector('[data-panel="' + panelId + '"]').classList.add("active");
  document.getElementById("panel-" + panelId).classList.add("active");
}

function showToast(message, isError) {
  const existing = document.querySelector(".save-toast, .error-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = isError ? "error-toast" : "save-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

async function saveProxy() {
  const proxy = {
    enabled: document.getElementById("proxy_enabled").checked,
    url: document.getElementById("proxy_url").value.trim(),
  };
  if (proxy.enabled) {
    if (!proxy.url) {
      showToast(_t("启用代理时请填写代理地址"), true);
      return;
    }
    if (!/^(https?|socks5):\/\//i.test(proxy.url)) {
      showToast(_t("代理地址需以 http://、https:// 或 socks5:// 开头"), true);
      return;
    }
  }
  try {
    let s = await invoke()("load_settings");
    s.agent_proxy = proxy;
    await invoke()("save_settings", { settings: s });
    // 代理必须落到服务端主机上：远程部署时本机文件对服务端不可见。
    // 这里显式等待服务端确认，失败直接把原因显示给用户（不再静默）。
    await invoke()("apply_server_settings", { patch: { agent_proxy: proxy } });
    showToast(_t("代理已应用到服务端"));
  } catch (e) {
    console.error("[settings] 保存代理设置失败:", e);
    showToast(friendlyError(e, { prefix: "保存失败: " }), true);
  }
}

function setupProxyPanel() {
  var ids = ["proxy_enabled", "proxy_url"];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el) el.addEventListener("change", saveProxy);
  }
}

// ===== 服务端连接（TCP + TLS，docs/tcp-tls-ecdsa.md §11）=====
// 桌面端不再有本地/远程之分：服务端由用户自行启动，这里只维护一条连接串
// （地址 + 服务端指纹 + token）。

async function loadServerConnection() {
  try {
    const info = await invoke()("get_server_connection");
    const el = document.getElementById("server-connection");
    if (el) el.value = info.connection || "";
    const status = document.getElementById("server-status");
    if (status) {
      status.textContent = info.error || "";
      status.style.color = info.error ? "#d32f2f" : "var(--c-text-3)";
    }
  } catch (e) {
    console.error("[settings] 加载服务端连接失败:", e);
  }
}

async function saveServerConnection() {
  const connection = document.getElementById("server-connection").value.trim();
  const status = document.getElementById("server-status");
  const btn = document.getElementById("server-save-btn");
  if (btn) { btn.disabled = true; btn.textContent = _t("检测中…"); }
  try {
    await invoke()("set_server_connection", { connection });
    // 保存成功后立刻验证连通性：成功提示「保存成功」并刷新底部服务端状态栏；
    // 失败只提示「连接失败」，详细原因由 runServerCheck 写进上方「连接检测」区域。
    const healthy = await runServerCheck();
    if (status) {
      status.textContent = healthy ? "" : _t("连接失败，请检查连接串与服务端状态（详细原因见上方「连接检测」）");
      status.style.color = healthy ? "var(--c-text-3)" : "#ef5350";
    }
    if (healthy) {
      showToast(_t("保存成功"));
      if (window.Agent && window.Agent.refreshSystemInfo) window.Agent.refreshSystemInfo();
    } else {
      showToast(_t("连接失败"), true);
    }
  } catch (e) {
    console.error("[settings] 保存服务端连接失败:", e);
    showToast(friendlyError(e, { prefix: "保存失败: " }), true);
    if (status) { status.textContent = errText(e); status.style.color = "#ef5350"; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = _t("保存并应用"); }
  }
}

// 连接串里包含 token，检测结果只展示地址和指纹前缀，绝不回显 token
function connectionSummary(raw) {
  const s = (raw || "").trim();
  const m = s.match(/^tigerAgent:\/\/([^?]+)\?(.*)$/);
  if (!m) return s;
  let fp = "";
  m[2].split("&").forEach(function (pair) {
    const kv = pair.split("=");
    if (kv[0] === "fp") fp = kv.slice(1).join("=");
  });
  return m[1] + (fp ? "（指纹 " + fp.slice(0, 16) + "…）" : "");
}

// 原始错误文本：检测结果要给用户可排查的细节（地址、TLS 报文、路径），
// 不做友好化改写，否则「连不上」和「指纹不匹配」会变得无法区分
function errText(e) {
  if (e == null) return "";
  if (typeof e === "string") return e;
  return e.message || String(e);
}

// 逐项检测：连接串完整性 → TLS 指纹校验 → 带 token 的接口。
// 与启动时的自检（index.html 的 checkServerOnStartup）用同一组命令，
// 区别是这里不轮询（用户手动点，服务端要么在跑要么没跑），并输出逐行结果。
async function runServerCheck() {
  const statusEl = document.getElementById("server-health");
  const detailEl = document.getElementById("server-health-detail");
  const lines = [];
  const push = (ok, text) => lines.push((ok ? "✅ " : "❌ ") + text);
  if (statusEl) { statusEl.textContent = _t("检测中…"); statusEl.style.color = "var(--c-text-3)"; }
  if (detailEl) { detailEl.textContent = ""; detailEl.style.color = "var(--c-text-3)"; }
  const started = Date.now();

  let configured = false;
  try {
    const conn = await invoke()("get_server_connection");
    if (conn.error) {
      push(false, _t("连接串不完整：") + conn.error);
    } else {
      configured = true;
      push(true, _t("服务端地址：") + connectionSummary(conn.connection));
    }
  } catch (e) {
    push(false, _t("读取服务端配置失败：") + errText(e));
  }

  let healthy = false;
  if (configured) {
    if (statusEl) statusEl.textContent = _t("检测中…（健康检查）");
    try {
      const msg = await invoke()("test_server_connection");
      healthy = true;
      push(true, _t("健康检查通过：") + msg);
    } catch (e) {
      push(false, _t("健康检查失败：") + errText(e));
      push(false, _t("请确认服务端已启动（tigerAgent --host tcp://0.0.0.0:<端口>）、地址/端口可达；直连需指纹与 token 与当前服务端一致，经反向代理需代理证书受公共根证书信任"));
    }
  }

  lines.push(_t("耗时 ") + (Date.now() - started) + " ms");
  if (detailEl) {
    detailEl.textContent = lines.join("\n");
    detailEl.style.color = healthy ? "var(--c-text-2)" : "#ef5350";
  }
  if (statusEl) {
    statusEl.textContent = healthy ? _t("服务端正常") : _t("服务端异常，请检查配置");
    statusEl.style.color = healthy ? "#4caf50" : "#ef5350";
  }
  return healthy;
}

function setupServerPanel() {
  var saveBtn = document.getElementById("server-save-btn");
  if (saveBtn) saveBtn.addEventListener("click", saveServerConnection);
  var migrateBtn = document.getElementById("server-migrate-btn");
  if (migrateBtn) migrateBtn.addEventListener("click", importLocalConfig);
  // 「检测服务端」仍可手动重新检测（保存并应用已内置同一套检测）
  var checkBtn = document.getElementById("server-check-btn");
  if (checkBtn) checkBtn.addEventListener("click", runServerCheck);
  refreshMigrationNotice();
}

// 旧配置迁移提示：本机仍留着改造前写的 tigerAgent.json 时展示导入入口。
async function refreshMigrationNotice() {
  const group = document.getElementById("server-migrate-group");
  const desc = document.getElementById("server-migrate-desc");
  if (!group || !desc) return;
  try {
    const diff = await invoke()("local_agent_config_diff");
    if (!diff || !diff.available) {
      group.style.display = "none";
      return;
    }
    const parts = [];
    if (diff.providers) parts.push(_t("provider ") + diff.providers + _t(" 个"));
    if (diff.mcp) parts.push("MCP " + diff.mcp + _t(" 个"));
    if (diff.agent_proxy) parts.push(_t("网络代理"));
    if (diff.agent_vision_model) parts.push(_t("多模态模型"));
    if (diff.options) parts.push(_t("工具开关"));
    desc.textContent = _t("检测到本机仍保存着旧版 Agent 配置：") + parts.join(_t("、")) +
      _t("。远程部署下这些配置对服务端无效，建议导入到服务端。");
    group.style.display = "";
  } catch (e) {
    group.style.display = "none";
  }
}

async function importLocalConfig() {
  try {
    await invoke()("import_local_agent_config");
    showToast(_t("旧配置已导入服务端"));
    refreshMigrationNotice();
  } catch (e) {
    console.error("[settings] 导入旧配置失败:", e);
    showToast(friendlyError(e, { prefix: _t("导入失败: ") }), true);
  }
}

async function loadVersionInfo() {
  try {
    const tigerVersion = await invoke()("get_app_version");
    document.getElementById("v-tiger").innerHTML = tigerVersion + ' <span id="update-badge" style="display:none;color:#4caf50;font-size:12px;margin-left:6px;">' + _t("✓ 最新") + '</span>';
    // 后台静默下载已就绪时给出可升级提示（用户此前选了「稍后再说」也能在这里手动触发）
    const pending = window.Agent && window.Agent.getAppUpdate ? window.Agent.getAppUpdate() : null;
    if (pending && pending.status === "ready") {
      const statusEl = document.getElementById("update-status");
      if (statusEl) {
        statusEl.textContent = _t("发现新版本 v") + pending.version + _t("（已下载，可升级）");
        statusEl.style.color = "#ff9800";
      }
    }
  } catch (e) {
    document.getElementById("v-tiger").textContent = _t("未知");
  }
  try {
    const tauriVersion = await invoke()("get_tauri_version");
    document.getElementById("v-tauri").textContent = tauriVersion || _t("未知");
  } catch (e) {
    document.getElementById("v-tauri").textContent = _t("未知");
  }
  try {
    // 服务端版本只能向远端查询（GET /v1/version）：桌面端不再管理本地服务进程
    const serverVersion = await invoke()("get_server_version");
    document.getElementById("v-agent").textContent = serverVersion || _t("未连接");
  } catch (e) {
    document.getElementById("v-agent").textContent = _t("未连接");
  }
  const platform = navigator.platform || navigator.userAgent;
  let osName = _t("未知");
  if (platform.includes("Win")) osName = "Windows";
  else if (platform.includes("Mac")) osName = "macOS";
  else if (platform.includes("Linux")) osName = "Linux";
  document.getElementById("v-os").textContent = osName;
}

async function checkUpdateNow() {
  const statusEl = document.getElementById("update-status");
  const badgeEl = document.getElementById("update-badge");
  statusEl.textContent = _t("检查中...");
  badgeEl.style.display = "none";
  try {
    const result = await invoke()("check_update");
    if (result.has_update) {
      statusEl.textContent = _t("发现新版本 v") + result.remote_version;
      statusEl.style.color = "#ff9800";
      if (result.download_url && window.Agent && window.Agent.startAppUpdate) {
        // 与启动时的静默更新走同一条链路：后台下载（此处展示进度）→ 下载完成后提示升级
        window.Agent.startAppUpdate(result, { manual: true });
      } else {
        // 平台未提供安装包地址（update.json 无对应平台字段）：只提示版本
        // 升级日志按钮复用壳层实现：地址只记在模块变量里，不拼进 onclick
        const changelogBtn = (window.Agent && window.Agent.changelogButton && result.changelog_url)
          ? window.Agent.changelogButton(result.changelog_url)
          : "";
        window.Agent.showUpdateDialog(`
          <div class="update-icon" style="font-size:40px;text-align:center;margin-bottom:12px;">📥</div>
          <div class="update-title" style="font-size:20px;font-weight:600;color:#fff;text-align:center;margin-bottom:8px;">${_t("发现新版本")}</div>
          <div class="update-desc" style="font-size:14px;color:var(--c-text-2);text-align:center;margin-bottom:20px;line-height:1.6;">${_t("有新版本可用，是否前往下载？")}</div>
          <div class="update-info-row" style="display:flex;justify-content:center;gap:24px;margin-bottom:20px;font-size:13px;">
            <div class="info-item" style="text-align:center;"><div class="info-label" style="color:var(--c-text-3);font-size:11px;">${_t("当前版本")}</div><div class="info-value" style="color:var(--c-text);font-weight:500;margin-top:2px;">v${escHtml(result.current_version)}</div></div>
            <div class="info-item" style="text-align:center;"><div class="info-label" style="color:var(--c-text-3);font-size:11px;">${_t("最新版本")}</div><div class="info-value" style="color:var(--c-text);font-weight:500;margin-top:2px;">v${escHtml(result.remote_version)}</div></div>
          </div>
          <div class="update-buttons" style="display:flex;gap:12px;justify-content:center;">
            ${changelogBtn}
            <button class="update-btn-secondary" style="background:var(--c-overlay);color:var(--c-text);border:none;padding:10px 28px;border-radius:8px;font-size:14px;cursor:pointer;" onclick="window.Agent.hideUpdateDialog()">${_t("稍后再说")}</button>
          </div>`);
      }
    } else {
      statusEl.textContent = _t("已是最新版本");
      statusEl.style.color = "#4caf50";
      badgeEl.style.display = "inline";
    }
  } catch (e) {
    statusEl.textContent = _t("检查失败: ") + e;
    statusEl.style.color = "#f44336";
  }
  setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = "var(--c-text-3)"; }, 5000);
}

function goBack() { location.hash = "#/agent"; }

// ===== 外观主题 =====

function renderThemeGrid() {
  const grid = document.getElementById("theme-grid");
  if (!grid) return;
  const themes = window.__AGENT_THEMES || [];
  const current = (typeof window.getTheme === "function" ? window.getTheme() : "default");
  grid.innerHTML = themes.map(function (t) {
    const active = t.id === current ? " active" : "";
    const sw = (t.colors || []).map(function (c) {
      return '<span style="background:' + escHtml(c) + ';"></span>';
    }).join("");
    return '<div class="theme-card' + active + '" data-theme-id="' + escHtml(t.id) + '">' +
             '<div class="theme-preview">' + sw + '</div>' +
             '<div class="theme-name"><span class="theme-check">\u2714</span>' + escHtml(_t(t.name)) + '</div>' +
           '</div>';
  }).join("");
  grid.querySelectorAll(".theme-card").forEach(function (card) {
    card.addEventListener("click", function () {
      const id = card.dataset.themeId;
      if (typeof window.applyTheme === "function") window.applyTheme(id);
      grid.querySelectorAll(".theme-card").forEach(function (c) { c.classList.remove("active"); });
      card.classList.add("active");
      showToast(_t("已切换主题"));
    });
  });
}

export default {
  template,
  mount(root, params) {
    console.log("[settings] mount()");
    root.innerHTML = template;

    // 禁用页面右键（屏蔽浏览器默认菜单）
    ["settings-app"].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("contextmenu", function(e) { e.preventDefault(); });
    });

    document.getElementById("back-btn").addEventListener("click", goBack);
    document.querySelectorAll(".nav-item").forEach(function(el) {
      el.addEventListener("click", function() { switchPanel(el.dataset.panel); });
    });
    // 路由参数 ?panel=xxx：启动自检弹窗「去配置服务端」直接落到「服务端连接」面板
    const initialPanel = (params && params.panel && document.getElementById("panel-" + params.panel))
      ? params.panel
      : "appearance";
    switchPanel(initialPanel);
    document.getElementById("check-update-btn").addEventListener("click", checkUpdateNow);

    // 语言切换：保存到 Settings.language + localStorage，并立即重建当前视图生效
    const langSelect = document.getElementById("ui-lang-select");
    if (langSelect) {
      langSelect.value = getLanguage();
      langSelect.addEventListener("change", async function () {
        const lang = this.value;
        try {
          let current = {};
          try { current = await invoke()("load_settings"); } catch (_) {}
          await invoke()("save_settings", Object.assign({}, current, { language: lang }));
        } catch (_) {}
        setLanguage(lang);
        location.reload();
      });
    }

    setupProxyPanel();
    setupServerPanel();
    renderThemeGrid();

    (async function() {
      try {
        const settings = await invoke()("load_settings");
        console.log("[settings] 加载设置成功, keys:", Object.keys(settings));
        // 代理设置回填
        const proxy = settings.agent_proxy || {};
        document.getElementById("proxy_enabled").checked = !!proxy.enabled;
        document.getElementById("proxy_url").value = proxy.url || "";
      } catch (e) {
        console.error("加载设置失败:", e);
      }
      loadServerConnection();
      loadVersionInfo();
      // 从启动自检弹窗进来时自动跑一次检测，用户不用多点一步
      if (initialPanel === "server") runServerCheck();
    })();
  },
  unmount() {
    console.log("[settings] unmount()");
  }
};
