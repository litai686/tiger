// 视图共用：复制文本到系统剪贴板（Clipboard API → execCommand 回退）。
import { t as _t } from "../../i18n.js";

/**
 * @param {string} text
 * @param {HTMLElement|null|undefined} button 复制成功后短暂改文案的按钮
 */
export function copyText(text, button) {
  const done = function () {
    if (!button) return;
    const prev = button.textContent;
    button.textContent = _t("已复制");
    setTimeout(function () {
      button.textContent = prev;
    }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(function () {});
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
    done();
  } catch (_) {}
  document.body.removeChild(area);
}

/**
 * 读取系统剪贴板：优先 Web Clipboard（需要用户手势/权限），失败回退到
 * Tauri 的 clipboard_read_text（Linux WebKitGTK 上 Web Clipboard 不可用）。
 * @returns {Promise<string>}
 */
export function readText() {
  const native = function () {
    const invoke = window.__agent_invoke;
    if (typeof invoke !== "function") return Promise.resolve("");
    return invoke("clipboard_read_text").then(function (text) {
      return typeof text === "string" ? text : "";
    });
  };
  if (navigator.clipboard && navigator.clipboard.readText) {
    return navigator.clipboard.readText().catch(native);
  }
  return native();
}
