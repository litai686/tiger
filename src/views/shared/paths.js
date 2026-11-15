// 视图共用：workspace 路径归一化与按路径查找 workspace id。

/** 去掉末尾分隔符；Windows 路径统一小写，便于跨来源（下拉 / 服务端）比较。 */
export function normalizePath(p) {
  let out = String(p || "").trim().replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(out)) out += "\\";
  if (out.indexOf("\\") >= 0 || /^[A-Za-z]:/.test(out)) out = out.toLowerCase();
  return out;
}

/**
 * @param {Array<{id:string,path:string}>|null|undefined} workspaces
 * @param {string} path
 */
export function wsIdByPath(workspaces, path) {
  const key = normalizePath(path);
  for (const w of workspaces || []) {
    if (normalizePath(w.path) === key) return w.id;
  }
  return null;
}
