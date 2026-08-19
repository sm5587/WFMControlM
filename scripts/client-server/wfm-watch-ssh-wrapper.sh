#!/bin/bash
# WFM Watch — ForceCommand wrapper for client app-server SSH service accounts.
# Install on each client app server, e.g. /usr/local/bin/wfm-watch-ssh-wrapper.sh
# sshd_config:
#   Match User wfmwatch
#     ForceCommand /usr/local/bin/wfm-watch-ssh-wrapper.sh
#     PermitTTY no
#     X11Forwarding no
#     AllowTcpForwarding no
#     PermitOpen none

set -euo pipefail

CMD="${SSH_ORIGINAL_COMMAND:-}"

if [[ -z "$CMD" ]]; then
  echo "Interactive login not permitted for WFM Watch service account." >&2
  exit 1
fi

# Read-only monitoring commands issued by WFM Watch (see docs/SSH-Account-Hardening-Client-Servers.md)
ALLOWED='^(cat|tail|stat|find|pgrep|grep|journalctl|db2|timedatectl|readlink|date|bash -lc find )'

if [[ ! "$CMD" =~ $ALLOWED ]]; then
  echo "Command not permitted for WFM Watch service account." >&2
  exit 1
fi

# Reject obvious shell injection / redirection outside quoted paths
if [[ "$CMD" =~ [\;\|\&\`\$\(\)\<\>] ]]; then
  echo "Shell metacharacters not permitted." >&2
  exit 1
fi

exec /bin/bash -c "$CMD"
