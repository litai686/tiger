#!/usr/bin/env bash
# 一键部署 tigerAgent 服务端并交由 systemd 常驻管理（仅 Linux；macOS 没有 systemd，请用 install-server.sh）：
#   1. 与 install-server.sh 相同的 Release 逻辑：按 OS / 架构取 *_server 产物，校验 sha256 后解压安装
#   2. 生成 systemd unit 并 enable --now，保证系统重启后自动拉起：
#      - 普通用户执行 → 用户级单元（~/.config/systemd/user/tigerAgent.service，systemctl --user），
#        并强制开启 loginctl enable-linger（失败则报错），未登录 / 重启后也自动运行
#      - root 执行     → 系统级单元（/etc/systemd/system/tigerAgent.service），
#        默认以 sudo 调用者身份运行（TIGER_SERVICE_USER 可覆盖）
#   3. 重跑即升级：先准备新二进制并重写 unit（任一步失败都不动正在运行的旧实例），
#      最后才停旧单元（含迁移前的用户级单元）与 install-server.sh 留下的 nohup 进程并重启；版本未变也照样重启
#   4. 从 journal 回显管理界面地址 / 指纹 / token / 连接串，并做 /v1/health 健康检查
#
# 用法：在仓库根执行 bash desktop/install-server-systemd.sh
#       sudo bash desktop/install-server-systemd.sh   # 装成系统级服务（服务器长期运行推荐）
#
# 环境变量（括号内为默认值）：
#   TIGER_REPO          GitHub 仓库（litai686/tiger）
#   TIGER_VERSION       latest 或指定版本 / 标签，如 0.0.1、v0.0.1（latest）
#   TIGER_HOST          监听地址（tcp://:6464，host 留空 = IPv4 + IPv6 双栈）
#   TIGER_INSTALL_DIR   二进制安装目录（用户级 $HOME/.local/bin；系统级 /usr/local/bin）
#   TIGER_DATA_DIR      数据目录（用户级 ${XDG_DATA_HOME:-$HOME/.local/share}/tigerAgent/data；
#                       系统级 /var/lib/tigerAgent，若服务用户旧目录已有 tigerAgent.json 则自动沿用）
#   TIGER_SYSTEMD_SCOPE user / system（默认按当前用户：root → system，其余 → user）
#   TIGER_SERVICE_NAME  服务名（tigerAgent）
#   TIGER_SERVICE_USER  仅系统级：服务运行用户（默认 sudo 调用者，否则 root）
#   TIGER_NO_START=1    只安装并写入 unit，不 enable / 不启动
#   TIGER_DEBUG=1       服务端以 --debug 启动
#   TIGER_FORCE=1       忽略已安装版本，强制重新下载
#   GITHUB_TOKEN        可选；GitHub API 限流时提升额度
set -euo pipefail

REPO="${TIGER_REPO:-litai686/tiger}"
WANT_VERSION="${TIGER_VERSION:-latest}"
TIGER_HOST="${TIGER_HOST:-tcp://:6464}"
NO_START="${TIGER_NO_START:-0}"
DEBUG_FLAG="${TIGER_DEBUG:-0}"
FORCE_INSTALL="${TIGER_FORCE:-0}"
SERVICE_NAME="${TIGER_SERVICE_NAME:-tigerAgent}"
SERVICE_NAME="${SERVICE_NAME%.service}"

log() { printf '==> %s\n' "$*" >&2; }
warn() { printf '警告: %s\n' "$*" >&2; }
die() { printf '错误: %s\n' "$*" >&2; exit 1; }

# ---------- 基础环境 ----------
[ -n "${HOME:-}" ] || die "HOME 未设置，无法确定用户目录；请先导出 HOME"

OS_RAW="$(uname -s)"
[ "$OS_RAW" = Linux ] || die "本脚本只支持 Linux（systemd）；$OS_RAW 请改用 install-server.sh（nohup 后台进程）"

ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64) ARCH_NAME=x86_64 ;;
  arm64|aarch64) die "官方 Release 未发布 Linux arm64 服务端产物（CI 只构建 Linux x86_64、macOS x86_64/arm64）" ;;
  *) die "不支持的 CPU 架构 $ARCH_RAW：官方 Release 只提供 x86_64" ;;
esac

command -v systemctl >/dev/null 2>&1 || die "未找到 systemctl：当前环境没有 systemd，请用 install-server.sh（nohup）"
[ -d /run/systemd/system ] || die "systemd 未作为 init 运行（容器 / chroot 环境）：请用 install-server.sh（nohup）或在宿主机上部署"

# ---------- 作用域与服务身份 ----------
if [ -n "${TIGER_SYSTEMD_SCOPE:-}" ]; then
  SCOPE="$TIGER_SYSTEMD_SCOPE"
elif [ "$(id -u)" -eq 0 ]; then
  SCOPE=system
else
  SCOPE=user
fi
case "$SCOPE" in
  user|system) ;;
  *) die "TIGER_SYSTEMD_SCOPE 只能是 user 或 system（当前：$SCOPE）" ;;
esac
if [ "$SCOPE" = system ] && [ "$(id -u)" -ne 0 ]; then
  die "系统级单元需要 root：sudo bash desktop/install-server-systemd.sh（或 TIGER_SYSTEMD_SCOPE=user）"
fi
if [ "$SCOPE" = user ] && [ -n "${TIGER_SERVICE_USER:-}" ]; then
  warn "TIGER_SERVICE_USER 只在系统级单元生效，已忽略"
fi

user_home() {
  local h
  h="$(getent passwd "$1" 2>/dev/null | cut -d: -f6 || true)"
  if [ -z "$h" ]; then
    if [ "$1" = root ]; then h=/root; else h="/home/$1"; fi
  fi
  printf '%s' "$h"
}

if [ "$SCOPE" = user ]; then
  SCOPE_LABEL=用户级
  SERVICE_USER="$(id -un)"
  SERVICE_GROUP="$(id -gn)"
  SERVICE_HOME="$HOME"
  INSTALL_DIR_DEFAULT="$HOME/.local/bin"
  DATA_DIR_DEFAULT="${XDG_DATA_HOME:-$HOME/.local/share}/tigerAgent/data"
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  SYSTEMCTL=(systemctl --user)
  CTL="systemctl --user"
  JCTL="journalctl --user"
else
  SCOPE_LABEL=系统级
  SERVICE_USER="${TIGER_SERVICE_USER:-${SUDO_USER:-root}}"
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    warn "服务用户 $SERVICE_USER 不存在，回落为 root"
    SERVICE_USER=root
  fi
  SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
  SERVICE_HOME="$(user_home "$SERVICE_USER")"
  INSTALL_DIR_DEFAULT=/usr/local/bin
  DATA_DIR_DEFAULT=/var/lib/tigerAgent
  UNIT_DIR=/etc/systemd/system
  SYSTEMCTL=(systemctl)
  CTL="systemctl"
  JCTL="journalctl"
fi

if [ "$SCOPE" = user ] && ! "${SYSTEMCTL[@]}" show-environment >/dev/null 2>&1; then
  die "无法连接用户级 systemd（systemctl --user）：请在有登录会话（XDG_RUNTIME_DIR / DBus）的环境里执行，或 sudo 装成系统级服务"
fi

TIGER_INSTALL_DIR="${TIGER_INSTALL_DIR:-$INSTALL_DIR_DEFAULT}"
if [ -z "${TIGER_DATA_DIR:-}" ]; then
  TIGER_DATA_DIR="$DATA_DIR_DEFAULT"
  # 迁移 install-server.sh：系统级默认目录还没有配置、而服务用户旧目录有配置时，沿用旧目录（identity / token 不变）。
  if [ "$SCOPE" = system ] && [ ! -f "$DATA_DIR_DEFAULT/tigerAgent.json" ] \
     && [ -f "$SERVICE_HOME/.local/share/tigerAgent/data/tigerAgent.json" ]; then
    TIGER_DATA_DIR="$SERVICE_HOME/.local/share/tigerAgent/data"
    log "沿用已有数据目录 $TIGER_DATA_DIR（迁移自 install-server.sh；可用 TIGER_DATA_DIR 覆盖）"
  fi
fi

BIN_PATH="$TIGER_INSTALL_DIR/tigerAgent"
UNIT_PATH="$UNIT_DIR/$SERVICE_NAME.service"
APP_LOG="$SERVICE_HOME/.cache/tigerAgent/tigerAgent.log"

# ---------- 下载工具 ----------
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

# ---------- 版本解析 ----------
log "系统识别：Linux_${ARCH_NAME}，systemd ${SCOPE_LABEL}服务（用户 ${SERVICE_USER}）"

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
ASSET="tigerAgent_${VERSION}_Linux_${ARCH_NAME}_server.tar.gz"
BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"

log "目标版本：${TAG}，产物：${ASSET}"

# ---------- 是否已安装同版本 ----------
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

# ---------- 下载、校验与解压 ----------
TMPDIR_INSTALL="$(mktemp -d 2>/dev/null || mktemp -d -t tigerAgent)"
cleanup() { rm -rf "$TMPDIR_INSTALL"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$NEED_INSTALL" = "1" ]; then
  log "下载 ${BASE_URL}/${ASSET}"
  download_file "${BASE_URL}/${ASSET}" "$TMPDIR_INSTALL/$ASSET" \
    || die "下载失败：${BASE_URL}/${ASSET}（该版本可能没有 Linux_${ARCH_NAME} 产物）"
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
  log "已下载并解压"
fi

# ---------- 停止旧实例 ----------
# install-server.sh 与手动启动的实例用 ps 命令行匹配停掉（不落 PID 文件）；systemd 单元用 systemctl stop。
find_running_pids() {
  command -v ps >/dev/null 2>&1 || return 0
  # 只认本服务端的实例：命令行以 $BIN_PATH 开头（安装路径含空格也能认），或 basename 是
  # tigerAgent（通过 PATH / 相对路径 / 软链启动）；再看参数：--host / --data-dir 与本脚本
  # 一致，或完全没带这两项（默认实例）。同一二进制的其他实例（不同端口 / 数据目录）不动；
  # 任意位置出现子命令或 --version / --rotate-token 等立即退出的调用，也不动。
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

stop_legacy_processes() {
  PIDS="$(find_running_pids || true)"
  [ -n "$PIDS" ] || return 0
  log "停止 install-server.sh / 手动启动的服务端进程：$(printf '%s ' $PIDS)"
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

stop_existing() {
  # 迁移：sudo 装系统级服务时，先停用并停掉调用者遗留的用户级单元，否则重启后两个实例抢同一端口。
  if [ "$SCOPE" = system ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
    UID_RUNTIME="$(id -u "$SUDO_USER" 2>/dev/null || true)"
    SUDO_HOME="$(user_home "$SUDO_USER")"
    if [ -n "$UID_RUNTIME" ] && [ -f "$SUDO_HOME/.config/systemd/user/$SERVICE_NAME.service" ] \
       && command -v runuser >/dev/null 2>&1; then
      runuser -u "$SUDO_USER" -- env "XDG_RUNTIME_DIR=/run/user/$UID_RUNTIME" \
        systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
      log "已停用 $SUDO_USER 的旧用户级单元"
    fi
  fi
  # 本作用域内的旧单元（重跑升级 / 版本未变的重启）。
  if [ -f "$UNIT_PATH" ]; then
    "${SYSTEMCTL[@]}" stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  stop_legacy_processes
}

# ---------- 安装二进制 ----------
# 只准备文件、不碰正在运行的实例：所有准备工作完成后才在启动阶段停旧进程（见 start 分支）。
if [ "$NEED_INSTALL" = "1" ]; then
  mkdir -p "$TIGER_INSTALL_DIR" || die "无法创建安装目录 $TIGER_INSTALL_DIR（系统级请用 sudo 执行）"
  # 先写临时文件再 rename：正在运行的旧进程也能安全替换（避免 ETXTBSY）。
  cp "$SRC_BIN" "$TIGER_INSTALL_DIR/.tigerAgent.new.$$"
  chmod 0755 "$TIGER_INSTALL_DIR/.tigerAgent.new.$$"
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

# 系统级服务以其他用户运行时，确认该用户能执行二进制（HOME 目录 0700 等会导致无法穿越）。
if [ "$SCOPE" = system ] && [ "$SERVICE_USER" != root ] && command -v runuser >/dev/null 2>&1; then
  runuser -u "$SERVICE_USER" -- test -x "$BIN_PATH" 2>/dev/null \
    || die "$SERVICE_USER 无法执行 $BIN_PATH：安装目录或上层目录权限不足，系统级服务请用默认的 /usr/local/bin"
fi

# ---------- 数据目录与身份 ----------
mkdir -p "$TIGER_DATA_DIR" || die "无法创建数据目录 $TIGER_DATA_DIR"
chmod 0700 "$TIGER_DATA_DIR" 2>/dev/null || true

fix_data_dir_owner() {
  if [ "$SCOPE" = system ]; then
    chown -R "$SERVICE_USER:$SERVICE_GROUP" "$TIGER_DATA_DIR" 2>/dev/null \
      || warn "无法把 $TIGER_DATA_DIR 交给 $SERVICE_USER:$SERVICE_GROUP，服务可能没有写权限"
  fi
}
fix_data_dir_owner

SERVER_ARGS=(--host "$TIGER_HOST" --data-dir "$TIGER_DATA_DIR")
if [ "$DEBUG_FLAG" = "1" ]; then
  SERVER_ARGS+=(--debug)
fi

CONN_STR=""
ADMIN_INFO=""
CONN_ERR="$TMPDIR_INSTALL/print-connection.err"
case "$TIGER_HOST" in
  tcp://*)
    # 正常启动时由服务端自己打印连接串 / 管理地址 / 指纹 / token（进 journal）；
    # 只有 TIGER_NO_START=1 才需要在这里用 --print-connection 初始化并打印。
    if [ "$NO_START" = "1" ]; then
      log "初始化 TLS 身份与 Bearer token（仅打印，不启动）"
      if ! CONN_STR="$("$BIN_PATH" "${SERVER_ARGS[@]}" --print-connection 2>"$CONN_ERR")"; then
        CONN_STR=""
        warn "--print-connection 失败"
        sed 's/^/  /' "$CONN_ERR" >&2 || true
      fi
      ADMIN_INFO="$(cat "$CONN_ERR" 2>/dev/null || true)"
      fix_data_dir_owner
    fi
    ;;
  *)
    warn "TIGER_HOST=$TIGER_HOST 不是 tcp://，连接串与健康检查将跳过（unix socket 依赖本机权限）"
    ;;
esac

# ---------- 写入 systemd unit ----------
# unit 里的 % 会被当成 specifier，路径中的 % 需要写成 %%。
sd_escape() { printf '%s' "$1" | sed 's/%/%%/g'; }

write_unit() {
  mkdir -p "$UNIT_DIR" || die "无法创建 $UNIT_DIR"
  EXEC_ARGS="--host \"$(sd_escape "$TIGER_HOST")\" --data-dir \"$(sd_escape "$TIGER_DATA_DIR")\""
  if [ "$DEBUG_FLAG" = "1" ]; then
    EXEC_ARGS="$EXEC_ARGS --debug"
  fi
  {
    printf '# 由 desktop/install-server-systemd.sh 生成；重新执行脚本会覆盖本文件\n'
    printf '[Unit]\n'
    printf 'Description=tigerAgent server\n'
    printf 'After=network-online.target\n'
    printf 'Wants=network-online.target\n'
    printf '\n[Service]\n'
    printf 'Type=simple\n'
    if [ "$SCOPE" = system ]; then
      printf 'User=%s\nGroup=%s\n' "$SERVICE_USER" "$SERVICE_GROUP"
    fi
    printf 'Environment="HOME=%s"\n' "$(sd_escape "$SERVICE_HOME")"
    printf 'ExecStart="%s" %s\n' "$(sd_escape "$BIN_PATH")" "$EXEC_ARGS"
    printf 'Restart=on-failure\n'
    printf 'RestartSec=3\n'
    printf 'KillSignal=SIGTERM\n'
    printf 'TimeoutStopSec=20\n'
    printf '\n[Install]\n'
    if [ "$SCOPE" = system ]; then
      printf 'WantedBy=multi-user.target\n'
    else
      printf 'WantedBy=default.target\n'
    fi
  } > "$UNIT_PATH" || die "无法写入 $UNIT_PATH"
  log "已写入 unit：$UNIT_PATH"
}

write_unit
"${SYSTEMCTL[@]}" daemon-reload || die "systemctl daemon-reload 失败"

START_MARK=""
AUTOSTART_LABEL="未启用（TIGER_NO_START=1）"
if [ "$NO_START" = "1" ]; then
  log "TIGER_NO_START=1，跳过 enable / 启动"
else
  # 二进制与 unit 都已写好，这里才停旧实例；此前任何失败都不会中断正在运行的服务。
  stop_existing
  "${SYSTEMCTL[@]}" enable "$SERVICE_NAME" >/dev/null || die "systemctl enable $SERVICE_NAME 失败"
  # 开机自启必须真正生效：enable 之后校验 is-enabled，避免只写了 unit 却漏掉 target 软链。
  ENABLED_STATE="$("${SYSTEMCTL[@]}" is-enabled "$SERVICE_NAME" 2>/dev/null || true)"
  case "$ENABLED_STATE" in
    enabled) ;;
    *) die "未能把 $SERVICE_NAME 加入开机自启（systemctl is-enabled 返回：${ENABLED_STATE:-空}）" ;;
  esac

  START_MARK="$(date '+%Y-%m-%d %H:%M:%S')"
  "${SYSTEMCTL[@]}" restart "$SERVICE_NAME" || die "systemctl restart $SERVICE_NAME 失败"
  log "已启用并启动 $SERVICE_NAME"

  if [ "$SCOPE" = user ]; then
    # 用户级单元还依赖 linger：没有它，系统重启 / 用户未登录时用户管理器不会拉起服务。
    LINGER_OK=0
    if command -v loginctl >/dev/null 2>&1; then
      if loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
        LINGER_OK=1
      elif loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
        LINGER_OK=1
      elif command -v sudo >/dev/null 2>&1 && sudo -n loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
        LINGER_OK=1
      fi
    fi
    if [ "$LINGER_OK" != "1" ]; then
      die "服务已启动，但未能开启 linger，系统重启后不会自动启动：请执行 sudo loginctl enable-linger $(id -un) 后重跑本脚本（或改用 sudo 装系统级服务）"
    fi
    log "已开启 linger：系统重启 / 用户未登录时也自动启动"
    AUTOSTART_LABEL="已启用（default.target + linger，开机自动启动）"
  else
    AUTOSTART_LABEL="已启用（multi-user.target，开机自动启动）"
  fi
fi

journal_tail() {
  local since="${1:-}"
  if [ "$SCOPE" = user ]; then
    if [ -n "$since" ]; then
      journalctl --user -u "$SERVICE_NAME" -n 200 --no-pager -o cat --since "$since" 2>/dev/null || true
    else
      journalctl --user -u "$SERVICE_NAME" -n 200 --no-pager -o cat 2>/dev/null || true
    fi
  else
    if [ -n "$since" ]; then
      journalctl -u "$SERVICE_NAME" -n 200 --no-pager -o cat --since "$since" 2>/dev/null || true
    else
      journalctl -u "$SERVICE_NAME" -n 200 --no-pager -o cat 2>/dev/null || true
    fi
  fi
}

# ---------- 存活性检查 ----------
# 不依赖 curl：服务重启后必须真正进入 active；健康检查只是额外一轮 HTTP 探测。
if [ "$NO_START" != "1" ]; then
  ACTIVE_OK=0
  TRIES=0
  while [ "$TRIES" -lt 30 ]; do
    if "${SYSTEMCTL[@]}" is-active --quiet "$SERVICE_NAME"; then
      ACTIVE_OK=1
      break
    fi
    TRIES=$((TRIES + 1))
    sleep 0.5
  done
  if [ "$ACTIVE_OK" -ne 1 ]; then
    printf '\n服务日志（最后 40 行）：\n' >&2
    journal_tail "$START_MARK" | tail -n 40 | sed 's/^/  /' >&2 || true
    if [ -f "$APP_LOG" ]; then
      printf '应用日志（最后 30 行）：\n' >&2
      tail -n 30 "$APP_LOG" >&2 || true
    fi
    die "$SERVICE_NAME 启动后未处于 active 状态（journal 与 $APP_LOG 见上）"
  fi
fi

# ---------- 健康检查 ----------
HEALTH_PORT=""
BIND_HOST=""
case "$TIGER_HOST" in
  tcp://*)
    HOSTPORT="${TIGER_HOST#tcp://}"
    case "$HOSTPORT" in
      *:*) HEALTH_PORT="${HOSTPORT##*:}"; BIND_HOST="${HOSTPORT%:*}" ;;
      *) HEALTH_PORT="$HOSTPORT" ;;
    esac
    ;;
esac
case "$HEALTH_PORT" in
  ''|*[!0-9]*) HEALTH_PORT="" ;;
esac

if [ -n "$HEALTH_PORT" ] && [ "$NO_START" != "1" ]; then
  case "$BIND_HOST" in
    ''|0.0.0.0|'::'|'*') HEALTH_HOST=127.0.0.1 ;;
    \[*\]) HEALTH_HOST="$BIND_HOST" ;;
    *:*) HEALTH_HOST="[$BIND_HOST]" ;;
    *) HEALTH_HOST="$BIND_HOST" ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    log "等待 https://${HEALTH_HOST}:${HEALTH_PORT}/v1/health 就绪"
    HEALTHY=0
    TRIES=0
    while [ "$TRIES" -lt 30 ]; do
      if curl -fsSk --max-time 2 "https://${HEALTH_HOST}:${HEALTH_PORT}/v1/health" >/dev/null 2>&1; then
        HEALTHY=1
        break
      fi
      TRIES=$((TRIES + 1))
      sleep 0.5
    done
    if [ "$HEALTHY" -ne 1 ]; then
      printf '\n服务日志（最后 40 行）：\n' >&2
      journal_tail "$START_MARK" | tail -n 40 | sed 's/^/  /' >&2 || true
      if [ -f "$APP_LOG" ]; then
        printf '应用日志（最后 30 行）：\n' >&2
        tail -n 30 "$APP_LOG" >&2 || true
      fi
      die "健康检查失败：https://${HEALTH_HOST}:${HEALTH_PORT}/v1/health 无响应（端口被占用或启动参数错误）"
    fi
    log "健康检查通过"
  else
    warn "未找到 curl，跳过 /v1/health 检查（已确认 $SERVICE_NAME 为 active）"
  fi
fi

if [ "$NO_START" != "1" ]; then
  CONN_STR="$(journal_tail "$START_MARK" | grep -m1 '^tigerAgent://' || true)"
fi

# ---------- 结果 ----------
printf '\n'
printf 'tigerAgent 服务端部署完成（systemd %s服务）\n' "$SCOPE_LABEL"
printf '  版本:     %s\n' "$TAG"
printf '  二进制:   %s\n' "$BIN_PATH"
printf '  数据目录: %s\n' "$TIGER_DATA_DIR"
printf '  监听:     %s\n' "$TIGER_HOST"
printf '  单元文件: %s\n' "$UNIT_PATH"
printf '  运行用户: %s\n' "$SERVICE_USER"
if [ "$NO_START" = "1" ]; then
  printf '  状态:     未启用（TIGER_NO_START=1）\n'
  printf '  开机自启: 未启用（执行上面的手动启用命令即会写入开机自启）\n'
  printf '  手动启用: %s enable --now %s\n' "$CTL" "$SERVICE_NAME"
  printf '  手动启动: %s --host %s --data-dir %s\n' "$BIN_PATH" "$TIGER_HOST" "$TIGER_DATA_DIR"
else
  printf '  状态:     已启用并运行\n'
  printf '  开机自启: %s\n' "$AUTOSTART_LABEL"
  printf '  服务控制: %s restart|stop|disable --now %s\n' "$CTL" "$SERVICE_NAME"
  printf '  服务日志: %s -u %s -f（应用日志：%s）\n' "$JCTL" "$SERVICE_NAME" "$APP_LOG"
fi
if [ -n "$CONN_STR" ]; then
  printf '  连接串:   %s\n' "$CONN_STR"
  printf '            （含 token，请勿外传；桌面端粘贴到「设置 → 服务端连接」）\n'
elif [ "$NO_START" != "1" ] && [ -n "$HEALTH_PORT" ]; then
  printf '  连接串:   未从 journal 读到，可执行 %s -u %s --no-pager | grep tigerAgent://\n' "$JCTL" "$SERVICE_NAME"
fi
if [ "$NO_START" = "1" ] && [ -n "$ADMIN_INFO" ]; then
  printf '%s\n' "$ADMIN_INFO" | sed 's/^/  /'
fi
printf '  配置文件: %s（首次启动生成，改完 provider/模型后 %s restart %s）\n' \
  "$TIGER_DATA_DIR/tigerAgent.json" "$CTL" "$SERVICE_NAME"
printf '  轮换token: %s --rotate-token --host %s --data-dir %s（之后 %s restart %s）\n' \
  "$BIN_PATH" "$TIGER_HOST" "$TIGER_DATA_DIR" "$CTL" "$SERVICE_NAME"

if [ "$SCOPE" = system ] && [ "$SERVICE_USER" = root ]; then
  printf '\n'
  warn "服务以 root 运行，服务端派生的命令也将以 root 执行；建议用 sudo 从普通用户执行（自动用 SUDO_USER）"
fi
