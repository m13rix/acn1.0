# Qwen3.6 27B Local Runtime

This is the tuned local runtime for the copied `Local-Coder` agent.

It uses the native Windows `devnen/qwen3.6-windows-server` port with the
`Lorbus/Qwen3.6-27B-int4-AutoRound` checkpoint, served through the OpenAI
compatible vLLM API on:

```powershell
http://127.0.0.1:5001/v1
```

The stable profile for this machine is:

- model: `qwen3.6-27b-autoround`
- context: `50000`
- quantization: `auto-round`
- KV cache: `fp8_e4m3`
- MTP speculative decoding: `6`
- GPU memory utilization: `0.92`

The server lives outside the repo at:

```powershell
D:\qwen36\server\qwen3.6-windows-server
D:\qwen36\models\Qwen3.6-27B-int4-AutoRound
```

## Start

```powershell
.\scripts\qwen36-windows\start.ps1
```

The script starts the server if needed, waits for `/v1/models`, and prints the
environment variables needed by the harness:

```powershell
$env:VLLM_BASE_URL = "http://127.0.0.1:5001/v1"
$env:VLLM_API_KEY = "EMPTY"
```

## Benchmark

```powershell
.\scripts\qwen36-windows\bench.ps1
```

On the current RTX 4090 desktop run, the 50k-context profile reported about
`86 tok/s` sustained decode at 700 generated tokens. First-token latency can be
higher than the 26k profile, but this avoids the 26k prompt ceiling that is too
tight for coding-agent work.

Real coding-agent performance is dominated by long-prompt prefill, not neat
decode-only benchmarks. Attempts to raise prefill chunks to `8192`/`16384` or
use CPU offload were not stable on this display-attached 24 GB GPU with the
current patched vLLM build. The practical profile remains 50k context with
`max_num_batched_tokens=4128` and MTP `n=6`.

The harness applies a local-only prompt budget for `provider: vllm`. Tuning
knobs:

```powershell
$env:LOCAL_VLLM_CONTEXT_TOKENS = "50000"
$env:LOCAL_VLLM_OUTPUT_RESERVE_TOKENS = "4096"
$env:LOCAL_VLLM_FILE_CHAR_LIMIT = "16000"
$env:LOCAL_VLLM_OBSERVATION_CHAR_LIMIT = "20000"
```

## Stop

```powershell
.\scripts\qwen36-windows\stop.ps1
```
