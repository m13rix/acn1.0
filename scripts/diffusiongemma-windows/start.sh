#!/usr/bin/env bash
set -euo pipefail

RUNTIME_ROOT="${DIFFUSION_GEMMA_RUNTIME_ROOT:-$HOME/.local/share/diffusiongemma-vllm}"
VLLM="$RUNTIME_ROOT/.venv/bin/vllm"
MODEL_DIR="${DIFFUSION_GEMMA_MODEL_DIR:-/models/cyankiwi-diffusiongemma-26B-A4B-it-AWQ-INT4}"
PORT="${DIFFUSION_GEMMA_PORT:-8001}"
MAX_MODEL_LEN="${DIFFUSION_GEMMA_MAX_MODEL_LEN:-8192}"
MAX_BATCHED_TOKENS="${DIFFUSION_GEMMA_MAX_BATCHED_TOKENS:-8448}"
GPU_MEMORY="${DIFFUSION_GEMMA_GPU_MEMORY_UTILIZATION:-0.85}"
ENTROPY_BOUND="${DIFFUSION_GEMMA_ENTROPY_BOUND:-0.1}"
MODEL_NAME="${DIFFUSION_GEMMA_SERVED_MODEL_NAME:-diffusiongemma-26b-awq}"
LOG_DIR="$RUNTIME_ROOT/logs"
LOG_FILE="$LOG_DIR/server.log"
UNIT="telos-diffusiongemma.service"

[[ -x "$VLLM" ]] || { echo "ERROR: vLLM runtime missing at $VLLM" >&2; exit 1; }
[[ -f "$MODEL_DIR/model.safetensors.index.json" ]] || { echo "ERROR: model missing at $MODEL_DIR" >&2; exit 1; }
grep -q "WSL does not expose CUDA UVA host mappings" \
  "$RUNTIME_ROOT/.venv/lib/python3.12/site-packages/vllm/v1/worker/gpu/buffer_utils.py" || {
    echo "ERROR: WSL UVA fallback is missing. Run install-runtime.ps1." >&2
    exit 1
  }
mkdir -p "$LOG_DIR"

systemctl stop "$UNIT" 2>/dev/null || true
systemctl reset-failed "$UNIT" 2>/dev/null || true

args=(
  serve "$MODEL_DIR"
  --served-model-name "$MODEL_NAME"
  --host 0.0.0.0
  --port "$PORT"
  --max-model-len "$MAX_MODEL_LEN"
  --max-num-batched-tokens "$MAX_BATCHED_TOKENS"
  --max-num-seqs 1
  --gpu-memory-utilization "$GPU_MEMORY"
  --generation-config vllm
  --hf-overrides "{\"diffusion_sampler\":\"entropy_bound\",\"diffusion_entropy_bound\":$ENTROPY_BOUND}"
  --diffusion-config '{"canvas_length":256}'
  --enable-prefix-caching
  --enable-auto-tool-choice
  --tool-call-parser gemma4
  --reasoning-parser gemma4
  --language-model-only
)

rm -f "$LOG_FILE"
systemd-run \
  --unit="${UNIT%.service}" \
  --collect \
  --service-type=exec \
  --setenv=VLLM_USE_FLASHINFER_SAMPLER=0 \
  --setenv=TOKENIZERS_PARALLELISM=false \
  --setenv=HF_HUB_OFFLINE=1 \
  --setenv=TRANSFORMERS_OFFLINE=1 \
  --property="StandardOutput=append:$LOG_FILE" \
  --property="StandardError=append:$LOG_FILE" \
  "$VLLM" "${args[@]}"
pid="$(systemctl show "$UNIT" --property=MainPID --value)"
echo "Started native DiffusionGemma vLLM systemd unit=$UNIT pid=$pid"
echo "Log: $LOG_FILE"
