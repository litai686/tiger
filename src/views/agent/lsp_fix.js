// LSP 启动失败检测与修复（三层，安装与启动都在服务端执行）：
//  T1 自动安装：安装命令表在服务端（internal/lsp/fix.go），一条
//     POST /lsps/{lsp}/fix 完成「装二进制 + 启动」，客户端只展示结果
//  T2 安装指引：不可自动安装的服务器（二进制发行版 / 系统包管理器 / 随 SDK）
//     由服务端下发推荐命令 + 文档链接
//  T3 AI 安装：把安装任务交给当前会话的 agent（bash + 网络）兜底任意语言
import { t as _t } from "../../i18n.js";
import { S } from "./store.js";
import { api } from "./api.js";
import { log } from "./log.js";
import { showInfo, showWarning, reportError } from "./ui.js";
import { loadTools, renderToolsList } from "./tools.js";
import { sendMessageWithText } from "./send.js";

var AUTO_FIX_KEY = "agent_lsp_auto_fix";
var AUTO_FIX_INTERVAL_MS = 30 * 60 * 1000;
var NOTICE_INTERVAL_MS = 10 * 60 * 1000;
// 服务端装包最长 10 分钟：POST 只调度任务，这里轮询作业状态（HTTP 请求本身
// 有 180s 上限，不能把安装挂在一次请求上）
var FIX_POLL_INTERVAL_MS = 1500;
var FIX_POLL_TIMEOUT_MS = 12 * 60 * 1000;

// name -> { command, requires, hint, url }（来自 GET /v1/lsp/fix-targets：
// command 非空 = 服务端可自动安装，否则是需手工安装的指引）
var fixTargets = null;
var fixTargetsLoading = null;
var fixInFlight = {};
var lastFixAttemptAt = {};
var lastNoticeAt = {};

/** 拉取服务端的 LSP 安装目标列表（缓存，只失败时重试） */
export function ensureFixTargets() {
  if (fixTargets) return Promise.resolve(fixTargets);
  if (fixTargetsLoading) return fixTargetsLoading;
  fixTargetsLoading = api("GET", "/v1/lsp/fix-targets").then(function(list) {
    var map = {};
    (list || []).forEach(function(t) {
      if (!t || !t.name) return;
      map[t.name] = {
        command: t.command || "",
        requires: t.requires || "",
        hint: t.hint || "",
        url: t.url || "",
      };
    });
    fixTargets = map;
    fixTargetsLoading = null;
    // 首屏 loadTools 早于本列表返回：补一次重绘，否则「修复」按钮要等下次刷新才出现
    renderToolsList();
    return map;
  }).catch(function(e) {
    log.debug("LSP", "获取安装目标失败: " + e);
    fixTargets = {};
    fixTargetsLoading = null;
    renderToolsList();
    return fixTargets;
  });
  return fixTargetsLoading;
}

export function isLspFixable(name) {
  var target = fixTargets && fixTargets[name];
  return !!(target && target.command);
}

export function fixTarget(name) {
  return (fixTargets && fixTargets[name]) || null;
}

/** 手工安装指引；可自动安装或没有指引时返回 null（按钮不显示） */
export function guideFor(name) {
  var target = fixTargets && fixTargets[name];
  if (!target || target.command) return null;
  if (!target.hint && !target.url) return null;
  return { hint: target.hint, url: target.url };
}

export function isLspAutoFixEnabled() {
  try { return localStorage.getItem(AUTO_FIX_KEY) === "1"; } catch (_) { return false; }
}

export function setLspAutoFixEnabled(on) {
  try { localStorage.setItem(AUTO_FIX_KEY, on ? "1" : "0"); } catch (_) {}
}

/** LSP 状态事件入口（sse.js 在 lsp_event/state_changed 时调用）；state: 3=错误。
 *  errorType 为服务端分类：not_installed 表示二进制未安装（工具面板已隐藏该
 *  条目）。该分类不影响自动安装开关（开启时仍会安装缺失的二进制），只是不再
 *  弹"启动失败"提示——未安装不是故障；startup_failed 才提示。 */
export function onLspStateEvent(name, state, errorText, errorType) {
  if (!name || state !== 3) return;
  if (!fixTargets) {
    ensureFixTargets().then(function() { onLspStateEvent(name, state, errorText, errorType); });
    return;
  }
  var now = Date.now();
  var reason = errorText ? String(errorText) : _t("未知原因");

  if (isLspFixable(name) && isLspAutoFixEnabled()) {
    if (fixInFlight[name]) return;
    if (now - (lastFixAttemptAt[name] || 0) < AUTO_FIX_INTERVAL_MS) return;
    // 记录尝试时间由 runLspFix 统一维护：修复失败会把时间戳归零，下次报错即可重试
    showInfo(name + _t(" 启动失败，正在自动安装修复…"));
    runLspFix(name, { auto: true });
    return;
  }

  // 未安装且未开启自动修复：条目已从列表隐藏，不打扰用户
  if (errorType === "not_installed") return;

  if (now - (lastNoticeAt[name] || 0) < NOTICE_INTERVAL_MS) return;
  lastNoticeAt[name] = now;
  var hint = _t("（可在「工具」→ LSP 页用「AI 安装」）");
  if (isLspFixable(name)) hint = _t("（可在「工具」→ LSP 页一键修复）");
  else if (guideFor(name)) hint = _t("（可在「工具」→ LSP 页查看安装指引）");
  showWarning(name + _t(" 启动失败：") + reason + hint);
}

/** T1：请求服务端安装并启动（服务端在一条请求里完成装包 → 启动），随后刷新面板 */
export async function runLspFix(name, opts) {
  opts = opts || {};
  if (!isLspFixable(name) || fixInFlight[name]) return false;
  var wsId = S.serverInfo ? S.serverInfo.workspace_id : "";
  if (!wsId) return false;
  fixInFlight[name] = true;
  try {
    var target = fixTarget(name) || {};
    log.debug("LSP", "修复 " + name + "：请求服务端执行 " + (target.command || ""));
    var fixUrl = "/v1/workspaces/" + wsId + "/lsps/" + encodeURIComponent(name) + "/fix";
    var result = await api("POST", fixUrl);
    result = await waitFixDone(fixUrl, result);
    await loadTools();
    // 服务端返回值里 state 与 /lsps 一致：2=已连接 1=启动中
    var started = !!result && (result.state === 2 || result.state === 1);
    if (started) {
      // 修复成功后抑制本会话内的重复自动安装（避免误判反复重装）
      lastFixAttemptAt[name] = Date.now();
      showInfo(name + _t(" 已修复并启动"));
    } else if (result && result.running) {
      // 轮询到自身超时：作业还在跑，交给用户稍后自查（不误报成失败）
      showInfo(name + _t(" 仍在安装中，完成后可在「工具」→ LSP 页查看状态"));
    } else {
      // 未就绪（服务端安装失败 / 启动没到 ready）：清零时间戳，下次报错可重试
      lastFixAttemptAt[name] = 0;
      var msg = name + _t(" 已安装，但服务尚未就绪；打开对应文件时会再次自动启动");
      if (result && result.error) msg += " " + String(result.error);
      showWarning(msg);
    }
    return started;
  } catch (e) {
    lastFixAttemptAt[name] = 0;
    reportError(e, { prefix: name + _t(" 修复失败：") });
    return false;
  } finally {
    fixInFlight[name] = false;
  }
}

/** 轮询服务端修复作业直到结束；超时返回最后一次状态（可能仍在装） */
async function waitFixDone(fixUrl, result) {
  var deadline = Date.now() + FIX_POLL_TIMEOUT_MS;
  while (result && result.running && Date.now() < deadline) {
    await new Promise(function(resolve) { setTimeout(resolve, FIX_POLL_INTERVAL_MS); });
    result = await api("GET", fixUrl);
  }
  return result;
}

/** T3：把安装任务交给当前会话的 agent（兜底任意语言/任意安装方式） */
export function runAiInstall(name, errorText) {
  var prompt = _t("请帮我安装并配置语言服务器「") + name + _t("」，让它能正常启动。当前失败原因：") +
    (errorText ? String(errorText) : _t("未知原因")) +
    _t("。请选择合适的包管理器安装（npm/pip/go/cargo 等），安装完成后验证 LSP 能否正常启动。");
  sendMessageWithText(prompt);
}
