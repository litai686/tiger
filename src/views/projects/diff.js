// 项目管理视图：diff 解析与渲染复用 shared/diff.js，这里只绑定 projects- 类名前缀。
import {
  fullAddRows,
  parseUnifiedDiff,
  renderDiffPlaceholder as renderPlaceholder,
  renderDiffRows as renderRows,
} from "../shared/diff.js";

const PREFIX = "projects";

export { fullAddRows, parseUnifiedDiff };

/**
 * @param {HTMLElement} host
 * @param {Array<{kind:string,text:string,oldNo?:number,newNo?:number}>} rows
 */
export function renderDiffRows(host, rows) {
  renderRows(host, rows, PREFIX);
}

/** @param {HTMLElement} host @param {string} text */
export function renderDiffPlaceholder(host, text) {
  renderPlaceholder(host, text, PREFIX);
}
