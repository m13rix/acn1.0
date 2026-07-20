$ErrorActionPreference = "Stop"

$Distro = $env:VLLM_WSL_DISTRO
if (-not $Distro) { $Distro = "Ubuntu-24.04" }
$ModelDir = $env:DIFFUSION_GEMMA_MODEL_DIR
if (-not $ModelDir) { $ModelDir = "/models/cyankiwi-diffusiongemma-26B-A4B-it-AWQ-INT4" }
$Port = $env:DIFFUSION_GEMMA_PORT
if (-not $Port) { $Port = "8001" }
$MaxModelLen = $env:DIFFUSION_GEMMA_MAX_MODEL_LEN
if (-not $MaxModelLen) { $MaxModelLen = "8192" }
$MaxBatchedTokens = $env:DIFFUSION_GEMMA_MAX_BATCHED_TOKENS
if (-not $MaxBatchedTokens) { $MaxBatchedTokens = "8448" }
$GpuMemory = $env:DIFFUSION_GEMMA_GPU_MEMORY_UTILIZATION
if (-not $GpuMemory) { $GpuMemory = "0.85" }
$EntropyBound = $env:DIFFUSION_GEMMA_ENTROPY_BOUND
if (-not $EntropyBound) { $EntropyBound = "0.1" }
$ModelName = $env:DIFFUSION_GEMMA_SERVED_MODEL_NAME
if (-not $ModelName) { $ModelName = "diffusiongemma-26b-awq" }

$repoScript = "/mnt/g/agent0/acn1.0/scripts/diffusiongemma-windows/start.sh"
$command = @(
  "export DIFFUSION_GEMMA_MODEL_DIR='$($ModelDir.Replace("'", "'\''"))'"
  "export DIFFUSION_GEMMA_PORT='$Port'"
  "export DIFFUSION_GEMMA_MAX_MODEL_LEN='$MaxModelLen'"
  "export DIFFUSION_GEMMA_MAX_BATCHED_TOKENS='$MaxBatchedTokens'"
  "export DIFFUSION_GEMMA_GPU_MEMORY_UTILIZATION='$GpuMemory'"
  "export DIFFUSION_GEMMA_ENTROPY_BOUND='$EntropyBound'"
  "export DIFFUSION_GEMMA_SERVED_MODEL_NAME='$ModelName'"
  "bash '$repoScript'"
) -join "; "

wsl.exe -d $Distro -- bash -lc $command
if ($LASTEXITCODE -ne 0) { throw "Native DiffusionGemma launcher failed with exit code $LASTEXITCODE." }

$BaseUrl = "http://127.0.0.1:$Port"
Write-Host "Waiting for DiffusionGemma model load and CUDA graph capture..."
$deadline = (Get-Date).AddMinutes(20)
$ready = $false
while ((Get-Date) -lt $deadline) {
  try {
    Invoke-RestMethod -Uri "$BaseUrl/v1/models" -TimeoutSec 3 | Out-Null
    $ready = $true
    break
  } catch { Start-Sleep -Seconds 5 }
}
if (-not $ready) {
  wsl.exe -d $Distro -- tail -n 180 /root/.local/share/diffusiongemma-vllm/logs/server.log
  throw "DiffusionGemma did not become ready within 20 minutes."
}

Invoke-RestMethod -Uri "$BaseUrl/v1/models" -TimeoutSec 10 | ConvertTo-Json -Depth 8
Write-Host ""
Write-Host "DiffusionGemma is ready. Harness environment:"
Write-Host "`$env:VLLM_BASE_URL = `"$BaseUrl/v1`""
Write-Host "`$env:VLLM_API_KEY = `"EMPTY`""
Write-Host "`$env:VLLM_MODEL_ID = `"$ModelName`""
Write-Host "Benchmark: .\scripts\diffusiongemma-windows\bench.ps1"
