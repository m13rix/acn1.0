#!/usr/bin/env bash
set -euo pipefail

MODEL_ID="${TELOS_VLLM_MODEL_ID:-cyankiwi/Qwen3.6-27B-AWQ-INT4}"
FALLBACK_MODEL_ID="${TELOS_VLLM_FALLBACK_MODEL_ID:-Qwen/Qwen3.5-27B-GPTQ-Int4}"
USE_FALLBACK="${TELOS_VLLM_USE_FALLBACK:-false}"
MAX_MODEL_LEN="${TELOS_VLLM_MAX_MODEL_LEN:-16384}"
GPU_MEMORY_UTILIZATION="${TELOS_VLLM_GPU_MEMORY_UTILIZATION:-0.90}"
ENABLE_PREFIX_CACHING="${TELOS_VLLM_ENABLE_PREFIX_CACHING:-false}"
ENFORCE_EAGER="${TELOS_VLLM_ENFORCE_EAGER:-true}"
MODEL_PATH="${TELOS_VLLM_MODEL_PATH:-}"

export HF_HOME="${HF_HOME:-/mnt/g/hf-cache}"
export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"
export VLLM_USE_FLASHINFER_SAMPLER="${VLLM_USE_FLASHINFER_SAMPLER:-0}"

VLLM_HOME="${TELOS_VLLM_HOME:-/opt/vllm-cu129}"
if [ ! -x "$VLLM_HOME/.venv/bin/vllm" ]; then
  VLLM_HOME="/mnt/g/vllm-cu129"
fi

cd "$VLLM_HOME"
source .venv/bin/activate

resolve_model_path() {
  local model_id="$1"
  local explicit_path="${MODEL_PATH}"
  if [ -n "$explicit_path" ]; then
    echo "$explicit_path"
    return
  fi

  if [ "$model_id" = "cyankiwi/Qwen3.6-27B-AWQ-INT4" ]; then
    local ext4_snapshot="/models/cyankiwi-Qwen3.6-27B-AWQ-INT4"
    if [ -d "$ext4_snapshot" ]; then
      echo "$ext4_snapshot"
      return
    fi

    local cache_root="/mnt/g/hf-cache/models--cyankiwi--Qwen3.6-27B-AWQ-INT4/snapshots"
    local snapshot
    snapshot="$(find "$cache_root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1 || true)"
    if [ -n "$snapshot" ]; then
      echo "$snapshot"
      return
    fi
  fi

  echo "$model_id"
}

serve_model() {
  local model_id="$1"
  local model_path
  model_path="$(resolve_model_path "$model_id")"
  local args=(
    serve "$model_path"
    --served-model-name "$model_id"
    --host 0.0.0.0
    --port 8000
    --max-model-len "$MAX_MODEL_LEN"
    --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION"
    --reasoning-parser qwen3
    --enable-auto-tool-choice
    --tool-call-parser qwen3_coder
    --language-model-only
  )

  if [ "$ENABLE_PREFIX_CACHING" = "true" ]; then
    args+=(--enable-prefix-caching)
  fi
  if [ "$ENFORCE_EAGER" = "true" ]; then
    args+=(--enforce-eager)
  fi

  echo "Starting vLLM model: ${model_id}"
  exec vllm "${args[@]}"
}

if [ "$USE_FALLBACK" = "true" ]; then
  serve_model "$MODEL_ID" || serve_model "$FALLBACK_MODEL_ID"
else
  serve_model "$MODEL_ID"
fi
