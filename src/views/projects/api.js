// 项目管理视图：HTTP 封装、能力探测、路径编码与错误归类
import { getErrorMessage } from "../agent/error.js";

/** @type {(cmd: string, args?: any) => Promise<any>} */
const invoke = window.__agent_invoke;

/** 所有 GET 单飞：相同 key 复用进行中的 Promise，避免目录重复点击/轮询叠加。 */
const inflight = new Map();

export async function api(method, path, body) {
  return invoke("agent_http_request", { method, path, body: body ?? null });
}

export async function invokeCmd(cmd, args) {
  return invoke(cmd, args);
}

export async function get(path) {
  const cur = inflight.get(path);
  if (cur) return cur;
  const p = api("GET", path).finally(function () {
    inflight.delete(path);
  });
  inflight.set(path, p);
  return p;
}

export function qs(params) {
  const parts = [];
  for (const key of Object.keys(params || {})) {
    const value = params[key];
    if (value === undefined || value === null || value === "") continue;
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
  }
  return parts.length ? "?" + parts.join("&") : "";
}

export function httpStatus(err) {
  const m = String(err && (err.message || err)).match(/^HTTP (\d{3})\b/);
  return m ? Number(m[1]) : 0;
}

/** 提取服务端错误文本：去掉 Rust 侧的 "HTTP 400 GET /x: " 包装并解析 {message}。 */
export function errorMessage(err) {
  let raw = getErrorMessage(err);
  const m = raw.match(/^HTTP \d{3}\s+\w+\s+\S+:\s*([\s\S]*)$/);
  if (m) raw = m[1];
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.message === "string") return obj.message;
  } catch (_) {}
  return raw;
}

/** 探测 /v1/version 的 capabilities；失败向上抛，由页面显示「未连接服务端」。 */
export async function probeCapabilities() {
  const info = await api("GET", "/v1/version");
  const list = (info && info.capabilities) || [];
  const set = new Set(list);
  return {
    files: set.has("workspace_files"),
    git: set.has("workspace_git"),
    gitExec: set.has("workspace_git_exec"),
  };
}
