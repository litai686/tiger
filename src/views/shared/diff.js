// 项目管理 / 源码管理共用的 unified diff 解析与渲染。
// 两个视图只有 CSS 类名前缀不同，统一由调用方传 prefix，避免各维护一份解析器。
import { t as _t } from "../../i18n.js";

/**
 * @param {string} text
 * @returns {Array<{kind:string,text:string,oldNo?:number,newNo?:number}>}
 */
export function parseUnifiedDiff(text) {
  const out = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const META = /^(new file mode|deleted file mode|old mode|new mode|rename from|rename to|similarity index|dissimilarity index|copy from|copy to|Binary files|GIT binary patch)/;
  for (const raw of String(text || "").split("\n")) {
    if (raw.startsWith("diff --git")) {
      inHunk = false;
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
        out.push({ kind: "hunk", text: raw });
      }
      inHunk = true;
      continue;
    }
    if (!inHunk && (raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ "))) continue;
    if (!inHunk && META.test(raw)) {
      out.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), newNo });
      newNo++;
      continue;
    }
    if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), oldNo });
      oldNo++;
      continue;
    }
    if (raw.startsWith("\\")) {
      out.push({ kind: "nonewline", text: raw });
      continue;
    }
    if (raw === "") continue;
    out.push({ kind: "ctx", text: raw.slice(1), oldNo, newNo });
    oldNo++;
    newNo++;
  }
  return out;
}

/** 未跟踪文件：把内容渲染成「全部新增」的伪 diff。 */
export function fullAddRows(content) {
  const rows = [];
  const lines = String(content || "").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    rows.push({ kind: "add", text: lines[i], newNo: i + 1 });
  }
  return rows;
}

/** @param {Array<{kind:string}>} rows */
export function diffStats(rows) {
  let adds = 0;
  let dels = 0;
  for (const row of rows) {
    if (row.kind === "add") adds++;
    else if (row.kind === "del") dels++;
  }
  return { adds, dels };
}

/**
 * 并排视图用的行模型：连续的删除/新增按顺序配对，左右两栏高度始终一致。
 * @param {Array<{kind:string,text:string,oldNo?:number,newNo?:number}>} rows
 * @returns {Array<any>}
 */
export function buildSplitRows(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === "hunk" || row.kind === "meta" || row.kind === "nonewline") {
      out.push({ kind: row.kind, text: row.text });
      i++;
      continue;
    }
    if (row.kind === "ctx") {
      out.push({
        kind: "ctx",
        left: { no: row.oldNo, text: row.text, kind: "ctx" },
        right: { no: row.newNo, text: row.text, kind: "ctx" },
      });
      i++;
      continue;
    }
    /** @type {any[]} */
    const dels = [];
    /** @type {any[]} */
    const adds = [];
    while (i < rows.length && (rows[i].kind === "del" || rows[i].kind === "add")) {
      if (rows[i].kind === "del") dels.push(rows[i]);
      else adds.push(rows[i]);
      i++;
    }
    const count = Math.max(dels.length, adds.length);
    for (let j = 0; j < count; j++) {
      out.push({
        kind: "change",
        left: dels[j] ? { no: dels[j].oldNo, text: dels[j].text, kind: "del" } : null,
        right: adds[j] ? { no: adds[j].newNo, text: adds[j].text, kind: "add" } : null,
      });
    }
  }
  return out;
}

/**
 * @param {HTMLElement} host
 * @param {Array<{kind:string,text:string,oldNo?:number,newNo?:number}>} rows
 * @param {string} prefix 视图 CSS 类名前缀
 */
export function renderDiffRows(host, rows, prefix) {
  host.textContent = "";
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    if (row.kind === "hunk") {
      const el = document.createElement("div");
      el.className = prefix + "-diff-hunk";
      el.textContent = row.text;
      frag.appendChild(el);
      continue;
    }
    if (row.kind === "meta") {
      const el = document.createElement("div");
      el.className = prefix + "-diff-meta";
      el.textContent = row.text;
      frag.appendChild(el);
      continue;
    }
    if (row.kind === "nonewline") {
      const el = document.createElement("div");
      el.className = prefix + "-diff-nonewline";
      el.textContent = row.text;
      frag.appendChild(el);
      continue;
    }
    const line = document.createElement("div");
    line.className = prefix + "-diff-row " + prefix + "-diff-" + row.kind;
    const oldCell = document.createElement("span");
    oldCell.className = prefix + "-diff-no";
    oldCell.textContent = row.oldNo === undefined ? "" : String(row.oldNo);
    const newCell = document.createElement("span");
    newCell.className = prefix + "-diff-no";
    newCell.textContent = row.newNo === undefined ? "" : String(row.newNo);
    const sign = document.createElement("span");
    sign.className = prefix + "-diff-sign";
    sign.textContent = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
    const text = document.createElement("span");
    text.className = prefix + "-diff-text";
    text.textContent = row.text;
    line.appendChild(oldCell);
    line.appendChild(newCell);
    line.appendChild(sign);
    line.appendChild(text);
    frag.appendChild(line);
  }
  host.appendChild(frag);
}

/**
 * 并排渲染：每行左右两个半栏，删除在左、新增在右（VSCode 默认布局）。
 * @param {HTMLElement} host
 * @param {Array<any>} splitRows
 * @param {string} prefix 视图 CSS 类名前缀
 */
export function renderSplitRows(host, splitRows, prefix) {
  host.textContent = "";
  const frag = document.createDocumentFragment();
  const side = function (cell, which) {
    const half = document.createElement("div");
    half.className = prefix + "-split-side " + which;
    if (!cell) {
      half.classList.add("empty");
      return half;
    }
    half.classList.add(cell.kind);
    const no = document.createElement("span");
    no.className = prefix + "-diff-no";
    no.textContent = cell.no === undefined || cell.no === null ? "" : String(cell.no);
    const sign = document.createElement("span");
    sign.className = prefix + "-diff-sign";
    sign.textContent = cell.kind === "add" ? "+" : cell.kind === "del" ? "-" : " ";
    const text = document.createElement("span");
    text.className = prefix + "-diff-text";
    text.textContent = cell.text;
    half.appendChild(no);
    half.appendChild(sign);
    half.appendChild(text);
    return half;
  };
  for (const row of splitRows) {
    if (row.kind === "hunk") {
      const el = document.createElement("div");
      el.className = prefix + "-diff-hunk";
      el.textContent = row.text;
      frag.appendChild(el);
      continue;
    }
    if (row.kind === "meta") {
      const el = document.createElement("div");
      el.className = prefix + "-diff-meta";
      el.textContent = row.text;
      frag.appendChild(el);
      continue;
    }
    if (row.kind === "nonewline") {
      const el = document.createElement("div");
      el.className = prefix + "-diff-nonewline";
      el.textContent = row.text;
      frag.appendChild(el);
      continue;
    }
    const line = document.createElement("div");
    line.className = prefix + "-split-row";
    line.appendChild(side(row.left, "left"));
    line.appendChild(side(row.right, "right"));
    frag.appendChild(line);
  }
  host.appendChild(frag);
}

/**
 * @param {HTMLElement} host
 * @param {string} text
 * @param {string} prefix 视图 CSS 类名前缀
 */
export function renderDiffPlaceholder(host, text, prefix) {
  host.textContent = "";
  const el = document.createElement("div");
  el.className = prefix + "-placeholder";
  el.textContent = _t(text);
  host.appendChild(el);
}
