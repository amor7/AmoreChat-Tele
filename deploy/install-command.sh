#!/usr/bin/env bash
# Installs the `amorechat-update` command for the AmoreChat folder given as $1.
# Called by install.sh and update.sh; safe to run again.
set -euo pipefail
DIR="$(cd "${1:-.}" && pwd)"
REPO="${AMORECHAT_REPO:-amor7/AmoreChat}"
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
