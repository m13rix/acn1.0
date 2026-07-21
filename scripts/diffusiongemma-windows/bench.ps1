$ErrorActionPreference = "Stop"
$Port = $env:DIFFUSION_GEMMA_PORT
if (-not $Port) { $Port = "8001" }
if (-not $env:VLLM_BASE_URL) { $env:VLLM_BASE_URL = "http://127.0.0.1:$Port/v1" }
if (-not $env:VLLM_MODEL_ID) { $env:VLLM_MODEL_ID = "diffusiongemma-26b-awq" }
node "$PSScriptRoot\bench.mjs"
if ($LASTEXITCODE -ne 0) { throw "DiffusionGemma benchmark failed." }

