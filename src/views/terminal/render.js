// 终端视图渲染：只读写 DOM，不直接发请求（数据由 store 维护）。
import { t as _t } from "../../i18n.js";
import { state } from "./store.js";
import * as pty from "./pty.js";

export function render() {
  const refs = state.refs;
  if (!refs) return;
  renderWorkdir(refs);
  renderBanner(refs);
  renderButtons(refs);
  renderSide(refs);
  renderStatus(refs);
  renderOutput(refs);
  renderModal(refs);
}

// 输出区（后台作业/提示）渲染缓存：没有变化时不动 DOM；视图重新挂载后 DOM
// 是新的，需由 resetCaches() 清空。
let outRender = { key: "", text: "" };

export function resetCaches() {
  outRender = { key: "", text: "" };
}

function activeTerminal() {
  if (!state.activeId || state.activeJobId) return null;
  return state.terminals.find(function (t) { return t.id === state.activeId; }) || null;
}

function targetOf(terminal) {
  if (!terminal || !terminal.target_id) return null;
  return state.targets.find(function (t) { return t.id === terminal.target_id; }) || null;
}

function renderWorkdir(refs) {
  const key = state.workdirs.map(function (w) { return w.path; }).join("\n") + "|" + state.activePath;
  if (refs.workdir.dataset.key !== key) {
    refs.workdir.innerHTML = "";
    state.workdirs.forEach(function (w) {
      const option = document.createElement("option");
      option.value = w.path;
      option.textContent = w.path;
      if (w.path === state.activePath) option.selected = true;
      refs.workdir.appendChild(option);
    });
    refs.workdir.dataset.key = key;
  }
  refs.workdir.disabled = state.connecting || !state.workdirs.length;
}

function renderBanner(refs) {
  const text = state.pageError || state.banner;
  refs.banner.textContent = text || "";
  refs.banner.className = "terminal-banner" + (text ? " show " + (state.pageError ? "error" : state.bannerKind) : "");
}

function renderButtons(refs) {
  const jobMode = !!state.activeJobId;
  const sshCap = !!(state.caps && state.caps.ssh);
  refs.create.disabled = !state.wsId || state.connecting || !sshCap || !state.targets.length;
  if (refs.sshTargetHint) {
    const hint = sshCap && !state.connecting && !state.targets.length
      ? (state.targetsError || _t("服务端未配置目标机：请在 terminal-targets.json 中添加 SSH 目标"))
      : "";
    refs.sshTargetHint.textContent = hint;
    refs.sshTargetHint.style.display = hint ? "" : "none";
  }
  refs.killJob.style.display = jobMode ? "" : "none";
  refs.killJob.disabled = !jobMode;
}

function renderSide(refs) {
  const key = sideKey();
  if (refs.side.dataset.key === key) return;
  refs.side.dataset.key = key;
  const side = refs.side;
  side.innerHTML = "";

  side.appendChild(sectionRow(_t("终端会话"), [
    { action: "refresh", label: _t("刷新"), disabled: state.connecting },
    { action: "close", label: _t("关闭"), disabled: !state.activeId || !!state.activeJobId },
  ]));
  if (!state.terminals.length) {
    side.appendChild(emptyHint(state.connecting ? _t("正在连接服务端...") : _t("暂无终端会话")));
  } else {
    state.terminals.forEach(function (terminal) {
      side.appendChild(terminalItem(terminal));
    });
  }

  side.appendChild(sectionRow(_t("后台作业"), []));
  if (!state.jobs.length) {
    side.appendChild(emptyHint(_t("暂无后台作业")));
  } else {
    state.jobs.forEach(function (job) {
      side.appendChild(jobItem(job));
    });
  }
}

// sideKey 覆盖侧栏渲染用到的全部字段：一致时跳过整树重建（轮询每 1.5s 会
// 调用一次 render），避免丢 hover/焦点与无谓的 DOM 抖动。
function sideKey() {
  const parts = [state.connecting ? "1" : "0", state.activeId, state.activeJobId];
  state.terminals.forEach(function (terminal) {
    parts.push([terminal.id, terminal.name, terminal.kind, terminal.state].join(":"));
  });
  parts.push("|");
  state.jobs.forEach(function (job) {
    parts.push([
      job.id, job.command, job.state,
      job.exit_code === null || job.exit_code === undefined ? "" : job.exit_code,
    ].join(":"));
  });
  return parts.join("#");
}

function sectionRow(title, actions) {
  const row = document.createElement("div");
  row.className = "terminal-section-row";

  const label = document.createElement("span");
  label.className = "terminal-section";
  label.textContent = title;
  row.appendChild(label);

  if (actions.length) {
    const group = document.createElement("span");
    group.className = "terminal-section-actions";
    actions.forEach(function (item) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "terminal-btn terminal-btn-sm";
      button.dataset.action = item.action;
      button.textContent = item.label;
      button.disabled = !!item.disabled;
      group.appendChild(button);
    });
    row.appendChild(group);
  }
  return row;
}

function emptyHint(text) {
  const el = document.createElement("div");
  el.className = "terminal-empty";
  el.textContent = text;
  return el;
}

function terminalItem(terminal) {
  const el = document.createElement("div");
  const selected = terminal.id === state.activeId && !state.activeJobId;
  el.className = "terminal-item" + (selected ? " active" : "");
  el.dataset.terminalId = terminal.id;

  const dot = document.createElement("span");
  const running = terminal.state === "open";
  dot.className = "terminal-dot" + (running ? " running" : "");

  const name = document.createElement("span");
  name.className = "terminal-item-name";
  name.textContent = terminal.name || terminal.id;

  const kind = document.createElement("span");
  const target = targetOf(terminal);
  const localTarget = !!(target && target.transport === "local");
  kind.className = "terminal-kind" + (localTarget ? "" : " ssh");
  kind.textContent = localTarget ? _t("本机") : "SSH";

  const meta = document.createElement("span");
  meta.className = "terminal-item-meta";
  if (terminal.state === "disconnected") meta.textContent = _t("已断开");
  else if (terminal.state === "exited") meta.textContent = _t("已退出");
  else meta.textContent = _t("已连接");

  const close = document.createElement("button");
  close.type = "button";
  close.className = "terminal-item-close";
  close.textContent = "\u00d7";
  close.title = _t("关闭终端");
  close.dataset.closeTerminalId = terminal.id;

  el.appendChild(dot);
  el.appendChild(name);
  el.appendChild(kind);
  el.appendChild(meta);
  el.appendChild(close);
  return el;
}

function jobItem(job) {
  const el = document.createElement("div");
  el.className = "terminal-item" + (job.id === state.activeJobId ? " active" : "");
  el.dataset.jobId = job.id;

  const dot = document.createElement("span");
  dot.className = "terminal-dot" + (job.state === "running" ? " running" : "");

  const name = document.createElement("span");
  name.className = "terminal-item-name";
  name.textContent = job.command || job.id;

  const meta = document.createElement("span");
  meta.className = "terminal-item-meta";
  if (job.state === "running") meta.textContent = _t("运行中");
  else if (job.exit_code !== null && job.exit_code !== undefined) meta.textContent = "exit " + job.exit_code;
  else meta.textContent = _t("已完成");

  el.appendChild(dot);
  el.appendChild(name);
  el.appendChild(meta);
  return el;
}

function renderStatus(refs) {
  const job = state.activeJobId ? state.jobs.find(function (j) { return j.id === state.activeJobId; }) : null;
  const terminal = activeTerminal();
  const info = terminal ? pty.getInfo(terminal.id) : null;

  refs.statusName.textContent = job
    ? (job.command || job.id)
    : terminal ? (terminal.name || terminal.id) : _t("未选择会话");
  refs.statusCwd.textContent = job
    ? (job.working_dir || "")
    : terminal ? (terminal.target_label || "") : "";

  if (refs.statusTarget) {
    refs.statusTarget.textContent = terminal && info ? (info.readOnly ? _t("只读") : _t("控制中")) : "";
  }
  if (refs.attach) {
    refs.attach.style.display = terminal ? "" : "none";
    refs.attach.disabled = !terminal || !info || !info.readOnly;
  }
  if (refs.reconnect) {
    const st = terminal ? (info && info.state ? info.state : terminal.state) : "";
    const disconnected = !!terminal && (st === "disconnected" || st === "exited");
    refs.reconnect.style.display = disconnected ? "" : "none";
  }

  let stateText = "";
  let stateClass = "";
  if (job) {
    stateText = job.state === "running" ? _t("运行中") : _t("已完成");
    stateClass = job.state === "running" ? "running" : "";
  } else if (terminal) {
    const st = info && info.state ? info.state : terminal.state;
    if (st === "open") stateText = _t("已连接");
    else if (st === "exited") stateText = _t("已退出");
    else if (st === "disconnected") stateText = _t("已断开");
    else stateText = st || "";
    stateClass = st === "open" ? "running" : "failed";
  }
  refs.statusState.textContent = stateText;
  refs.statusState.className = stateClass;
}

function renderOutput(refs) {
  const terminal = activeTerminal();
  refs.output.style.display = terminal ? "none" : "";
  if (refs.pty) refs.pty.style.display = terminal ? "block" : "none";
  if (terminal) {
    if (outRender.key !== "") {
      refs.output.textContent = "";
      outRender = { key: "", text: "" };
    }
    return;
  }

  const output = refs.output;
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 8;
  const key = state.pageError ? "error" : state.activeJobId ? "job:" + state.activeJobId : "empty";
  const text = state.pageError
    ? state.pageError
    : state.activeJobId ? jobText() : _t("选择左侧终端会话或后台作业查看输出");
  if (outRender.key !== key || outRender.text !== text) {
    output.textContent = text;
    outRender = { key: key, text: text };
  }
  if (atBottom) output.scrollTop = output.scrollHeight;
}

function jobText() {
  const job = state.jobOutput;
  if (!job) return _t("加载中...");
  const parts = [];
  if (job.stdout) parts.push(job.stdout);
  if (job.stderr) parts.push(job.stderr);
  if (job.truncated) parts.push("\n" + _t("输出过长，已截断显示"));
  return parts.join("");
}

function renderModal(refs) {
  if (!refs.modal) return;
  refs.modal.className = "terminal-modal-mask" + (state.modalOpen ? " show" : "");
  if (!state.modalOpen) return;

  const key = state.targets.map(function (t) { return t.id + ":" + (t.disabled ? "1" : "0"); }).join("|");
  if (refs.modalTarget.dataset.key !== key) {
    refs.modalTarget.innerHTML = "";
    if (!state.targets.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = state.targetsError || _t("（未配置目标机）");
      refs.modalTarget.appendChild(option);
    } else {
      state.targets.forEach(function (target) {
        const option = document.createElement("option");
        option.value = target.id;
        option.textContent = target.transport === "local"
          ? _t("本机") + " · " + (target.name || target.host || target.id)
          : (target.name || target.id) +
            "  " + target.user + "@" + target.host + (target.disabled ? "  [" + _t("已禁用") + "]" : "");
        option.disabled = !!target.disabled;
        if (target.id === state.modalTarget) option.selected = true;
        refs.modalTarget.appendChild(option);
      });
    }
    refs.modalTarget.dataset.key = key;
  }
  if (document.activeElement !== refs.modalName) refs.modalName.value = state.modalName || "";
  refs.modalError.textContent = state.modalError || state.targetsError || "";
  refs.modalCreate.disabled = state.modalBusy || !state.modalTarget;
  refs.modalCreate.textContent = state.modalBusy ? _t("连接中...") : _t("连接");
}
