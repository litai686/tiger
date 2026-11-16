// 交互终端：xterm.js 生命周期、SSE 增量、输入单飞队列、控制权租约。
// 该模块不 import store.js，避免循环依赖；状态变化通过 onUpdate 回调通知视图。
import * as api from "./api.js";
import { t as _t } from "../../i18n.js";
import { createProbe, noteQueued, noteSent, noteEcho, noteParsed } from "./latency.js";
import { copyText, readText } from "../shared/clipboard.js";

/** @type {any} */
let TerminalCtor = null;
/** @type {any} */
let FitAddonCtor = null;
/** @type {any} */
let WebglAddonCtor = null;
let xtermPromise = null;

/** @type {any} */
let deps = { wsId: "", clientId: "", container: null, onUpdate: null, onError: null };
/** @type {Map<string, any>} */
const sessions = new Map();
let activeId = "";

function loadXterm() {
  if (xtermPromise) return xtermPromise;
  xtermPromise = Promise.all([
    import("../../vendor/xterm/xterm.mjs"),
    import("../../vendor/xterm/addon-fit.mjs"),
  ]).then(async function (mods) {
    TerminalCtor = mods[0].Terminal;
    FitAddonCtor = mods[1].FitAddon;
    // WebGL 是可选增强：加载失败只影响渲染器，不能让整个终端初始化失败。
    try {
      const webgl = await import("../../vendor/xterm/addon-webgl.mjs");
      WebglAddonCtor = webgl.WebglAddon;
    } catch (_) {
      WebglAddonCtor = null;
    }
    return { Terminal: TerminalCtor, FitAddon: FitAddonCtor, WebglAddon: WebglAddonCtor };
  });
  return xtermPromise;
}

export function configure(opts) {
  deps = Object.assign({}, deps, opts || {});
}

export function reset() {
  disposeAll();
  activeId = "";
}

export function setActive(id) {
  activeId = id || "";
  sessions.forEach(function (s) {
    if (s.el) s.el.style.display = s.id === activeId ? "block" : "none";
    if (s.id === activeId) {
      startPolling(s);
      startHeartbeat(s);
      fitSoon(s);
      if (!s.readOnly) attachSession(s, false);
      if (s.term) {
        try { s.term.focus(); } catch (_) {}
      }
    } else {
      stopPolling(s);
      stopHeartbeat(s);
    }
  });
}

export function has(id) {
  return sessions.has(id);
}

export function activate(terminal) {
  if (!terminal || terminal.kind !== "pty" || !deps.container) return;
  const id = terminal.id;
  let s = sessions.get(id);
  if (!s) {
    s = {
      id: id,
      terminal: terminal,
      el: null,
      term: null,
      fit: null,
      nextAfter: 0,
      state: terminal.state || "open",
      exitCode: null,
      controller: terminal.controller_client_id || "",
      readOnly: false,
      attached: false,
      disposed: false,
      pendingInput: "",
      inputInFlight: false,
      inputRetries: 0,
      updateScheduled: false,
      lastRenderAt: 0,
      lastEventAt: 0,
      resizeTimer: null,
      pollTimer: null,
      heartbeatTimer: null,
      attachRetryTimer: null,
      attachRetries: 0,
      inputOverflowed: false,
      polling: false,
      observing: false,
      lastError: "",
      latency: createProbe(function (message) {
        terminalLog(message + " terminal=" + id);
      }),
    };
    sessions.set(id, s);
    ensureSession(s);
  } else {
    s.terminal = terminal;
  }
  setActive(id);
}

export function getInfo(id) {
  const s = sessions.get(id);
  if (!s) return null;
  return {
    state: s.state,
    exitCode: s.exitCode,
    readOnly: s.readOnly,
    attached: s.attached,
    controller: s.controller,
    error: s.lastError,
  };
}

async function ensureSession(s) {
  try {
    const mods = await loadXterm();
    if (s.disposed) return;
    if (!deps.container) return;

    const el = document.createElement("div");
    el.className = "terminal-pty-instance";
    el.dataset.terminalId = s.id;
    el.style.display = s.id === activeId ? "block" : "none";
    deps.container.appendChild(el);
    s.el = el;

    const term = new mods.Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: "#0d1117",
        foreground: "#e0e0e0",
        cursor: "#6c63ff",
        selectionBackground: "rgba(108, 99, 255, 0.25)",
      },
    });
    const fit = new mods.FitAddon();
    term.loadAddon(fit);
    s.term = term;
    s.fit = fit;

    term.open(el);
    // WebGL（GPU）渲染：大量输出/滚动时明显降低主线程压力；不可用时
    // （旧 WebView/显卡驱动黑名单）自动保持 xterm 默认 DOM 渲染。
    tryLoadWebgl(term, s);
    // 远端不能改写本地剪贴板。
    try {
      term.parser.registerOscHandler(52, function () { return true; });
    } catch (_) {}

    term.attachCustomKeyEventHandler(function (event) {
      if (event.type !== "keydown") return true;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return true;
      const key = String(event.key || "").toLowerCase();
      if (key === "c" && (event.shiftKey || event.metaKey)) {
        const selection = term.getSelection();
        if (selection) {
          event.preventDefault();
          copyText(selection, null);
          return false;
        }
      }
      if (key === "v" && (event.shiftKey || event.metaKey)) {
        event.preventDefault();
        readText().then(function (text) {
          if (text) term.paste(text);
        }).catch(function () {});
        return false;
      }
      return true;
    });

    term.onData(function (data) {
      // attach 尚未完成时也要先排队：直接丢弃会让会话刚选中时的头几个
      // 按键静默丢失（表现为“点了终端先打几个字没反应”）。
      if (s.readOnly) return;
      noteQueued(s.latency, performance.now());
      s.pendingInput += data;
      trimPendingInput(s);
      flushInput(s);
    });
    term.onResize(function (size) {
      scheduleResize(s, size.cols, size.rows);
    });

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(function () {
        if (s.id === activeId) fitSoon(s);
      });
      ro.observe(el);
      ro.observe(deps.container);
      s.observer = ro;
    }

    if (s.terminal.controller_client_id && s.terminal.controller_client_id !== deps.clientId) {
      s.readOnly = true;
    }
    await attachSession(s, !s.terminal.controller_client_id || s.terminal.controller_client_id === deps.clientId);
    await backfill(s);
    if (s.state === "open") {
      startPolling(s);
      startHeartbeat(s);
    }
    fitSoon(s);
    if (deps.onUpdate) deps.onUpdate();
    terminalLog("probe ready terminal=" + s.id + " readOnly=" + s.readOnly);
  } catch (e) {
    s.lastError = api.errorMessage(e) || _t("终端初始化失败");
    if (deps.onError) deps.onError(e);
    if (deps.onUpdate) deps.onUpdate();
  }
}

function tryLoadWebgl(term, s) {
  if (!WebglAddonCtor) return;
  try {
    const addon = new WebglAddonCtor();
    addon.onContextLoss(function () {
      s.webgl = null;
      try { addon.dispose(); } catch (_) {}
    });
    term.loadAddon(addon);
    s.webgl = addon;
  } catch (_) {
    s.webgl = null;
  }
}

function fitSoon(s) {
  requestAnimationFrame(function () {
    if (s.disposed || !s.fit || !s.el || s.el.style.display === "none") return;
    try {
      s.fit.fit();
    } catch (_) {}
  });
}

async function attachSession(s, force) {
  if (!deps.wsId || s.disposed) return;
  clearAttachRetry(s);
  try {
    const res = await api.attachTerminal(deps.wsId, s.id, {
      client_id: deps.clientId,
      force: !!force,
    });
    s.attached = true;
    s.attachRetries = 0;
    s.controller = res.controller_client_id || deps.clientId;
    s.readOnly = s.controller !== deps.clientId;
    s.lastError = "";
    // attach 完成后把等待期间积累的按键发出去。
    if (!s.readOnly) flushInput(s);
  } catch (e) {
    const code = api.httpStatus(e);
    const message = api.errorMessage(e) || "";
    if (code === 409 && message.indexOf("[terminal:readonly]") >= 0) {
      s.readOnly = true;
      s.attached = false;
    } else if (code === 404) {
      s.state = "exited";
      s.lastError = _t("会话已失效");
    } else if (deps.onError) {
      deps.onError(e);
      // 网络抖动/5xx 时 attached 仍是 false，flushInput 不会发送。不能等 60s
      // 心跳才发现恢复：按指数退避主动重试，否则用户看到的是“输出正常、
      // 键盘没反应”，按键全堆在 pendingInput 里。
      scheduleAttachRetry(s);
    }
  }
  if (deps.onUpdate) deps.onUpdate();
}

function startHeartbeat(s) {
  stopHeartbeat(s);
  s.heartbeatTimer = setInterval(function () {
    if (s.disposed || s.id !== activeId) return;
    if (!s.readOnly) attachSession(s, false);
  }, 60 * 1000);
}

function stopHeartbeat(s) {
  if (s.heartbeatTimer) {
    clearInterval(s.heartbeatTimer);
    s.heartbeatTimer = null;
  }
}

// attach 失败（网络抖动/5xx）后的主动重试：2s 起指数退避，上限 30s。
// 会话失焦/已销毁/已只读时不再重试；成功 attach 会清零计数。
const ATTACH_RETRY_MIN_MS = 2000;
const ATTACH_RETRY_MAX_MS = 30000;

function scheduleAttachRetry(s) {
  if (s.disposed || s.attachRetryTimer || s.readOnly) return;
  s.attachRetries = (s.attachRetries || 0) + 1;
  const delay = Math.min(
    ATTACH_RETRY_MIN_MS * Math.pow(2, Math.min(s.attachRetries - 1, 4)),
    ATTACH_RETRY_MAX_MS
  );
  s.attachRetryTimer = setTimeout(function () {
    s.attachRetryTimer = null;
    if (s.disposed || s.id !== activeId || s.readOnly) return;
    attachSession(s, false);
  }, delay);
}

function clearAttachRetry(s) {
  if (s.attachRetryTimer) {
    clearTimeout(s.attachRetryTimer);
    s.attachRetryTimer = null;
  }
}

// SSE 仍在投递增量时不要并发兜底轮询：轮询响应从请求发起时的游标取，等待期间
// SSE 已经渲染过的块会重复写进 xterm，写队列被撑大后按键回显只能排在后面。
const POLL_SSE_ACTIVE_MS = 2000;

function startPolling(s) {
  if (s.pollTimer || s.disposed) return;
  s.pollTimer = setInterval(function () {
    if (s.id !== activeId) return;
    if (Date.now() - s.lastEventAt < POLL_SSE_ACTIVE_MS) return;
    pollSession(s);
  }, 1000);
}

function stopPolling(s) {
  if (s.pollTimer) {
    clearInterval(s.pollTimer);
    s.pollTimer = null;
  }
}

async function pollSession(s) {
  if (s.polling || s.disposed || !deps.wsId) return;
  s.polling = true;
  try {
    const out = await api.terminalOutput(deps.wsId, s.id, s.nextAfter, 262144);
    applyOutput(s, out);
  } catch (e) {
    const code = api.httpStatus(e);
    if (code === 404) {
      s.state = "exited";
      s.attached = false;
      s.lastError = _t("会话已失效");
      stopPolling(s);
      stopHeartbeat(s);
    } else if (deps.onError) {
      deps.onError(e);
    }
    if (deps.onUpdate) deps.onUpdate();
  } finally {
    s.polling = false;
  }
}

async function backfill(s) {
  try {
    // SSE may already have written a few chunks while xterm was loading.
    // Reset and repaint from seq 0 so the scrollback is complete and not
    // duplicated.
    try { s.term.reset(); } catch (_) {}
    s.nextAfter = 0;
    const out = await api.terminalOutput(deps.wsId, s.id, 0, 1 << 20);
    applyOutput(s, out);
  } catch (e) {
    if (api.httpStatus(e) === 404) {
      s.state = "exited";
      s.lastError = _t("会话已失效");
    } else if (deps.onError) {
      deps.onError(e);
    }
  }
}

function applyOutput(s, out) {
  if (!out || s.disposed) return;
  if (out.truncated) {
    try { s.term.reset(); } catch (_) {}
    s.nextAfter = Math.max(0, Number(out.first_seq || 1) - 1);
  }
  const chunks = Array.isArray(out.chunks) ? out.chunks : [];
  for (const c of chunks) {
    const seq = Number(c && c.seq);
    // 轮询从请求发起时的游标取增量，等待响应期间 SSE 可能已经渲染过其中一部分：
    // seq <= 当前游标的块必须跳过，否则同一段输出会被写两遍。
    if (seq > 0 && seq <= s.nextAfter) continue;
    writeChunk(s, c);
    if (seq > 0) s.nextAfter = seq;
  }
  // 游标只进不退：过期响应不能把它拉回去，否则后续 SSE 块会被当成重复块丢弃。
  if (out.next_after !== undefined && out.next_after !== null) {
    s.nextAfter = Math.max(s.nextAfter, Number(out.next_after) || 0);
  }
  s.state = out.state || s.state;
  s.exitCode = out.exit_code === undefined ? s.exitCode : out.exit_code;
  if (deps.onUpdate) deps.onUpdate();
}

let badTerminalEventLogged = false;

// 输出块解码后写进 xterm。
function writeChunk(s, chunk) {
  if (!chunk || !s.term) return;
  try {
    let bytes;
    if (chunk.encoding === "base64") {
      bytes = base64ToBytes(chunk.data || "");
    } else {
      bytes = new TextEncoder().encode(String(chunk.data || ""));
    }
    if (bytes.length) {
      // 回显块额外量一下 xterm 解析耗时：回显已到达但绘制排队时，
      // input_to_echo 正常而体感卡，这一项能把两部分区分开。
      const measure = !!(s.latency && s.latency.sentAt);
      const started = performance.now();
      s.term.write(bytes, measure ? function () {
        noteParsed(s.latency, performance.now() - started);
      } : undefined);
    }
  } catch (_) {}
}

export function handleEvent(evt) {
  // Tauri 的 listen 回调是 { event, id, payload }，agent-sse-event 的 payload 才是
  // 服务端信封 { type, data, workspace_id }（与 agent/sse.js、projects/ui.js 一致）。
  const payload = evt && evt.payload;
  if (!payload || !payload.data) return;
  if (payload.workspace_id !== deps.wsId) return;
  const env = payload.data;
  if (env.type !== "terminal_event") return;
  // 服务端 `wrapEvent` 对终端事件同样套了 pubsub.Event 信封：
  // data = {type:"terminal_event", payload:{type:"updated", payload: proto.TerminalEvent}}。
  // 只读一层 `env.payload` 拿到的是信封而不是事件本体，`terminal_id` 为
  // undefined，整条事件会被静默丢弃——回显只能等 1s 兜底轮询（打字明显变慢）。
  // 这里两层都接受，服务端将来拍平信封也不会再退化。
  const envelope = env.payload || {};
  const p = envelope.payload || envelope;
  if (!p.terminal_id) {
    // 信封层级再变时别再静默丢光事件：打一行日志就够定位。
    if (!badTerminalEventLogged) {
      badTerminalEventLogged = true;
      terminalLog("terminal_event ignored: missing terminal_id (envelope shape changed?)");
    }
    return;
  }
  const s = sessions.get(p.terminal_id);
  if (!s || s.disposed) return;
  if (p.event === "output" && p.chunk) {
    if (p.chunk.seq <= s.nextAfter) return;
    if (p.chunk.seq > s.nextAfter + 1) {
      pollSession(s);
      return;
    }
    writeChunk(s, p.chunk);
    s.nextAfter = p.chunk.seq;
    s.lastEventAt = Date.now();
    noteEcho(s.latency, performance.now());
    // 高频输出可能在一个渲染帧内到达多块：用 rAF 合并成一次视图 render，
    // 避免每块都同步跑一遍 render() 与状态栏 DOM 更新。
    scheduleUpdate(s);
    return;
  }
  if (p.event === "state") {
    s.state = p.state || s.state;
    if (p.exit_code !== undefined) s.exitCode = p.exit_code;
    if (p.state === "disconnected" || p.state === "exited") {
      s.attached = false;
      stopHeartbeat(s);
    }
    if (deps.onUpdate) deps.onUpdate();
  }
}

// 回显只更新“状态栏/列表”这类附属 DOM，没必要每 16ms 跟着输出块全量 render 一次：
// 整页 render 跑在主线程上，和按键处理、IPC 回调抢同一帧，高频输出时会直接
// 表现为打字延迟。限流到人眼够用的频率即可。
const RENDER_MIN_INTERVAL_MS = 120;

function scheduleUpdate(s) {
  if (s.updateScheduled || s.disposed) return;
  s.updateScheduled = true;
  const wait = RENDER_MIN_INTERVAL_MS - (Date.now() - s.lastRenderAt);
  setTimeout(function () {
    requestAnimationFrame(function () {
      s.updateScheduled = false;
      if (s.disposed) return;
      s.lastRenderAt = Date.now();
      if (deps.onUpdate) deps.onUpdate();
    });
  }, wait > 0 ? wait : 0);
}

function scheduleResize(s, cols, rows) {
  if (s.disposed || s.readOnly || !s.attached || !deps.wsId) return;
  if (!cols || !rows) return;
  clearTimeout(s.resizeTimer);
  s.resizeTimer = setTimeout(function () {
    api.resizeTerminal(deps.wsId, s.id, {
      client_id: deps.clientId,
      cols: cols,
      rows: rows,
    }).catch(function (e) {
      const code = api.httpStatus(e);
      if (code === 409) {
        s.readOnly = true;
        if (deps.onUpdate) deps.onUpdate();
      } else if (code !== 404 && deps.onError) {
        deps.onError(e);
      }
    });
  }, 100);
}

function flushInput(s) {
  if (s.inputInFlight || !s.pendingInput || s.readOnly || !s.attached || !deps.wsId) return;
  const chunk = takeInputChunk(s.pendingInput);
  s.pendingInput = s.pendingInput.slice(chunk.length);
  s.inputInFlight = true;
  noteSent(s.latency, performance.now());
  api.inputTerminal(deps.wsId, s.id, {
    client_id: deps.clientId,
    encoding: "base64",
    data: bytesToBase64(new TextEncoder().encode(chunk)),
  }).then(function () {
    s.inputInFlight = false;
    s.inputRetries = 0;
    if (!s.pendingInput) s.inputOverflowed = false;
    if (s.pendingInput) flushInput(s);
  }).catch(function (e) {
    s.inputInFlight = false;
    const code = api.httpStatus(e);
    if (code === 409) {
      s.readOnly = true;
      if (deps.onUpdate) deps.onUpdate();
      return;
    }
    // 404 说明会话已经不存在，重试没有意义；其余错误（429 输入积压、
    // 5xx、网络抖动）都保留数据退避重试，不能静默丢掉已键入的按键。
    if (code !== 404 && s.inputRetries < 5) {
      s.inputRetries++;
      s.pendingInput = chunk + s.pendingInput;
      setTimeout(function () { flushInput(s); }, 200 * s.inputRetries);
      return;
    }
    s.inputRetries = 0;
    if (deps.onError) deps.onError(e);
  });
}

function takeInputChunk(text) {
  // 15k chars is <= 60 KiB even for 4-byte code points. 切片按 UTF-16 单元，
  // 切点落在高代理上会把代理对拆开（孤立代理被 TextEncoder 编码成 U+FFFD），
  // 粘贴长文本时该字符会变成乱码，所以回退一个单元。
  if (text.length <= 15000) return text;
  let cut = 15000;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

// attach 失败期间按键全部堆在 pendingInput 里：给它一个上限，超过时丢最旧的
// 数据并提示一次（无上限时长时间不可用会把内存吃光，且永远不会被发送）。
const PENDING_INPUT_MAX = 64 * 1024;

function trimPendingInput(s) {
  if (s.pendingInput.length <= PENDING_INPUT_MAX) return;
  let start = s.pendingInput.length - PENDING_INPUT_MAX;
  const first = s.pendingInput.charCodeAt(start);
  // 保留段从低代理开头时再丢一个单元，避免自己制造孤立代理。
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  s.pendingInput = s.pendingInput.slice(start);
  if (s.inputOverflowed) return;
  s.inputOverflowed = true;
  if (deps.onError) deps.onError(new Error(_t("输入积压，已丢弃最旧的按键")));
}

// 输入延迟打点的采集与聚合在 latency.js（可单独验证），这里只负责把
// 结果写成 tigerAgent_debug.log 里的 UI: [TERM][info] 行。直接走全局 invoke：
// 终端视图不依赖 agent 视图的 log 开关状态，写不写由 Rust 端 debug_logging
// 开关决定（关闭时只多一次空操作调用）。
export function terminalLog(message) {
  const invoke = window.__agent_invoke;
  if (!invoke) return;
  invoke("agent_debug_log", { line: "[TERM][info] " + message }).catch(function () {});
}

export async function takeover(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.readOnly = false;
  await attachSession(s, true);
  if (s.term) {
    try { s.term.focus(); } catch (_) {}
  }
}

export function release(id) {
  const s = sessions.get(id);
  if (!s || !deps.wsId) return;
  if (s.attached) {
    api.releaseTerminal(deps.wsId, s.id, deps.clientId).catch(function () {});
  }
  s.attached = false;
}

export function dispose(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.disposed = true;
  stopPolling(s);
  stopHeartbeat(s);
  clearAttachRetry(s);
  clearTimeout(s.resizeTimer);
  release(id);
  if (s.observer) {
    try { s.observer.disconnect(); } catch (_) {}
  }
  if (s.term) {
    try { s.term.dispose(); } catch (_) {}
  }
  if (s.el && s.el.parentNode) s.el.parentNode.removeChild(s.el);
  sessions.delete(id);
  if (activeId === id) activeId = "";
}

export function disposeAll() {
  Array.from(sessions.keys()).forEach(dispose);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text || "");
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
