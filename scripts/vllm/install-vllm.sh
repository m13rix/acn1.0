#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi
else
  echo "ERROR: nvidia-smi is not visible inside WSL. Install/update the NVIDIA Windows driver with WSL CUDA support, then rerun." >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install -y curl ca-certificates build-essential git python3.12 python3.12-venv python3.12-dev

if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

export PATH="$HOME/.local/bin:$PATH"
mkdir -p /opt/vllm-cu129 /mnt/g/hf-cache
cd /opt/vllm-cu129

uv venv --python 3.12 --seed
source .venv/bin/activate
UV_LINK_MODE=copy uv pip install vllm --torch-backend=cu129 --link-mode=copy
UV_LINK_MODE=copy uv pip install --force-reinstall --no-deps "vllm==0.23.0+cu129" --index-url https://wheels.vllm.ai/0.23.0/cu129 --link-mode=copy

python - <<'PY'
import vllm
print("vLLM import ok:", getattr(vllm, "__version__", "unknown"))
PY

echo "vLLM setup complete in /opt/vllm-cu129"
