// 终端视图事件绑定：所有动作转发给 store，视图自身不直接发请求。
import * as store from "./store.js";

let removers = [];

function on(el, event, handler, opts) {
  if (!el) return;
  el.addEventListener(event, handler, opts);
  removers.push(function () {
    el.removeEventListener(event, handler, opts);
  });
}

export function bind(root) {
  removers = [];
  const refs = store.state.refs;

  on(refs.workdir, "change", function () {
    store.changePath(refs.workdir.value);
  });
  on(refs.create, "click", function () {
    store.openTerminalModal();
  });
  on(refs.attach, "click", function () {
    store.takeoverActive();
  });
  on(refs.reconnect, "click", function () {
    store.reconnectActive();
  });
  on(refs.modalTarget, "change", function () {
    store.setModalTarget(refs.modalTarget.value);
  });
  on(refs.modalName, "input", function () {
    store.setModalName(refs.modalName.value);
  });
  on(refs.modalCreate, "click", function () {
    store.createPTYTerminal();
  });
  on(refs.modalCancel, "click", function () {
    store.closeTerminalModal();
  });
  on(refs.modal, "click", function (event) {
    if (event.target === refs.modal) store.closeTerminalModal();
  });
  on(refs.killJob, "click", function () {
    store.killJob(store.state.activeJobId);
  });

  on(refs.side, "click", function (event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    // Per-row close wins over row selection: the × sits inside the row.
    const closeTerminal = target.closest("[data-close-terminal-id]");
    if (closeTerminal) {
      store.closeTerminal(closeTerminal.getAttribute("data-close-terminal-id"));
      return;
    }
    const action = target.closest("[data-action]");
    if (action) {
      const name = action.getAttribute("data-action");
      if (name === "refresh") {
        if (!store.state.wsId) store.bootstrap();
        else store.refresh();
      } else if (name === "close") {
        store.closeActive();
      }
      return;
    }

    const terminal = target.closest("[data-terminal-id]");
    if (terminal) {
      store.selectTerminal(terminal.getAttribute("data-terminal-id"));
      return;
    }
    const job = target.closest("[data-job-id]");
    if (job) store.selectJob(job.getAttribute("data-job-id"));
  });
}

export function unbind() {
  removers.forEach(function (fn) { fn(); });
  removers = [];
}
