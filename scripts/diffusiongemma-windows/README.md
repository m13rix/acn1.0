# DiffusionGemma 26B A4B local experiment

The selected RTX 4090 checkpoint is:

```text
cyankiwi/diffusiongemma-26B-A4B-it-AWQ-INT4
```

It is a public, Apache-2.0, compressed-tensors AWQ INT4 checkpoint of
DiffusionGemma. Its download is about 17.3 GB and it is stored on WSL's native
ext4 filesystem to avoid `/mnt/g` model-loading stalls.

The downloader creates its own small Python environment on first run. It does
not require the vLLM runtime to be installed yet.

Download from PowerShell:

```powershell
.\scripts\diffusiongemma-windows\download.ps1
```

The download is resumable.

## Runtime

DiffusionGemma requires vLLM 0.24's custom model runner. Install the isolated
CUDA 12.9 runtime once:

```powershell
.\scripts\diffusiongemma-windows\install-runtime.ps1
```

The installer pins `vllm==0.24.0+cu129` and applies a narrow WSL fallback for
the V2 runner's UVA metadata buffers. On WSL, those tiny buffers are held on
the GPU and updated asynchronously from pinned host memory. Model computation
and sampling are unchanged.

Start the server:

```powershell
.\scripts\diffusiongemma-windows\start.ps1
```

The safe first profile for this display-attached RTX 4090 is:

- OpenAI-compatible API: `http://127.0.0.1:8001/v1`
- served model: `diffusiongemma-26b-awq`
- context: 8192 tokens
- one concurrent sequence
- 256-token diffusion canvas
- official entropy-bound sampler at 0.1
- CUDA graphs enabled
- text-only loading to avoid the vision encoder overhead

Run the throughput, latency, quality, and tool-call benchmark:

```powershell
.\scripts\diffusiongemma-windows\bench.ps1
```

## Telos harness

The opt-in `Diffusion-Coder` agent uses the existing Local-Coder system prompt,
the `diffusiongemma-26b-awq` served model, and thinking disabled for fast and
reliable short tool turns. Before launching Telos in a new PowerShell session:

```powershell
$env:VLLM_BASE_URL = "http://127.0.0.1:8001/v1"
$env:VLLM_API_KEY = "EMPTY"
$env:LOCAL_VLLM_CONTEXT_TOKENS = "8192"
$env:LOCAL_VLLM_OUTPUT_RESERVE_TOKENS = "2048"
npm start
```

Select `Diffusion-Coder` from the agent list. Thinking can be enabled for a
specific experiment by changing `providerOptions.vllm.chat_template_kwargs`,
but the model can spend hundreds of tokens reasoning on trivial arithmetic and
occasionally omit its final channel, so it is not the default.

Stop the server:

```powershell
.\scripts\diffusiongemma-windows\stop.ps1
```

Useful tuning overrides:

```powershell
$env:DIFFUSION_GEMMA_GPU_MEMORY_UTILIZATION = "0.85"
$env:DIFFUSION_GEMMA_MAX_MODEL_LEN = "8192"
$env:DIFFUSION_GEMMA_MAX_BATCHED_TOKENS = "8448"
$env:DIFFUSION_GEMMA_ENTROPY_BOUND = "0.1"
```

The tested 4090 default is `GPU_MEMORY_UTILIZATION=0.85`. The 0.88 experiment
reached the same decode speed but left as little as 150 MiB of display/GPU
headroom after a long request, so it is not the stable default.

## Measured RTX 4090 results

All figures below are single-request, 2,048-token forced generations with a
48-token prompt. `Wall tok/s` includes first-canvas latency; `steady tok/s`
measures after the first streamed canvas.

| Entropy bound | Wall tok/s | Steady tok/s | Result |
|---:|---:|---:|---|
| 0.05 | 542 | 642 | Slower; no quality improvement in the probe |
| 0.10 | 550-659 | 700-824 | Selected default |
| 0.15 | 554 | 696 | Viable experimental alternative |
| 0.20 | 532 | 644 | Rejected; reasoning sometimes omitted the final answer |

The final 0.10 / 0.85-memory run generated 2,048 tokens in 3.108 seconds:
658.9 tok/s end-to-end. A normal 328-token TypeScript debugging response
completed in 0.91 seconds at approximately 359 tok/s and was correct. Exact
instruction following, code generation, and native Gemma tool calling passed.

Known limitation: without thinking, the model repeatedly answered one simple
arithmetic probe incorrectly (`1090` instead of `1080`). Thinking sometimes
corrected it, but occasionally emitted only a reasoning channel. This is model
behavior, not a quantization/runtime crash, and is why the harness agent keeps
thinking disabled unless a task specifically benefits from it.
