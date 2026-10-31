#!/usr/bin/env bash
# Installs the `amorechat-update` command for the AmoreChat folder given as $1.
# Called by install.sh and update.sh; safe to run again.
set -euo pipefail
DIR="$(cd "${1:-.}" && pwd)"
REPO="${AMORECHAT_REPO:-amor7/AmoreChat-Tele}"
cat > /usr/local/bin/amorechat-update <<SCRIPT
#!/usr/bin/env bash
# Update AmoreChat in ${DIR}:  sudo amorechat-update [version]
export AMORECHAT_DIR="${DIR}" AMORECHAT_REPO="${REPO}"
TMP=\$(mktemp)
trap 'rm -f "\$TMP"' EXIT
# Always use the newest updater from GitHub; fall back to the local copy if GitHub is unreachable.
if curl -fsSL "https://raw.githubusercontent.com/${REPO}/main/deploy/update.sh" -o "\$TMP"; then
  bash "\$TMP" "\$@"
else
  bash "${DIR}/deploy/update.sh" "\$@"
fi
SCRIPT
chmod 755 /usr/local/bin/amorechat-update

# Updates from the admin panel: the app writes data/update/request, systemd runs
# deploy/panel-update.sh as root (see there). Only on servers with systemd.
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  mkdir -p "${DIR}/data/update"
  chown 1000:1000 "${DIR}/data/update" 2>/dev/null || true
  cat > /etc/systemd/system/amorechat-panel-update.service <<UNIT
[Unit]
Description=AmoreChat: update asked for in the admin panel

[Service]
Type=oneshot
TimeoutStartSec=3600
ExecStart=/bin/bash ${DIR}/deploy/panel-update.sh
UNIT
  cat > /etc/systemd/system/amorechat-panel-update.path <<UNIT
[Unit]
Description=AmoreChat: watch for updates asked for in the admin panel

[Path]
PathChanged=${DIR}/data/update/request

[Install]
WantedBy=multi-user.target
UNIT
  # The watchdog: see deploy/watchdog.sh. It only looks at the app on this server, never the network.
  cat > /etc/systemd/system/amorechat-watchdog.service <<UNIT
[Unit]
Description=AmoreChat: restart the app if it is really stuck

[Service]
Type=oneshot
Nice=10
ExecStart=/bin/bash ${DIR}/deploy/watchdog.sh
UNIT
  cat > /etc/systemd/system/amorechat-watchdog.timer <<UNIT
[Unit]
Description=AmoreChat: check that the app answers

[Timer]
OnBootSec=5min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now amorechat-panel-update.path >/dev/null 2>&1 || echo "!! Could not enable updates from the admin panel (systemd)"
  systemctl enable --now amorechat-watchdog.timer >/dev/null 2>&1 || echo "!! Could not enable the watchdog (systemd)"
fi
