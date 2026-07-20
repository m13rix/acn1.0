#!/usr/bin/env bash
set -euo pipefail

RUNTIME_ROOT="${DIFFUSION_GEMMA_RUNTIME_ROOT:-$HOME/.local/share/diffusiongemma-vllm}"
REPO_ROOT="/mnt/g/agent0/acn1.0"
PATCH_FILE="$REPO_ROOT/scripts/diffusiongemma-windows/wsl-uva-fallback.patch"

command -v nvidia-smi >/dev/null 2>&1 || { echo "ERROR: NVIDIA CUDA is not visible in WSL." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: Python 3 is not installed in WSL." >&2; exit 1; }

if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

mkdir -p "$RUNTIME_ROOT"
cd "$RUNTIME_ROOT"
uv venv --python 3.12 --seed .venv
source .venv/bin/activate

UV_LINK_MODE=copy uv pip install vllm --torch-backend=cu129 --link-mode=copy
UV_LINK_MODE=copy uv pip install --force-reinstall --no-deps \
  "vllm==0.24.0+cu129" \
  --index-url https://wheels.vllm.ai/0.24.0/cu129 \
  --link-mode=copy

SITE_PACKAGES="$RUNTIME_ROOT/.venv/lib/python3.12/site-packages"
BUFFER_UTILS="$SITE_PACKAGES/vllm/v1/worker/gpu/buffer_utils.py"
if ! grep -q "WSL does not expose CUDA UVA host mappings" "$BUFFER_UTILS"; then
  command -v patch >/dev/null 2>&1 || { echo "ERROR: install the Ubuntu 'patch' package." >&2; exit 1; }
  (cd "$SITE_PACKAGES" && patch -p0 < "$PATCH_FILE")
fi

python -c "import torch, vllm; print('vLLM', vllm.__version__); print('Torch', torch.__version__); print('GPU', torch.cuda.get_device_name(0))"
echo "DiffusionGemma vLLM runtime ready at $RUNTIME_ROOT"

