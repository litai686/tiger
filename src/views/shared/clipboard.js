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
