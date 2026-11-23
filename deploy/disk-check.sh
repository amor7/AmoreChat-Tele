#!/usr/bin/env bash
# Free-space check before an install or update. Sourced by install.sh and update.sh (and a small
# copy lives in get.sh: keep the two in sync).
# Why: a full disk in the middle of `docker load` or of the rollback tar leaves a half-written image
# or a broken rollback copy; refusing before anything is touched keeps the running version intact.
# Works with `set -u`, bash 3+, and the POSIX df of busybox/old coreutils (`df -Pk`).
#
#   amore_disk_check <min_mb> <path> [<min_mb> <path> ...]
#     Paths that sit on the same filesystem have their needs added up and are checked once.
#     A path that doesn't exist yet is measured at its nearest existing parent.
#     Returns 4 (with a message) when space is short, 0 otherwise.
#   AMORECHAT_MIN_FREE_MB=<n>   one need (MB) for every path instead of the computed ones
#   SKIP_DISK_CHECK=1           skip the check (a warning is still printed)
#   Both are taken from the environment, or else from the project's .env (the current folder, or
#   AMORECHAT_ENV_FILE), so an update started from the admin panel can be told too.
#   Only these two keys are read from .env; the file is never sourced.

# amore_env_value <key> [<file>]: the value of KEY=... in the .env file (quotes removed), or nothing.
amore_env_value() {
  local f="${2:-${AMORECHAT_ENV_FILE:-.env}}" v
  [ -f "$f" ] || return 0
  v=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$f" 2>/dev/null | tail -n1 | sed -E "s/^[^=]*=//; s/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^[\"']//; s/[\"']$//" || true)
  echo "$v"
}

# amore_existing <path>: the path itself or its nearest existing parent.
amore_existing() {
  local p="$1"
  while [ ! -e "$p" ] && [ "$p" != "/" ] && [ "$p" != "." ]; do
    p=$(dirname "$p")
  done
  echo "$p"
}

# amore_docker_root: Docker's data folder (where `docker load` writes), or nothing when Docker
# isn't installed or not running yet.
amore_docker_root() {
  command -v docker >/dev/null 2>&1 || return 1
  local d
  # A hung Docker daemon must not hang the update: give up after 10 s when timeout exists.
  if command -v timeout >/dev/null 2>&1; then
    d=$(timeout 10 docker info -f '{{.DockerRootDir}}' 2>/dev/null) || return 1
  else
    d=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null) || return 1
  fi
  [ -n "$d" ] || return 1
  echo "$d"
}

# amore_size_mb <path>...: total size in MB (rounded up) of existing files/folders; 0 if none.
amore_size_mb() {
  local kb=0 p s
  for p in "$@"; do
    [ -e "$p" ] || continue
    # || true: under pipefail a du warning (an unreadable file) must not end the script.
    s=$(du -sk "$p" 2>/dev/null | awk '{print $1}' || true)
    case "$s" in ''|*[!0-9]*) s=0 ;; esac
    kb=$(( kb + ${s:-0} ))
  done
  echo $(( (kb + 1023) / 1024 ))
}

amore_disk_check() {
  local skip="${SKIP_DISK_CHECK:-}"
  [ -n "$skip" ] || skip=$(amore_env_value SKIP_DISK_CHECK)
  if [ "$skip" = "1" ]; then
    echo "!! هشدار: بررسی فضای دیسک رد شد (SKIP_DISK_CHECK=1). اگر دیسک پر شود، نصب/آپدیت نیمه‌کاره می‌ماند." >&2
    return 0
  fi
  # Parallel arrays instead of an associative one: works on bash 3 too.
  local mounts=() needs=() frees=() paths=()
  local min path real line free mount i found n
  local override="${AMORECHAT_MIN_FREE_MB:-}"
  [ -n "$override" ] || override=$(amore_env_value AMORECHAT_MIN_FREE_MB)
  case "$override" in *[!0-9]*) override="" ;; esac
  while [ "$#" -ge 2 ]; do
    min="$1"; path="$2"; shift 2
    [ -n "$override" ] && min="$override"
    [ -n "$path" ] || continue
    real=$(amore_existing "$path")
    # -P: one line per filesystem even with long device names; -k: same units everywhere.
    # || true: a df failure is reported below instead of silently ending the script (pipefail).
    line=$(df -Pk "$real" 2>/dev/null | awk 'NR==2' || true)
    if [ -z "$line" ]; then
      echo "!! هشدار: فضای آزاد ${path} را نتوانستم بسنجم؛ از بررسی آن رد شدم." >&2
      continue
    fi
    free=$(echo "$line" | awk '{print int($4 / 1024)}' || true)
    mount=$(echo "$line" | awk '{ for (i = 6; i <= NF; i++) printf "%s%s", $i, (i < NF ? " " : "") }' || true)
    case "$free" in ''|*[!0-9]*)
      echo "!! هشدار: فضای آزاد ${path} را نتوانستم بسنجم؛ از بررسی آن رد شدم." >&2
      continue ;;
    esac
    found=""
    n=${#mounts[@]}
    for (( i = 0; i < n; i++ )); do
      if [ "${mounts[$i]}" = "$mount" ]; then
        # With one override number for all, the same disk isn't asked for it twice.
        [ -n "$override" ] || needs[$i]=$(( ${needs[$i]} + min ))
        paths[$i]="${paths[$i]}، ${path}"
        found=1
        break
      fi
    done
    if [ -z "$found" ]; then
      mounts[$n]="$mount"; needs[$n]="$min"; frees[$n]="$free"; paths[$n]="$path"
    fi
  done

  local short=""
  n=${#mounts[@]}
  for (( i = 0; i < n; i++ )); do
    if [ "${frees[$i]}" -lt "${needs[$i]}" ]; then
      echo "!! فضای دیسک کافی نیست: ${paths[$i]} (دیسک ${mounts[$i]})" >&2
      echo "   آزاد: ${frees[$i]} MB   لازم: حدود ${needs[$i]} MB" >&2
      short=1
    fi
  done
  [ -z "$short" ] && return 0
  echo "   هیچ چیزی تغییر نکرد. برای آزاد کردن فضا:" >&2
  echo "   - پاک کردن imageهای بی‌استفاده:   docker image prune -f" >&2
  echo "   - پاک کردن دانلودهای قبلی:        rm -rf /var/cache/amorechat" >&2
  echo "   - نگه داشتن بکاپ کمتر: BACKUP_KEEP را در .env کم کنید (بکاپ‌ها در data/backups)" >&2
  echo "   - یا با مسئولیت خودتان بدون بررسی:  SKIP_DISK_CHECK=1 (یا عدد دیگر با AMORECHAT_MIN_FREE_MB=...)" >&2
  echo "     این دو را می‌شود جلوی دستور گذاشت یا در فایل .env پروژه نوشت (برای آپدیت از پنل مدیریت هم کار می‌کند)." >&2
  return 4
}
