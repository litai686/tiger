// 终端输入延迟打点（客户端侧）。只做统计，不改变输入行为。
//
// 三段耗时：
//   queue       按键入队 → 输入 POST 真正发出（输入单飞队列的等待）
//   inputToEcho POST 发出 → 首个 SSE 回显块到达（网络往返 + Tauri IPC + Rust HTTP/SSE）
//   xtermParse  回显块交给 xterm → 解析完成（渲染排队）
//
// 与服务端 `TIGERAGENT_TERMINAL_LATENCY=1` 的 input_to_echo / echo_to_event
// 配合使用；含义与实测数字见 docs/terminal-management-plan.md §17。
// 这里不依赖 DOM/窗口，便于单独验证；日志由调用方注入（终端视图写
// tigerAgent_debug.log 的 `UI: [TERM][info]` 行）。

const LOG_INTERVAL_MS = 5000;
const MAX_SAMPLES = 200;
const STALE_MS = 5000;

export function createProbe(logFn) {
  return {
    log: logFn,
    queuedAt: 0,
    sentAt: 0,
    sent: 0,
    samples: [],
    queueDelays: [],
    parseDurations: [],
    lastLog: 0,
  };
}

// noteQueued records the first key of a burst. Keys typed while a request is
// in flight keep the original timestamp so `queue` covers the whole wait.
export function noteQueued(p, now) {
  if (!p) return;
  // 上一次输入始终没有回显（程序不回显或窗口失焦）时不要一直挡住后续采样。
  if (p.sentAt && now - p.sentAt > STALE_MS) p.sentAt = 0;
  if (p.queuedAt || p.sentAt) return;
  p.queuedAt = now;
}

// noteSent runs when the queued chunk actually goes out. It also triggers the
// summary so a session whose echo never arrives still produces a line
// (`sent=N` with `echo n=0`) instead of looking silent.
export function noteSent(p, now) {
  if (!p) return;
  if (p.queuedAt) {
    pushBounded(p.queueDelays, now - p.queuedAt);
    p.queuedAt = 0;
  }
  p.sentAt = now;
  p.sent += 1;
  maybeLog(p, now);
}

export function noteEcho(p, now) {
  if (!p || !p.sentAt) return;
  const delta = now - p.sentAt;
  p.sentAt = 0;
  if (delta < 0 || delta > STALE_MS) return;
  pushBounded(p.samples, delta);
  maybeLog(p, now);
}

export function noteParsed(p, duration) {
  if (!p || duration < 0 || duration > STALE_MS) return;
  pushBounded(p.parseDurations, duration);
}

function maybeLog(p, now) {
  if (!p.sent && !p.samples.length) return;
  const due = now - p.lastLog >= LOG_INTERVAL_MS;
  if (!due && p.samples.length < 20) return;
  p.lastLog = now;
  p.log("input_to_echo " + format(p.samples) +
    " queue " + format(p.queueDelays) +
    " xterm_parse " + format(p.parseDurations) +
    " sent=" + p.sent);
  p.sent = 0;
  p.samples = [];
  p.queueDelays = [];
  p.parseDurations = [];
}

function pushBounded(list, value) {
  if (list.length >= MAX_SAMPLES) return;
  list.push(value);
}

function format(samples) {
  if (!samples.length) return "n=0";
  const sorted = samples.slice().sort(function (a, b) { return a - b; });
  let sum = 0;
  sorted.forEach(function (v) { sum += v; });
  return "n=" + sorted.length +
    " avg=" + ms(sum / sorted.length) +
    " p50=" + ms(percentile(sorted, 50)) +
    " p95=" + ms(percentile(sorted, 95)) +
    " max=" + ms(sorted[sorted.length - 1]);
}

function percentile(sorted, p) {
  let idx = Math.ceil((sorted.length * p) / 100) - 1;
  if (idx < 0) idx = 0;
  if (idx >= sorted.length) idx = sorted.length - 1;
  return sorted[idx];
}

function ms(value) {
  return value.toFixed(2) + "ms";
}
