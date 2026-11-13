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

  .btn-danger {
    background: #d32f2f;
    color: #fff;
    border: none;
    padding: 3px 12px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.2s;
    vertical-align: middle;
  }
  .btn-danger:hover { background: #b71c1c; }

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

  .confirm-overlay {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 9999;
    justify-content: center;
    align-items: center;
  }
  .confirm-overlay.show { display: flex; }
  .confirm-dialog {
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 12px;
    padding: 28px 32px;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    text-align: center;
  }
  .confirm-dialog .confirm-title { font-size: 18px; font-weight: 600; color: var(--c-text-hi); margin-bottom: 12px; }
  .confirm-dialog .confirm-message { font-size: 14px; color: var(--c-text-2); line-height: 1.6; margin-bottom: 24px; white-space: pre-line; }
  .confirm-dialog .confirm-buttons { display: flex; gap: 12px; justify-content: center; }
  .confirm-dialog .btn-confirm { background: #d32f2f; color: #fff; border: none; padding: 8px 28px; border-radius: 8px; font-size: 14px; cursor: pointer; transition: background 0.2s; }
  .confirm-dialog .btn-confirm:hover { background: #b71c1c; }
  .confirm-dialog .btn-cancel { background: var(--c-overlay); color: var(--c-text); border: none; padding: 8px 28px; border-radius: 8px; font-size: 14px; cursor: pointer; transition: background 0.2s; }
  .confirm-dialog .btn-cancel:hover { background: var(--c-overlay-strong); }
</style>
<div id="settings-app">
  <div id="settings-header">
    <button class="back-btn" id="back-btn">&#8592; ${_t("返回")}</button>
    <span class="title">${_t("设置")}</span>
  </div>
  <div id="settings-layout">
    <nav id="settings-nav">
      <div class="nav-item active" data-panel="appearance" id="nav-appearance">${_t("外观主题")}</div>
      <div class="nav-item" data-panel="wxbot" id="nav-wxbot">${_t("微信 Bot")}</div>
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

      <div id="panel-wxbot" class="panel">
        <div class="panel-title">${_t("微信 Bot（iLink）")}</div>

        <div class="param-group">
          <div class="param-group-title">${_t("绑定状态")}</div>
          <div class="param-row">
            <div class="param-label">${_t("状态")}</div>
            <div class="param-input"><span id="wxbot-state" style="font-size:13px;color:var(--c-text-2);">${_t("加载中…")}</span></div>
          </div>
          <div class="param-row">
            <div class="param-label">Bot ID</div>
            <div class="param-input"><span id="wxbot-botid" style="font-size:13px;color:var(--c-text-2);">-</span></div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("主人微信")}</div>
            <div class="param-input">
              <span id="wxbot-owner" style="font-size:13px;color:var(--c-text-2);">-</span>
              <div class="param-desc">${_t("首个给 Bot 发消息的微信号自动成为主人，其余人消息忽略")}</div>
            </div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("消息统计")}</div>
            <div class="param-input"><span id="wxbot-stats" style="font-size:13px;color:var(--c-text-2);">${_t("收 ")}0 ${_t(" / 发 ")}0</span></div>
          </div>
          <div class="param-row">
            <div class="param-label"></div>
            <div class="param-input" style="display:flex;gap:10px;max-width:none;">
              <button id="wxbot-bind-btn" style="background:var(--c-accent);color:#fff;border:none;padding:8px 20px;border-radius:8px;font-size:13px;cursor:pointer;">${_t("绑定微信")}</button>
              <button id="wxbot-toggle-btn" style="display:none;background:var(--c-overlay);color:var(--c-text);border:none;padding:8px 20px;border-radius:8px;font-size:13px;cursor:pointer;">${_t("暂停")}</button>
              <button id="wxbot-unbind-btn" class="btn-danger" style="display:none;padding:8px 20px;border-radius:8px;font-size:13px;">${_t("解绑")}</button>
            </div>
          </div>
        </div>

        <div class="param-group">
          <div class="param-group-title">${_t("Bot 行为")}</div>
          <div class="param-row">
            <div class="param-label">${_t("工作目录")}</div>
            <div class="param-input"><span style="font-size:13px;color:var(--c-text-2);">${_t("跟随 Agent 页工作目录")}</span><div class="param-desc">${_t("微信 Bot 与 Agent 页使用同一工作目录，在 Agent 页修改")}</div></div>
          </div>
        </div>

        <div class="param-group">
          <div class="param-group-title">${_t("最近活动")}</div>
          <div id="wxbot-activity" style="font-size:12px;color:var(--c-text-3);line-height:1.8;max-height:200px;overflow-y:auto;background:var(--c-panel-2);border:1px solid var(--c-border);border-radius:6px;padding:10px 12px;">${_t("暂无活动")}</div>
        </div>
      </div>

      <div id="panel-proxy" class="panel">
        <div class="panel-title">${_t("网络代理")}</div>
        <div class="param-group">
          <div class="param-group-title">${_t("代理设置")}</div>
          <div class="param-row">
            <div class="param-label">${_t("启用代理")}<div class="param-key">agent_proxy.enabled</div></div>
            <div class="param-input">
              <div class="checkbox-wrap"><input type="checkbox" id="proxy_enabled"><span>${_t("为 admAgent 的 LLM 请求启用代理")}</span></div>
              <div class="param-desc">${_t("仅影响 admAgent 跟大模型交互的请求，桌面端下载等不走代理")}</div>
            </div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("代理地址")}<div class="param-key">agent_proxy.url</div></div>
            <div class="param-input">
              <input type="text" id="proxy_url" placeholder="http://127.0.0.1:7890" style="max-width:400px;">
              <div class="param-desc">${_t("支持 http / https / socks5 协议，如 http://127.0.0.1:7890")}</div>
            </div>
          </div>
        </div>
      </div>

      <div id="panel-server" class="panel">
        <div class="panel-title">${_t("服务端连接")}</div>
        <div class="param-group">
          <div class="param-group-title">${_t("连接模式")}</div>
          <div class="param-row">
            <div class="param-label">${_t("模式")}<div class="param-key">server.mode</div></div>
            <div class="param-input">
              <select id="server-mode" style="max-width:400px;">
                <option value="local">${_t("本地（同机，自动管理 admAgent 进程）")}</option>
                <option value="remote">${_t("远程（服务端在另一台机器，TLS 加密）")}</option>
              </select>
              <div class="param-desc" id="server-mode-desc">${_t("本地模式不启用 TLS：服务端与桌面端同机，靠操作系统权限隔离。修改后需重启应用生效。")}</div>
            </div>
          </div>
        </div>
        <div class="param-group" id="server-remote-group">
          <div class="param-group-title">${_t("远程服务端")}</div>
          <div class="param-row">
            <div class="param-label">${_t("服务端地址")}<div class="param-key">server.remote.addr</div></div>
            <div class="param-input">
              <input type="text" id="server-addr" placeholder="192.168.1.20:18471" style="max-width:400px;">
              <div class="param-desc">${_t("服务端启动时用 --host tcp://0.0.0.0:18471 监听，端口按实际填写")}</div>
            </div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("服务端指纹")}<div class="param-key">server.remote.fingerprint</div></div>
            <div class="param-input">
              <input type="text" id="server-fingerprint" placeholder="sha256:..." style="max-width:400px;">
              <div class="param-desc">${_t("必须带外获取：服务端启动日志、tigerAgent --print-fingerprint，或 tigerAgent pair --qr。未配对时无法通过首连探测拿到指纹。")}</div>
            </div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("SNI")}<div class="param-key">server.remote.sni</div></div>
            <div class="param-input">
              <input type="text" id="server-sni" placeholder="tigerAgent.local" style="max-width:400px;">
              <div class="param-desc">${_t("默认 tigerAgent.local，与服务端证书 SAN 一致；真正的身份校验靠上面的指纹")}</div>
            </div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("本设备指纹")}<div class="param-key">device.fingerprint</div></div>
            <div class="param-input">
              <span id="server-device-fp" style="font-size:12px;color:var(--c-text-2);word-break:break-all;">-</span>
              <div class="param-desc" id="server-device-desc">${_t("首次使用远程模式时生成；在服务端执行 tigerAgent pair --approve <指纹> --name <设备名> 完成配对")}</div>
            </div>
          </div>
          <div class="param-row">
            <div class="param-label"></div>
            <div class="param-input" style="display:flex;gap:10px;flex-wrap:wrap;max-width:none;">
              <button id="server-prepare-btn" style="background:var(--c-overlay);color:var(--c-text);border:none;padding:8px 20px;border-radius:8px;font-size:13px;cursor:pointer;">${_t("生成设备身份")}</button>
              <button id="server-test-btn" style="background:var(--c-overlay);color:var(--c-text);border:none;padding:8px 20px;border-radius:8px;font-size:13px;cursor:pointer;">${_t("测试连接")}</button>
              <button id="server-save-btn" style="background:var(--c-accent);color:#fff;border:none;padding:8px 20px;border-radius:8px;font-size:13px;cursor:pointer;">${_t("保存并应用")}</button>
            </div>
          </div>
          <div class="param-desc" id="server-status" style="margin-top:6px;"></div>
        </div>
      </div>

      <div id="panel-version" class="panel">
        <div class="panel-title">${_t("系统版本号")}</div>
        <table class="version-table">
          <tr><td>${_t("Tiger 版本")}</td><td id="v-adm">${_t("检测中...")} <span id="update-badge" style="display:none;color:#4caf50;font-size:12px;margin-left:6px;">${_t("✓ 最新")}</span></td></tr>
          <tr>
            <td style="padding-top:20px;" colspan="2">
              <button class="btn-save" id="check-update-btn" style="margin-top:0;font-size:13px;padding:8px 20px;">${_t("检查新版本")}</button>
              <span id="update-status" style="font-size:12px;color:var(--c-text-3);margin-left:12px;"></span>
            </td>
          </tr>
          <tr><td>${_t("Tauri 版本")}</td><td id="v-tauri">${_t("检测中...")}</td></tr>
          <tr><td>${_t("admAgent 版本")}</td><td id="v-admagent">${_t("检测中...")}</td></tr>
          <tr><td>${_t("操作系统")}</td><td id="v-os">${_t("检测中...")}</td></tr>
        </table>
      </div>

      <div id="panel-about" class="panel">
        <div class="panel-title">${_t("关于")}</div>
        <div class="about-content">
          <h3>Tiger</h3>
          <div class="about-subtitle">Tiger Agent</div>
          <p>${_t("Tiger 是一个面向智能体（Agent）工作流的桌面客户端，内置 admAgent，接入云端模型即可完成编码与自动化任务。")}</p>
          <p>${_t("如需定制服务 联系方式：微信: litai686")}</p>
          <p>${_t("项目官网：")}<a href="https://adm.tuduoduo.top/" target="_blank">https://adm.tuduoduo.top/</a></p>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="confirm-overlay" id="confirm-overlay">
  <div class="confirm-dialog">
    <div class="confirm-title" id="confirm-title">${_t("删除提示")}</div>
    <div class="confirm-message" id="confirm-message"></div>
    <div class="confirm-buttons">
      <button class="btn-cancel" id="confirm-cancel-btn">${_t("取消")}</button>
      <button class="btn-confirm" id="confirm-ok-btn">${_t("确定")}</button>
    </div>
  </div>
</div>

<div class="confirm-overlay" id="wxbot-qr-overlay">
  <div class="confirm-dialog">
    <div class="confirm-title">${_t("微信扫码绑定")}</div>
    <div id="wxbot-qr-box" style="display:flex;justify-content:center;align-items:center;min-height:220px;width:220px;background:#fff;border-radius:8px;margin:0 auto 16px;">
      <span style="color:#333;font-size:13px;">${_t("二维码加载中…")}</span>
    </div>
    <div class="confirm-message">${_t("使用微信「扫一扫」确认开启 Bot 功能")}</div>
    <div class="confirm-buttons">
      <button class="btn-cancel" id="wxbot-qr-cancel-btn">${_t("取消")}</button>
    </div>
  </div>
</div>

<div class="confirm-overlay" id="wxbot-code-overlay">
  <div class="confirm-dialog">
    <div class="confirm-title">${_t("输入配对码")}</div>
    <div class="confirm-message" id="wxbot-code-hint">${_t("请输入微信手机端显示的配对数字：")}</div>
    <input id="wxbot-code-input" type="text" inputmode="numeric" autocomplete="off" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid var(--c-overlay-strong);background:rgba(255,255,255,0.06);color:#fff;font-size:16px;letter-spacing:2px;text-align:center;margin-bottom:16px;">
    <div class="confirm-buttons">
      <button class="btn-cancel" id="wxbot-code-cancel-btn">${_t("取消")}</button>
      <button class="btn-confirm" id="wxbot-code-ok-btn">${_t("确定")}</button>
    </div>
  </div>
</div>
`;

const invoke = () => window.__adm_invoke;

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
    showToast(_t("代理设置已保存"));
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

// ===== 服务端连接（本地 / 远程，docs/tcp-tls-ed25519.md §11）=====

function refreshServerModeUI() {
  var modeEl = document.getElementById("server-mode");
  var group = document.getElementById("server-remote-group");
  var desc = document.getElementById("server-mode-desc");
  if (!modeEl || !group) return;
  var remote = modeEl.value === "remote";
  group.style.display = remote ? "" : "none";
  if (desc) {
    desc.textContent = remote
      ? _t("远程模式强制 TLS 1.3 + Ed25519 双向认证：工作目录、会话、附件与配置全部留在服务端，桌面端只是操作界面。修改后需重启应用生效。")
      : _t("本地模式不启用 TLS：服务端与桌面端同机，靠操作系统权限隔离。修改后需重启应用生效。");
  }
}

async function loadServerConnection() {
  try {
    const info = await invoke()("get_server_connection");
    const modeEl = document.getElementById("server-mode");
    if (modeEl) modeEl.value = info.mode === "remote" ? "remote" : "local";
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ""; };
    setVal("server-addr", info.addr);
    setVal("server-sni", info.sni || "tigerAgent.local");
    setVal("server-fingerprint", info.fingerprint);
    const fpEl = document.getElementById("server-device-fp");
    if (fpEl) fpEl.textContent = info.device_ready ? info.device_fingerprint : _t("尚未生成（点“生成设备身份”）");
    const status = document.getElementById("server-status");
    if (status) {
      status.textContent = info.error || "";
      status.style.color = info.error ? "#d32f2f" : "var(--c-text-3)";
    }
    refreshServerModeUI();
  } catch (e) {
    console.error("[settings] 加载服务端连接失败:", e);
  }
}

async function saveServerConnection() {
  const mode = document.getElementById("server-mode").value;
  const addr = document.getElementById("server-addr").value.trim();
  const sni = document.getElementById("server-sni").value.trim();
  const fingerprint = document.getElementById("server-fingerprint").value.trim();
  try {
    await invoke()("set_server_connection", { mode, addr, sni, fingerprint });
    showToast(_t("服务端连接已保存，重启应用后生效"));
    loadServerConnection();
  } catch (e) {
    console.error("[settings] 保存服务端连接失败:", e);
    showToast(friendlyError(e, { prefix: "保存失败: " }), true);
  }
}

async function prepareServerDeviceIdentity() {
  try {
    const fp = await invoke()("prepare_device_identity");
    const fpEl = document.getElementById("server-device-fp");
    if (fpEl) fpEl.textContent = fp;
    showToast(_t("设备身份已生成，请在服务端批准：") + " tigerAgent pair --approve " + fp);
  } catch (e) {
    console.error("[settings] 生成设备身份失败:", e);
    showToast(friendlyError(e, { prefix: "生成失败: " }), true);
  }
}

async function testServerConnection() {
  const status = document.getElementById("server-status");
  if (status) { status.textContent = _t("正在测试连接…"); status.style.color = "var(--c-text-3)"; }
  try {
    const msg = await invoke()("test_server_connection");
    if (status) { status.textContent = msg; status.style.color = "#4caf50"; }
  } catch (e) {
    const text = friendlyError(e, { prefix: "" });
    if (status) { status.textContent = text; status.style.color = "#d32f2f"; }
  }
}

function setupServerPanel() {
  var modeEl = document.getElementById("server-mode");
  if (modeEl) modeEl.addEventListener("change", refreshServerModeUI);
  var saveBtn = document.getElementById("server-save-btn");
  if (saveBtn) saveBtn.addEventListener("click", saveServerConnection);
  var prepareBtn = document.getElementById("server-prepare-btn");
  if (prepareBtn) prepareBtn.addEventListener("click", prepareServerDeviceIdentity);
  var testBtn = document.getElementById("server-test-btn");
  if (testBtn) testBtn.addEventListener("click", testServerConnection);
}

async function loadVersionInfo() {
  try {
    const admVersion = await invoke()("get_app_version");
    document.getElementById("v-adm").innerHTML = admVersion + ' <span id="update-badge" style="display:none;color:#4caf50;font-size:12px;margin-left:6px;">' + _t("✓ 最新") + '</span>';
    // 后台静默下载已就绪时给出可升级提示（用户此前选了「稍后再说」也能在这里手动触发）
    const pending = window.ADM && window.ADM.getAppUpdate ? window.ADM.getAppUpdate() : null;
    if (pending && pending.status === "ready") {
      const statusEl = document.getElementById("update-status");
      if (statusEl) {
        statusEl.textContent = _t("发现新版本 v") + pending.version + _t("（已下载，可升级）");
        statusEl.style.color = "#ff9800";
      }
    }
  } catch (e) {
    document.getElementById("v-adm").textContent = _t("未知");
  }
  try {
    const tauriVersion = await invoke()("get_tauri_version");
    document.getElementById("v-tauri").textContent = tauriVersion || _t("未知");
  } catch (e) {
    document.getElementById("v-tauri").textContent = _t("未知");
  }
  try {
    const agentVersion = await invoke()("get_adm_agent_version");
    document.getElementById("v-admagent").textContent = agentVersion || _t("未知");
  } catch (e) {
    document.getElementById("v-admagent").textContent = _t("未知");
  }
  const platform = navigator.platform || navigator.userAgent;
  let osName = _t("未知");
  if (platform.includes("Win")) osName = "Windows";
  else if (platform.includes("Mac")) osName = "macOS";
  else if (platform.includes("Linux")) osName = "Linux";
  document.getElementById("v-os").textContent = osName;
}

let _confirmResolve = null;

function showConfirmDialog(message, title) {
  const overlay = document.getElementById("confirm-overlay");
  document.getElementById("confirm-title").textContent = title || _t("删除提示");
  document.getElementById("confirm-message").textContent = message;
  overlay.classList.add("show");
  return new Promise((resolve) => { _confirmResolve = resolve; });
}

function closeConfirmDialog(result) {
  document.getElementById("confirm-overlay").classList.remove("show");
  if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
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
      if (result.download_url && window.ADM && window.ADM.startAppUpdate) {
        // 与启动时的静默更新走同一条链路：后台下载（此处展示进度）→ 下载完成后提示升级
        window.ADM.startAppUpdate(result, { manual: true });
      } else {
        // 平台未提供安装包地址（update.json 无对应平台字段）：只提示版本
        window.ADM.showUpdateDialog(`
          <div class="update-icon" style="font-size:40px;text-align:center;margin-bottom:12px;">📥</div>
          <div class="update-title" style="font-size:20px;font-weight:600;color:#fff;text-align:center;margin-bottom:8px;">${_t("发现新版本")}</div>
          <div class="update-desc" style="font-size:14px;color:var(--c-text-2);text-align:center;margin-bottom:20px;line-height:1.6;">${_t("有新版本可用，是否前往下载？")}</div>
          <div class="update-info-row" style="display:flex;justify-content:center;gap:24px;margin-bottom:20px;font-size:13px;">
            <div class="info-item" style="text-align:center;"><div class="info-label" style="color:var(--c-text-3);font-size:11px;">${_t("当前版本")}</div><div class="info-value" style="color:var(--c-text);font-weight:500;margin-top:2px;">v${escHtml(result.current_version)}</div></div>
            <div class="info-item" style="text-align:center;"><div class="info-label" style="color:var(--c-text-3);font-size:11px;">${_t("最新版本")}</div><div class="info-value" style="color:var(--c-text);font-weight:500;margin-top:2px;">v${escHtml(result.remote_version)}</div></div>
          </div>
          <div class="update-buttons" style="display:flex;gap:12px;justify-content:center;">
            <button class="update-btn-secondary" style="background:var(--c-overlay);color:var(--c-text);border:none;padding:10px 28px;border-radius:8px;font-size:14px;cursor:pointer;" onclick="window.ADM.hideUpdateDialog()">${_t("稍后再说")}</button>
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
  const themes = window.__ADM_THEMES || [];
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

// ===== 微信 Bot（iLink） =====

let wxbotUnlistens = [];
let wxbotActivities = [];

function renderWxbotStatus(s) {
  const stateEl = document.getElementById("wxbot-state");
  if (!stateEl) return;
  const map = {
    stopped: s.bound ? _t("已暂停") : _t("未绑定"),
    waiting_scan: _t("等待扫码…"),
    running: _t("运行中"),
    error: _t("错误"),
  };
  stateEl.textContent = (map[s.state] || s.state) + (s.error ? "：" + s.error : "");
  stateEl.style.color = s.state === "running" ? "#4caf50" : (s.state === "error" ? "#f44336" : "var(--c-text-2)");
  document.getElementById("wxbot-botid").textContent = s.bot_id || "-";
  document.getElementById("wxbot-owner").textContent = s.owner || "-";
  document.getElementById("wxbot-stats").textContent = _t("收 ") + (s.msg_in || 0) + _t(" / 发 ") + (s.msg_out || 0);
  const bindBtn = document.getElementById("wxbot-bind-btn");
  const toggleBtn = document.getElementById("wxbot-toggle-btn");
  const unbindBtn = document.getElementById("wxbot-unbind-btn");
  bindBtn.textContent = s.bound ? _t("重新扫码") : _t("绑定微信");
  toggleBtn.style.display = s.bound ? "" : "none";
  toggleBtn.textContent = s.state === "running" ? _t("暂停") : _t("启动");
  toggleBtn.dataset.running = s.state === "running" ? "1" : "0";
  unbindBtn.style.display = s.bound ? "" : "none";
}

async function refreshWxbotStatus() {
  try {
    const s = await invoke()("get_ilink_status");
    renderWxbotStatus(s);
  } catch (e) {
    console.error("[settings] 获取微信 Bot 状态失败:", e);
  }
}

function showWxbotQr(payload) {
  const overlay = document.getElementById("wxbot-qr-overlay");
  const box = document.getElementById("wxbot-qr-box");
  overlay.classList.add("show");
  const img = payload && payload.qrcode_img ? String(payload.qrcode_img) : "";
  const url = payload && payload.qrcode_url ? String(payload.qrcode_url) : "";
  if (img) {
    // qrcode_img_content 可能是 data URL / 图片地址 / 裸 base64
    const src = img.startsWith("data:") ? img : (img.startsWith("http") ? img : "data:image/png;base64," + img);
    box.innerHTML = '<img alt="二维码" style="width:200px;height:200px;" src="' + escHtml(src) + '">';
  } else if (url) {
    box.innerHTML = '<span style="color:#333;font-size:12px;word-break:break-all;padding:8px;">' + escHtml(url) + "</span>";
  } else {
    box.innerHTML = '<span style="color:#333;font-size:13px;">' + _t("二维码加载中…") + '</span>';
  }
}

function hideWxbotQr() {
  const overlay = document.getElementById("wxbot-qr-overlay");
  if (overlay) overlay.classList.remove("show");
}

function showWxbotCode(retry) {
  hideWxbotQr();
  const overlay = document.getElementById("wxbot-code-overlay");
  if (!overlay) return;
  const hint = document.getElementById("wxbot-code-hint");
  if (hint) hint.textContent = retry ? _t("配对码错误，请重新输入微信手机端显示的数字：") : _t("请输入微信手机端显示的配对数字：");
  const input = document.getElementById("wxbot-code-input");
  if (input) input.value = "";
  overlay.classList.add("show");
  if (input) setTimeout(function () { input.focus(); }, 50);
}

function hideWxbotCode() {
  const overlay = document.getElementById("wxbot-code-overlay");
  if (overlay) overlay.classList.remove("show");
}

async function submitWxbotCode() {
  const input = document.getElementById("wxbot-code-input");
  const code = input ? String(input.value || "").trim() : "";
  if (!code) {
    showToast(_t("请先输入配对码"), true);
    return;
  }
  try {
    await invoke()("submit_ilink_verify_code", { code: code });
    hideWxbotCode();
  } catch (e) {
    showToast(friendlyError(e, { prefix: "提交配对码失败: " }), true);
  }
}

function pushWxbotActivity(p) {
  wxbotActivities.unshift(p);
  if (wxbotActivities.length > 50) wxbotActivities.pop();
  const el = document.getElementById("wxbot-activity");
  if (!el) return;
  el.innerHTML = wxbotActivities.map(function (a) {
    const t = new Date(a.ts || Date.now());
    const hh = ("0" + t.getHours()).slice(-2) + ":" + ("0" + t.getMinutes()).slice(-2) + ":" + ("0" + t.getSeconds()).slice(-2);
    const dir = a.direction === "in" ? _t("⬅️ 收") : (a.direction === "out" ? _t("➡️ 发") : "⚠️");
    return "<div>[" + hh + "] " + dir + " " + escHtml(a.summary || "") + "</div>";
  }).join("");
}

async function setupWxbotPanel() {
  document.getElementById("wxbot-bind-btn").addEventListener("click", async function () {
    try {
      showWxbotQr(null);
      await invoke()("start_ilink_login");
    } catch (e) {
      hideWxbotQr();
      showToast(friendlyError(e, { prefix: "启动绑定失败: " }), true);
    }
  });
  document.getElementById("wxbot-qr-cancel-btn").addEventListener("click", async function () {
    hideWxbotQr();
    try { await invoke()("cancel_ilink_login"); } catch (_) {}
  });
  document.getElementById("wxbot-code-ok-btn").addEventListener("click", submitWxbotCode);
  document.getElementById("wxbot-code-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitWxbotCode();
  });
  document.getElementById("wxbot-code-cancel-btn").addEventListener("click", async function () {
    hideWxbotCode();
    try { await invoke()("cancel_ilink_login"); } catch (_) {}
  });
  document.getElementById("wxbot-toggle-btn").addEventListener("click", async function () {
    const running = this.dataset.running === "1";
    try {
      if (running) {
        await invoke()("stop_ilink_bridge");
        showToast(_t("微信 Bot 已暂停"));
      } else {
        await invoke()("start_ilink_bridge");
        showToast(_t("微信 Bot 已启动"));
      }
    } catch (e) {
      showToast(friendlyError(e, { prefix: "操作失败: " }), true);
    }
    refreshWxbotStatus();
  });
  document.getElementById("wxbot-unbind-btn").addEventListener("click", async function () {
    const ok = await showConfirmDialog(_t("确定要解绑微信 Bot 吗？\n解绑将删除登录凭据与会话映射，需重新扫码才能使用。"));
    if (!ok) return;
    try {
      await invoke()("unbind_ilink");
      showToast(_t("已解绑微信 Bot"));
    } catch (e) {
      showToast(friendlyError(e, { prefix: "解绑失败: " }), true);
    }
    refreshWxbotStatus();
  });

  // 事件订阅（unmount 时统一释放，防重复绑定）
  try {
    const un1 = await window.__adm_listen("ilink-status", function (ev) {
      const p = ev.payload || {};
      if (p.state === "waiting_scan") {
        showWxbotQr(p);
      } else if (p.state === "waiting_verify_code") {
        showWxbotCode(!!p.retry);
      } else {
        hideWxbotQr();
        hideWxbotCode();
        if (p.state === "running") showToast(_t("微信 Bot 已连接"));
        if (p.state === "error" && p.error) showToast(friendlyError(p.error, { prefix: "微信 Bot: " }), true);
      }
      refreshWxbotStatus();
    });
    wxbotUnlistens.push(un1);
    const un2 = await window.__adm_listen("ilink-activity", function (ev) {
      pushWxbotActivity(ev.payload || {});
    });
    wxbotUnlistens.push(un2);
  } catch (e) {
    console.error("[settings] 订阅微信 Bot 事件失败:", e);
  }
  refreshWxbotStatus();
}

export default {
  template,
  mount(root) {
    console.log("[settings] mount()");
    root.innerHTML = template;

    // 禁用页面右键（屏蔽浏览器默认菜单；#confirm-overlay / #wxbot-qr-overlay 是 #settings-app 的兄弟节点，需各自绑定）
    ["settings-app", "confirm-overlay", "wxbot-qr-overlay", "wxbot-code-overlay"].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("contextmenu", function(e) { e.preventDefault(); });
    });

    document.getElementById("back-btn").addEventListener("click", goBack);
    document.querySelectorAll(".nav-item").forEach(function(el) {
      el.addEventListener("click", function() { switchPanel(el.dataset.panel); });
    });
    document.getElementById("check-update-btn").addEventListener("click", checkUpdateNow);
    document.getElementById("confirm-cancel-btn").addEventListener("click", function() { closeConfirmDialog(false); });
    document.getElementById("confirm-ok-btn").addEventListener("click", function() { closeConfirmDialog(true); });

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
    setupWxbotPanel();
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
    })();
  },
  unmount() {
    console.log("[settings] unmount()");
    // 释放微信 Bot 事件监听，防止重复绑定泄漏
    wxbotUnlistens.forEach(function (un) {
      try { un(); } catch (_) {}
    });
    wxbotUnlistens = [];
    wxbotActivities = [];
  }
};
