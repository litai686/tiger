// 服务端日志查看 / 下载
//
// 服务端可能运行在另一台机器（TCP + TLS 远程部署），客户端本机没有
// tigerAgent.log：列表与内容都从服务端 API 取回（GET /v1/logs、
// GET /v1/logs/{name}，见 docs/server-api.md §1.11），下载由 Rust 端
// download_server_log 弹保存对话框落盘。
//
// 与客户端自己的 tigerAgent_debug.log 区分：那个是本机 Rust/前端调试日志，
// 这里看的是服务端进程的 slog 输出与 panic 转储。
import { t as _t } from "../../i18n.js";
import { invoke } from "./store.js";
import { reportError } from "./ui.js";
import { getErrorMessage } from "./error.js";
import { $input } from "./utils.js";

// 当前列表（fetch_server_logs 的 files），供下载取同名文件
var currentFiles = [];

export function initServerLogsUI() {
  var overlay = document.getElementById("agent-server-log-overlay");
  if (!overlay) return;

  document.getElementById("settings-open-server-logs").addEventListener("click", openServerLogs);
  document.getElementById("server-log-close").addEventListener("click", closeServerLogs);
  overlay.addEventListener("click", function(e) {
    if (e.target === overlay) closeServerLogs();
  });
  document.getElementById("server-log-refresh").addEventListener("click", function() {
    refreshServerLogFiles();
  });
  document.getElementById("server-log-download").addEventListener("click", downloadServerLog);
  // 换文件 / 换行数立即重新拉取，避免"看起来切了但内容没变"
  document.getElementById("server-log-file").addEventListener("change", loadServerLog);
  document.getElementById("server-log-tail").addEventListener("change", loadServerLog);
}

function openServerLogs() {
  document.getElementById("agent-server-log-overlay").classList.add("show");
  refreshServerLogFiles();
}

function closeServerLogs() {
  document.getElementById("agent-server-log-overlay").classList.remove("show");
}

function setStatus(text) {
  var el = document.getElementById("server-log-status");
  if (el) el.textContent = text || "";
}

function formatSize(bytes) {
  var n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

function currentLogName() {
  return $input("server-log-file").value || "";
}

// 拉取文件列表并立即展示第一个（默认 tigerAgent.log）的内容
async function refreshServerLogFiles() {
  var select = $input("server-log-file");
  var pre = document.getElementById("server-log-content");
  var previous = select.value;
  setStatus(_t("加载中…"));
  try {
    var list = await invoke("fetch_server_logs");
    currentFiles = (list && list.files) || [];
    document.getElementById("server-log-dir").textContent = (list && list.dir) || "";

    select.innerHTML = "";
    currentFiles.forEach(function(f) {
      var opt = document.createElement("option");
      opt.value = f.name;
      opt.textContent = f.name + " · " + formatSize(f.size) + " · " + (f.modified || "");
      select.appendChild(opt);
    });

    if (!currentFiles.length) {
      pre.textContent = "";
      setStatus(_t("服务端没有日志文件"));
      return;
    }
    var keep = currentFiles.some(function(f) { return f.name === previous; });
    if (keep) select.value = previous;
    await loadServerLog();
  } catch (e) {
    pre.textContent = "";
    setStatus("");
    reportError(e, { prefix: _t("读取服务端日志列表失败: ") });
  }
}

async function loadServerLog() {
  var name = currentLogName();
  var pre = document.getElementById("server-log-content");
  if (!name) return;
  var tail = parseInt($input("server-log-tail").value, 10);
  if (isNaN(tail) || tail < 0) tail = 1000;
  setStatus(_t("读取中…"));
  try {
    var text = await invoke("fetch_server_log_text", { name: name, tail: tail });
    pre.textContent = text || _t("（日志为空）");
    // 默认停在末尾：排查问题看的是最新的行
    pre.scrollTop = pre.scrollHeight;
    setStatus(_t("已显示") + " " + name);
  } catch (e) {
    pre.textContent = "";
    setStatus("");
    reportError(e, { prefix: _t("读取服务端日志失败: ") });
  }
}

async function downloadServerLog() {
  var name = currentLogName();
  if (!name) return;
  setStatus(_t("下载中…"));
  try {
    var path = await invoke("download_server_log", { name: name });
    setStatus(_t("已保存到: ") + path);
  } catch (e) {
    var msg = getErrorMessage(e);
    // 用户主动取消不是错误，只更新状态行（Rust 侧固定返回中文，不能按当前语言 _t 比较）
    if (msg && msg.indexOf("用户取消了保存") >= 0) {
      setStatus("");
      return;
    }
    setStatus("");
    reportError(e, { prefix: _t("下载服务端日志失败: ") });
  }
}
