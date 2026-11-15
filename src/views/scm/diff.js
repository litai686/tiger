// 源码管理视图：unified diff 解析与渲染复用 shared/diff.js（这里绑定 scm- 类名前缀）；
// 本文件只保留源码管理特有的提交记录解析。
import {
  buildSplitRows,
  diffStats,
  fullAddRows,
  parseUnifiedDiff,
  renderDiffPlaceholder as renderPlaceholder,
  renderDiffRows as renderRows,
  renderSplitRows as renderSplit,
} from "../shared/diff.js";

const PREFIX = "scm";

export { buildSplitRows, diffStats, fullAddRows, parseUnifiedDiff };

/**
 * @param {HTMLElement} host
 * @param {Array<{kind:string,text:string,oldNo?:number,newNo?:number}>} rows
 */
export function renderDiffRows(host, rows) {
  renderRows(host, rows, PREFIX);
}

/** @param {HTMLElement} host @param {Array<any>} splitRows */
export function renderSplitRows(host, splitRows) {
  renderSplit(host, splitRows, PREFIX);
}

/** @param {HTMLElement} host @param {string} text */
export function renderDiffPlaceholder(host, text) {
  renderPlaceholder(host, text, PREFIX);
}

/**
 * 解析 `git show --name-status -z` 的输出：`M\0path\0`，重命名/复制为 `R100\0old\0new\0`。
 * @param {string} text
 * @returns {Array<{status:string,path:string,origPath:string}>}
 */
export function parseNameStatusZ(text) {
  const parts = String(text || "").split("\u0000");
  const out = [];
  let i = 0;
  while (i < parts.length) {
    const status = String(parts[i++] || "").trim();
    if (!status) continue;
    const kind = status.charAt(0);
    if (kind === "R" || kind === "C") {
      const origPath = parts[i++] || "";
      const path = parts[i++] || "";
      if (path) out.push({ status, path, origPath });
    } else {
      const path = parts[i++] || "";
      if (path) out.push({ status, path, origPath: "" });
    }
  }
  return out;
}

/**
 * 解析 commit_detail 输出：前 6 个 NUL 字段为 hash/author/email/ISO 日期/subject/body，
 * 之后是 `git show --numstat` 文本（`新增\t删除\t路径`，二进制为 `-\t-`）。
 * @param {string} text
 * @returns {{hash:string,author:string,email:string,date:string,subject:string,body:string,files:number,adds:number,dels:number,binary:number}}
 */
export function parseCommitDetail(text) {
  const parts = String(text || "").split("\u0000");
  const detail = {
    hash: parts[0] || "",
    author: parts[1] || "",
    email: parts[2] || "",
    date: parts[3] || "",
    subject: parts[4] || "",
    body: String(parts[5] || "").trim(),
    files: 0,
    adds: 0,
    dels: 0,
    binary: 0,
  };
  const rest = parts.slice(6).join("\u0000");
  for (const raw of rest.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    detail.files++;
    if (cols[0] === "-" || cols[1] === "-") {
      detail.binary++;
      continue;
    }
    detail.adds += Number(cols[0]) || 0;
    detail.dels += Number(cols[1]) || 0;
  }
  return detail;
}
