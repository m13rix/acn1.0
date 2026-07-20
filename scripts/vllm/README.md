# Local vLLM Runtime

This folder contains the local runtime path for `agents/telos-code-vllm`.

Use WSL2 Ubuntu 24.04 for vLLM. Native Windows vLLM is not the production path.

## One-time setup

From PowerShell:

```powershell
scripts\vllm\install-wsl-vllm.ps1
```

The script installs Ubuntu 24.04 if it is missing, creates `/opt/vllm-cu129` and `/mnt/g/hf-cache`, installs `uv`, and installs vLLM into a Python 3.12 virtual environment on the native WSL ext4 filesystem.

This machine's NVIDIA driver reports CUDA 12.9, so the installer pins the CUDA 12.9 stack and the `vllm==0.23.0+cu129` wheel from `https://wheels.vllm.ai/0.23.0/cu129`. Do not use the default CUDA 13 wheel on this driver; it fails at startup with `libcudart.so.13` missing.

## Start server

From PowerShell:

```powershell
scripts\vllm\start-qwen.ps1
```

Defaults:

- model: `cyankiwi/Qwen3.6-27B-AWQ-INT4`
- fallback model: `Qwen/Qwen3.5-27B-GPTQ-Int4`
- base URL: `http://localhost:8000/v1`
- cache: `G:\hf-cache`
- first-boot reliability profile: `VLLM_MAX_MODEL_LEN=16384`, `VLLM_ENFORCE_EAGER=true`, `VLLM_ENABLE_PREFIX_CACHING=false`

The launcher prefers the native WSL copy at `/models/cyankiwi-Qwen3.6-27B-AWQ-INT4` when present. That avoids loading shards through the Windows `/mnt/g` 9P mount, which can look like network traffic and is much slower.

The launcher also prefers the native WSL vLLM environment at `/opt/vllm-cu129`
when present. Keeping both the Python environment and model snapshots on ext4
avoids WSL `p9_client_read` stalls from the Windows drive mount.

The launcher also sets `VLLM_USE_FLASHINFER_SAMPLER=0`. On this WSL/CUDA wheel setup, FlashInfer sampling tries to JIT a CUDA extension after the weights load and fails without matching CUDA headers. The native vLLM sampler is the reliable path here.

Override the model:

```powershell
$env:VLLM_MODEL_ID = "Qwen/Qwen3.5-27B-GPTQ-Int4"
scripts\vllm\start-qwen.ps1
```

If Hugging Face asks for a token, set `HF_TOKEN` in the PowerShell environment before starting the server.

## Smoke test

```powershell
scripts\vllm\smoke-vllm.ps1
```

This checks `/v1/models`, basic chat, `action` tool calling, and native `TASK_DONE` tool calling.
