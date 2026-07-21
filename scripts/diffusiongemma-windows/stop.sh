#!/usr/bin/env bash
set -euo pipefail
UNIT="telos-diffusiongemma.service"
if systemctl is-active --quiet "$UNIT"; then
  echo "Stopping $UNIT"
  systemctl stop "$UNIT"
fi
systemctl reset-failed "$UNIT" 2>/dev/null || true
echo "DiffusionGemma stopped."
