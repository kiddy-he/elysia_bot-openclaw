#!/usr/bin/env bash
# Capture remains separate; delivery uses the Gateway durable queue.
set -eu
IMAGE="${1:-}"
[ -n "$IMAGE" ] && [ -f "$IMAGE" ] || { echo 'STATUS=fail'; echo 'REASON=missing-image-file'; exit 1; }
exec /opt/node-v25.9.0-linux-x64/bin/node /root/.openclaw/onebot-onebot-custom/scripts/deliver.mjs alas-screenshot "$IMAGE"
