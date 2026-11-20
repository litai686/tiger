#!/usr/bin/env bash
# 一键部署 tigerAgent 服务端（Linux / macOS，全部装在当前用户目录）：
#   1. 按当前系统的 OS + 架构挑选 Release 中的 *_server 产物
#      （官方只发布 Linux x86_64、macOS x86_64 / arm64，其余组合直接报错）
#   2. 从 GitHub Release 解析最新（或指定）版本；已安装同一版本时跳过下载，直接重启
#      （不落安装记录 / PID / nohup 日志等额外文件，重启时按进程命令行匹配旧实例）
#   3. 否则下载并用 checksums.txt 校验 sha256、解压到临时目录
#   4. 再次安装：先停掉正在运行的服务端（SIGTERM → 超时 SIGKILL），再覆盖 ~/.local/bin 下的二进制
#   5. 准备数据目录，用 nohup 后台启动；启动后在终端回显服务端自己打印的管理界面地址 / 指纹 / token / 连接串，并做健康检查
#
# 用法：在仓库根执行 bash desktop/install-server.sh（或在 desktop/ 下执行 bash install-server.sh）
#      重复执行即为升级：先停旧实例、覆盖二进制，再启动新实例；版本未变也照样重启。
#
# 环境变量（括号内为默认值）：
#   TIGER_REPO          GitHub 仓库（litai686/tiger）
#   TIGER_VERSION       latest 或指定版本 / 标签，如 0.0.1、v0.0.1（latest）
#   TIGER_HOST          监听地址（tcp://:6464，host 留空 = IPv4 + IPv6 双栈）
#   TIGER_INSTALL_DIR   二进制安装目录（$HOME/.local/bin）
#   TIGER_DATA_DIR      数据目录（${XDG_DATA_HOME:-$HOME/.local/share}/tigerAgent/data）
#   TIGER_NO_START=1    只安装、不启动
#   TIGER_DEBUG=1       服务端以 --debug 启动
#   TIGER_FORCE=1       忽略安装记录，强制重新下载
#   GITHUB_TOKEN        可选；GitHub API 限流时提升额度
set -euo pipefail

REPO="${TIGER_REPO:-litai686/tiger}"
WANT_VERSION="${TIGER_VERSION:-latest}"
TIGER_HOST="${TIGER_HOST:-tcp://:6464}"
NO_START="${TIGER_NO_START:-0}"
DEBUG_FLAG="${TIGER_DEBUG:-0}"
FORCE_INSTALL="${TIGER_FORCE:-0}"

log() { printf '==> %s\n' "$*" >&2; }
warn() { printf '警告: %s\n' "$*" >&2; }
die() { printf '错误: %s\n' "$*" >&2; exit 1; }

# ---------- 基础环境 ----------
[ -n "${HOME:-}" ] || die "HOME 未设置，无法确定用户目录；请先导出 HOME"

TIGER_INSTALL_DIR="${TIGER_INSTALL_DIR:-$HOME/.local/bin}"
TIGER_DATA_DIR="${TIGER_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/tigerAgent/data}"
BIN_PATH="$TIGER_INSTALL_DIR/tigerAgent"

if command -v curl >/dev/null 2>&1; then
  HTTP_TOOL=curl
elif command -v wget >/dev/null 2>&1; then
  HTTP_TOOL=wget
else
  die "需要 curl 或 wget 之一下载 Release"
fi

command -v tar >/dev/null 2>&1 || die "需要 tar 解压 Release 产物"

if command -v sha256sum >/dev/null 2>&1; then
  SHA_TOOL=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  SHA_TOOL=shasum
elif command -v openssl >/dev/null 2>&1; then
  SHA_TOOL=openssl
else
  die "需要 sha256sum / shasum / openssl 之一校验下载产物"
fi

sha256_of() {
  case "$SHA_TOOL" in
    sha256sum) sha256sum "$1" | awk '{print $1}' ;;
    shasum) shasum -a 256 "$1" | awk '{print $1}' ;;
    openssl) openssl dgst -sha256 "$1" | sed 's/^.*= //' ;;
  esac
}

# 已安装二进制的版本号（CI 产物形如 0.0.1-<commit>；旧版本输出带 "tigerAgent version " 前缀）。
installed_bin_version() {
  "$BIN_PATH" --version 2>/dev/null | tail -n 1 | awk '{print $NF}'
}

# Release 版本是 0.0.1 时，0.0.1 / 0.0.1-<commit> 都算同一个版本。
version_matches() {
  [ "$1" = "$2" ] && return 0
  case "$1" in
    "$2"-*) return 0 ;;
  esac
  return 1
}

http_get() {
  if [ "$HTTP_TOOL" = curl ]; then
    if [ -n "${GITHUB_TOKEN:-}" ]; then
      curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" "$1"
    else
      curl -fsSL "$1"
    fi
  else
    wget -qO- "$1"
  fi
}

# 把 GitHub 的 /releases/latest 302 跟随到最终 URL，作为 API 被限流时的兜底。
http_final_url() {
  if [ "$HTTP_TOOL" = curl ]; then
    curl -fsSIL -o /dev/null -w '%{url_effective}' "$1" 2>/dev/null
  else
    wget -S --spider "$1" 2>&1 | awk 'tolower($1) == "location:" {print $2}' | tail -n 1
  fi
}

download_file() {
  if [ "$HTTP_TOOL" = curl ]; then
    curl -fL --retry 3 --connect-timeout 20 -o "$2" "$1"
  else
    wget -q --tries=3 -O "$2" "$1"
  fi
}

# ---------- 平台识别 ----------
OS_RAW="$(uname -s)"
case "$OS_RAW" in
  Linux) OS_NAME=Linux ;;
  Darwin) OS_NAME=Darwin ;;
  *) die "不支持的运行环境 $OS_RAW：官方 Release 只提供 Linux 与 macOS 服务端产物（Windows 请用 PowerShell 安装桌面端/手动解压 zip）" ;;
esac

ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64) ARCH_NAME=x86_64 ;;
  arm64|aarch64) ARCH_NAME=arm64 ;;
  *) die "不支持的 CPU 架构 $ARCH_RAW：官方 Release 只提供 x86_64 / arm64" ;;
esac

if [ "$OS_NAME" = Linux ] && [ "$ARCH_NAME" = arm64 ]; then
  die "官方 Release 未发布 Linux arm64 服务端产物（CI 只构建 Linux x86_64、macOS x86_64/arm64）"
fi

log "系统识别：${OS_NAME}_${ARCH_NAME}"

# ---------- 版本解析 ----------
if [ "$WANT_VERSION" = latest ]; then
  log "查询 ${REPO} 的最新 Release"
  TAG=""
  API_JSON="$(http_get "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)"
  if [ -n "$API_JSON" ]; then
    TAG="$(printf '%s' "$API_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  fi
  if [ -z "$TAG" ]; then
    FINAL_URL="$(http_final_url "https://github.com/${REPO}/releases/latest" || true)"
    case "$FINAL_URL" in
      */tag/*) TAG="${FINAL_URL##*/tag/}" ;;
    esac
  fi
  [ -n "$TAG" ] || die "无法解析最新 Release 标签：GitHub API 可能被限流，可设置 GITHUB_TOKEN 后重试，或用 TIGER_VERSION=0.0.1 指定版本"
else
  TAG="v${WANT_VERSION#v}"
fi

VERSION="${TAG#v}"
ASSET="tigerAgent_${VERSION}_${OS_NAME}_${ARCH_NAME}_server.tar.gz"
BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"

log "目标版本：${TAG}，产物：${ASSET}"

# ---------- 是否已安装同版本 ----------
# 不写安装记录文件：直接读已安装二进制的 --version 判断，命中就跳过下载。
NEED_INSTALL=1
if [ "$FORCE_INSTALL" = "1" ]; then
  log "TIGER_FORCE=1，强制重新下载安装"
elif [ -x "$BIN_PATH" ]; then
  INSTALLED_VERSION="$(installed_bin_version)"
  if [ -n "$INSTALLED_VERSION" ] && version_matches "$INSTALLED_VERSION" "$VERSION"; then
    NEED_INSTALL=0
    log "已安装 ${VERSION}（$BIN_PATH），跳过下载"
  fi
fi

# ---------- 停止旧实例（再次安装 = 停旧进程 → 覆盖二进制 → 重启） ----------
# 不落 PID 文件：用 ps 的命令行匹配上次启动的服务端进程，覆盖二进制前先停掉它。
APP_LOG="$HOME/.cache/tigerAgent/tigerAgent.log"

show_log_tail() {
  if [ -f "$APP_LOG" ]; then
    tail -n 30 "$APP_LOG" >&2 2>&1 || true
  fi
}

find_running_pids() {
  # 只认本服务端的实例，避免误伤别的程序：命令行以 $BIN_PATH 开头（本脚本启动 /
  # 手动绝对路径启动，安装路径含空格也能认），或 basename 是 tigerAgent（通过 PATH /
  # 相对路径 / 软链启动）；再看参数：--host / --data-dir 与本脚本一致，或完全没带
  # 这两项（默认实例）。同一二进制的其他实例（不同端口 / 数据目录）不动；任意位置
  # 出现子命令（dirs / stats / session / eval 等，持久 flag 可写在子命令前）或
  # --version / --rotate-token 等立即退出的调用，也不动。
  ps -A -o pid=,args= 2>/dev/null |
    awk -v bin="$BIN_PATH" \
        -v host_arg="--host $TIGER_HOST" -v host_eq="--host=$TIGER_HOST" \
        -v short_host_arg="-H $TIGER_HOST" -v short_host_eq="-H=$TIGER_HOST" \
        -v data_arg="--data-dir $TIGER_DATA_DIR" -v data_eq="--data-dir=$TIGER_DATA_DIR" \
        -v short_data_arg="-D $TIGER_DATA_DIR" -v short_data_eq="-D=$TIGER_DATA_DIR" '
      {
        pid = $1
        sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", $0)
        sub(/[[:space:]]+$/, "", $0)
        if ($0 == "") next
        n = split($0, tok, /[[:space:]]+/)
        # 持久 flag 可以写在子命令前（tigerAgent -c DIR eval），任意位置的子命令都要跳过。
        for (i = 2; i <= n; i++)
          if (tok[i] ~ /^(dirs|projects|logs|schema|stats|session|sessions|s|eval)$/) next
        # 打印 / 轮换后立即退出的命令不是常驻服务端，不杀（避免打断并发的 rotate-token 等操作）。
        if ($0 ~ / --version( |$)| --help( |$)| --print-connection( |$)| --print-fingerprint( |$)| --rotate-token( |$)/) next
        # ps 不转义空格：先按完整路径前缀判断，兼容安装路径含空格。
        if (index($0, bin) != 1) {
          base = tok[1]
          sub(/^.*\//, "", base)
          if (base != "tigerAgent") next
        }
        if (index($0, host_arg) > 0 || index($0, host_eq) > 0 ||
            index($0, short_host_arg) > 0 || index($0, short_host_eq) > 0 ||
            index($0, data_arg) > 0 || index($0, data_eq) > 0 ||
            index($0, short_data_arg) > 0 || index($0, short_data_eq) > 0) { print pid; next }
        # 显式指定了其他 host / 数据目录 = 另一个实例，保留。
        if ($0 ~ / -H | -H=| --host| -D | -D=| --data-dir/) next
        print pid
      }'
}

stop_running() {
  PIDS="$(find_running_pids || true)"
  [ -n "$PIDS" ] || return 0
  log "停止正在运行的服务端进程：$(printf '%s ' $PIDS)"
  for p in $PIDS; do
    kill "$p" 2>/dev/null || true
  done
  WAIT=0
  while [ "$WAIT" -lt 40 ]; do
    STILL=""
    for p in $PIDS; do
      if kill -0 "$p" 2>/dev/null; then
        STILL=1
        break
      fi
    done
    [ -z "$STILL" ] && return 0
    sleep 0.5
    WAIT=$((WAIT + 1))
  done
  warn "旧进程 20 秒内未退出，强制终止"
  for p in $PIDS; do
    kill -9 "$p" 2>/dev/null || true
  done
  WAIT=0
  while [ "$WAIT" -lt 4 ]; do
    STILL=""
    for p in $PIDS; do
      if kill -0 "$p" 2>/dev/null; then
        STILL=1
        break
      fi
    done
    [ -z "$STILL" ] && return 0
    sleep 0.5
    WAIT=$((WAIT + 1))
  done
  warn "仍有旧进程在运行（可能属于其他用户），如端口被占用请手动结束后重试"
}

# ---------- 下载、校验与安装 ----------
TMPDIR_INSTALL="$(mktemp -d 2>/dev/null || mktemp -d -t tigerAgent)"
cleanup() { rm -rf "$TMPDIR_INSTALL"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$NEED_INSTALL" = "1" ]; then
  log "下载 ${BASE_URL}/${ASSET}"
  download_file "${BASE_URL}/${ASSET}" "$TMPDIR_INSTALL/$ASSET" \
    || die "下载失败：${BASE_URL}/${ASSET}（该版本可能没有 ${OS_NAME}_${ARCH_NAME} 产物）"
  download_file "${BASE_URL}/checksums.txt" "$TMPDIR_INSTALL/checksums.txt" \
    || die "下载 checksums.txt 失败：${BASE_URL}/checksums.txt"

  EXPECTED="$(awk -v name="$ASSET" '$2 == name { print $1; exit }' "$TMPDIR_INSTALL/checksums.txt")"
  [ -n "$EXPECTED" ] || die "checksums.txt 中没有 $ASSET 的校验值"
  ACTUAL="$(sha256_of "$TMPDIR_INSTALL/$ASSET")"
  [ "$ACTUAL" = "$EXPECTED" ] || die "sha256 校验失败：期望 $EXPECTED，实际 $ACTUAL"
  log "sha256 校验通过"

  mkdir -p "$TMPDIR_INSTALL/extract"
  tar -xzf "$TMPDIR_INSTALL/$ASSET" -C "$TMPDIR_INSTALL/extract" || die "解压 ${ASSET} 失败"
  SRC_BIN="$(find "$TMPDIR_INSTALL/extract" -type f -name tigerAgent | head -n 1 || true)"
  [ -n "$SRC_BIN" ] || die "压缩包中未找到 tigerAgent 可执行文件"

  mkdir -p "$TIGER_INSTALL_DIR" || die "无法创建安装目录 $TIGER_INSTALL_DIR"
  # 先写临时文件再 rename：服务正在运行时也能安全替换（避免 ETXTBSY）。
  cp "$SRC_BIN" "$TIGER_INSTALL_DIR/.tigerAgent.new.$$"
  chmod 0755 "$TIGER_INSTALL_DIR/.tigerAgent.new.$$"
  # 再次安装 / 升级：覆盖二进制前先停掉旧实例（TIGER_NO_START=1 只装不启动，不动已运行的进程）。
  if [ "$NO_START" != "1" ]; then
    stop_running
  fi
  mv -f "$TIGER_INSTALL_DIR/.tigerAgent.new.$$" "$BIN_PATH"
  log "已安装 $BIN_PATH"
fi

[ -x "$BIN_PATH" ] || die "$BIN_PATH 不可执行（可设 TIGER_FORCE=1 重新安装）"

INSTALLED_VERSION="$(installed_bin_version)"
if [ -n "$INSTALLED_VERSION" ]; then
  log "版本：$INSTALLED_VERSION"
fi

case ":$PATH:" in
  *":$TIGER_INSTALL_DIR:"*) ;;
  *) warn "$TIGER_INSTALL_DIR 不在 PATH 中，后续命令请用绝对路径 $BIN_PATH" ;;
esac

# ---------- 初始化数据目录与身份 ----------
mkdir -p "$TIGER_DATA_DIR"
chmod 0700 "$TIGER_DATA_DIR" 2>/dev/null || true

SERVER_ARGS=(--host "$TIGER_HOST" --data-dir "$TIGER_DATA_DIR")
if [ "$DEBUG_FLAG" = "1" ]; then
  SERVER_ARGS+=(--debug)
fi

CONN_STR=""
ADMIN_INFO=""
CONN_ERR="$TMPDIR_INSTALL/print-connection.err"
STARTUP_LOG="$TMPDIR_INSTALL/tigerAgent-startup.log"
case "$TIGER_HOST" in
  tcp://*)
    # 正常启动时由服务端自己打印连接串 / 管理地址 / 指纹 / token（捕获后输出到终端）；
    # 只有 TIGER_NO_START=1 才需要在这里用 --print-connection 初始化并打印。
    if [ "$NO_START" = "1" ]; then
      log "初始化 TLS 身份与 Bearer token（仅打印，不启动）"
      if ! CONN_STR="$("$BIN_PATH" "${SERVER_ARGS[@]}" --print-connection 2>"$CONN_ERR")"; then
        CONN_STR=""
        warn "--print-connection 失败"
        sed 's/^/  /' "$CONN_ERR" >&2 || true
      fi
      ADMIN_INFO="$(cat "$CONN_ERR" 2>/dev/null || true)"
    fi
    ;;
  *)
    warn "TIGER_HOST=$TIGER_HOST 不是 tcp://，连接串与健康检查将跳过（unix/npipe 依赖本机权限）"
    ;;
esac

# ---------- nohup 后台启动 ----------
# 不落 nohup 日志（服务端自己写 $HOME/.cache/tigerAgent/tigerAgent.log），也不落 PID 文件：
# 重启时按命令行匹配本脚本启动的进程（见上面的 find_running_pids / stop_running）。
start_nohup() {
  # 旧实例已在覆盖二进制前停掉；这里兜底再停一次（同版本重装或极端情况下残留的实例）。
  stop_running
  # 捕获启动时写到 stderr 的连接串 / 管理地址 / 指纹 / token，健康检查后回显到终端；
  # 文件在临时目录内，脚本退出即删除（不落持久日志）。
  : > "$STARTUP_LOG"
  nohup "$BIN_PATH" "${SERVER_ARGS[@]}" >"$STARTUP_LOG" 2>&1 &
  NEW_PID=$!
  sleep 0.5
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    if [ -s "$STARTUP_LOG" ]; then
      sed 's/^/  /' "$STARTUP_LOG" >&2 || true
    fi
    show_log_tail
    die "后台进程启动后立即退出（应用日志：$APP_LOG）"
  fi
  log "已后台启动（PID $NEW_PID）"
}

if [ "$NO_START" = "1" ]; then
  log "TIGER_NO_START=1，跳过启动"
else
  start_nohup
fi

# ---------- 健康检查 ----------
HEALTH_PORT=""
case "$TIGER_HOST" in
  tcp://*)
    HOSTPORT="${TIGER_HOST#tcp://}"
    HEALTH_PORT="${HOSTPORT##*:}"
    ;;
esac
case "$HEALTH_PORT" in
  ''|*[!0-9]*) HEALTH_PORT="" ;;
esac

if [ -n "$HEALTH_PORT" ] && [ "$NO_START" != "1" ]; then
  if command -v curl >/dev/null 2>&1; then
    log "等待 https://127.0.0.1:${HEALTH_PORT}/v1/health 就绪"
    HEALTHY=0
    TRIES=0
    while [ "$TRIES" -lt 30 ]; do
      if curl -fsSk --max-time 2 "https://127.0.0.1:${HEALTH_PORT}/v1/health" >/dev/null 2>&1; then
        HEALTHY=1
        break
      fi
      TRIES=$((TRIES + 1))
      sleep 0.5
    done
    if [ "$HEALTHY" -ne 1 ]; then
      if [ -s "$STARTUP_LOG" ]; then
        sed 's/^/  /' "$STARTUP_LOG" >&2 || true
      fi
      show_log_tail
      die "健康检查失败：https://127.0.0.1:${HEALTH_PORT}/v1/health 无响应（端口被占用或启动参数错误，应用日志：$APP_LOG）"
    fi
    log "健康检查通过"
  else
    warn "未找到 curl，跳过健康检查"
  fi
fi

# 回显服务端启动时自己打印的信息（管理界面地址 / 指纹 / token / 连接串）。
if [ "$NO_START" != "1" ] && [ -s "$STARTUP_LOG" ]; then
  printf '\n服务端启动输出：\n'
  sed 's/^/  /' "$STARTUP_LOG"
  CONN_STR="$(grep -m1 '^tigerAgent://' "$STARTUP_LOG" || true)"
fi

# ---------- 结果 ----------
printf '\n'
printf 'tigerAgent 服务端部署完成\n'
printf '  版本:     %s\n' "$TAG"
printf '  二进制:   %s\n' "$BIN_PATH"
printf '  数据目录: %s\n' "$TIGER_DATA_DIR"
printf '  监听:     %s\n' "$TIGER_HOST"
if [ "$NO_START" = "1" ]; then
  printf '  启动方式: 未启动（TIGER_NO_START=1）\n'
  printf '  手动启动: %s --host %s --data-dir %s\n' "$BIN_PATH" "$TIGER_HOST" "$TIGER_DATA_DIR"
else
  printf '  启动方式: nohup 后台进程\n'
  printf '  应用日志: %s\n' "$APP_LOG"
fi
if [ -n "$CONN_STR" ]; then
  printf '  连接串:   %s\n' "$CONN_STR"
  printf '            （含 token，请勿外传；桌面端粘贴到「设置 → 服务端连接」）\n'
fi
if [ "$NO_START" = "1" ] && [ -n "$ADMIN_INFO" ]; then
  printf '%s\n' "$ADMIN_INFO" | sed 's/^/  /'
fi
printf '  配置文件: %s（首次启动生成，改完 provider/模型后重启服务）\n' "$TIGER_DATA_DIR/tigerAgent.json"
printf '  轮换token: %s --rotate-token --host %s --data-dir %s\n' "$BIN_PATH" "$TIGER_HOST" "$TIGER_DATA_DIR"

if [ "$(id -u)" -eq 0 ]; then
  printf '\n'
  warn "当前以 root 用户部署，服务端派生的命令也将以 root 执行；建议改用普通用户运行"
fi
