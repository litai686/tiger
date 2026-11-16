// 终端视图：服务端接口封装（复用项目管理视图的通用 HTTP 封装）
import { api, invokeCmd, httpStatus, errorMessage } from "../projects/api.js";

export { api, invokeCmd, httpStatus, errorMessage };

const BASE = "/v1/workspaces/";

/**
 * 探测 /v1/version capability。
 * @returns {Promise<{terminal:boolean, ssh:boolean, caps:string[]}>}
 */
export async function probeTerminal() {
  const info = await api("GET", "/v1/version");
  const caps = (info && info.capabilities) || [];
  return {
    terminal: caps.indexOf("terminal_v1") >= 0,
    ssh: caps.indexOf("terminal_ssh_v1") >= 0,
    caps: caps,
  };
}

export async function getWorkdirs() {
  return invokeCmd("get_workdirs");
}

export async function listWorkspaces() {
  return api("GET", "/v1/workspaces");
}

export async function createWorkspace(path, clientId) {
  return invokeCmd("create_workspace", { path, clientId });
}

export function listTerminals(wsId, kind) {
  const query = kind ? "?kind=" + encodeURIComponent(kind) : "";
  return api("GET", BASE + wsId + "/terminals" + query);
}

export function createTerminal(wsId, body) {
  return api("POST", BASE + wsId + "/terminals", body || {});
}

export function terminalOutput(wsId, tid, after, limitBytes) {
  const query = "?after=" + encodeURIComponent(String(after)) +
    "&limit_bytes=" + encodeURIComponent(String(limitBytes));
  return api("GET", BASE + wsId + "/terminals/" + tid + "/output" + query);
}

export function deleteTerminal(wsId, tid) {
  return api("DELETE", BASE + wsId + "/terminals/" + tid);
}

export function listTerminalTargets() {
  return api("GET", "/v1/terminal-targets");
}

export function inputTerminal(wsId, tid, body) {
  return api("POST", BASE + wsId + "/terminals/" + tid + "/input", body);
}

export function resizeTerminal(wsId, tid, body) {
  return api("POST", BASE + wsId + "/terminals/" + tid + "/resize", body);
}

export function attachTerminal(wsId, tid, body) {
  return api("POST", BASE + wsId + "/terminals/" + tid + "/attach", body);
}

export function releaseTerminal(wsId, tid, clientId) {
  const query = "?client_id=" + encodeURIComponent(clientId || "");
  return api("DELETE", BASE + wsId + "/terminals/" + tid + "/attach" + query);
}

export function listShellJobs(wsId) {
  return api("GET", BASE + wsId + "/shell-jobs");
}

export function shellJobOutput(wsId, jid, tailBytes) {
  const query = "?tail_bytes=" + encodeURIComponent(String(tailBytes));
  return api("GET", BASE + wsId + "/shell-jobs/" + jid + query);
}

export function killShellJob(wsId, jid) {
  return api("DELETE", BASE + wsId + "/shell-jobs/" + jid);
}
