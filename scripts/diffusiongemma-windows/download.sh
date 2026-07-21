#!/usr/bin/env bash
set -euo pipefail

MODEL_ID="${DIFFUSION_GEMMA_MODEL_ID:-cyankiwi/diffusiongemma-26B-A4B-it-AWQ-INT4}"
MODEL_DIR="${DIFFUSION_GEMMA_MODEL_DIR:-/models/cyankiwi-diffusiongemma-26B-A4B-it-AWQ-INT4}"
WORKERS="${DIFFUSION_GEMMA_DOWNLOAD_WORKERS:-4}"
DOWNLOAD_VENV="${DIFFUSION_GEMMA_DOWNLOAD_VENV:-$HOME/.local/share/diffusiongemma-download/.venv}"
PYTHON="$DOWNLOAD_VENV/bin/python"

if [[ ! -x "$PYTHON" ]]; then
  echo "Creating a lightweight Python environment for the resumable download..."
  command -v python3 >/dev/null 2>&1 || {
    echo "ERROR: python3 is not available inside WSL." >&2
    exit 1
  }
  mkdir -p "$(dirname "$DOWNLOAD_VENV")"
  python3 -m venv "$DOWNLOAD_VENV"
  "$PYTHON" -m pip install --upgrade pip huggingface_hub
fi

sudo mkdir -p "$MODEL_DIR"
sudo chown -R "$(id -u):$(id -g)" "$MODEL_DIR"

available_kb="$(df -Pk "$(dirname "$MODEL_DIR")" | awk 'NR==2 {print $4}')"
required_kb=$((20 * 1024 * 1024))
if (( available_kb < required_kb )); then
  echo "ERROR: At least 20 GiB free is required on the WSL filesystem." >&2
  df -h "$(dirname "$MODEL_DIR")" >&2
  exit 1
fi

export HF_HOME="${HF_HOME:-/models/.cache/huggingface}"
export HF_HUB_ENABLE_HF_TRANSFER="${HF_HUB_ENABLE_HF_TRANSFER:-0}"
export MODEL_ID MODEL_DIR WORKERS

"$PYTHON" - <<'PY'
import os
from pathlib import Path

from huggingface_hub import snapshot_download

model_id = os.environ["MODEL_ID"]
model_dir = Path(os.environ["MODEL_DIR"])
workers = int(os.environ["WORKERS"])

print(f"Fetching {model_id}")
print(f"Destination: {model_dir}")
snapshot_download(
    repo_id=model_id,
    local_dir=model_dir,
    max_workers=workers,
)

required = [
    "config.json",
    "tokenizer.json",
    "model.safetensors.index.json",
    "model-00001-of-00004.safetensors",
    "model-00002-of-00004.safetensors",
    "model-00003-of-00004.safetensors",
    "model-00004-of-00004.safetensors",
]
missing = [name for name in required if not (model_dir / name).is_file()]
if missing:
    raise SystemExit(f"Download incomplete; missing: {', '.join(missing)}")

size = sum(path.stat().st_size for path in model_dir.rglob("*") if path.is_file())
print(f"Download complete: {size / 1024**3:.2f} GiB at {model_dir}")
PY
