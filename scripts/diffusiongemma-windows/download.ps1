$ErrorActionPreference = "Stop"

$Distro = $env:VLLM_WSL_DISTRO
if (-not $Distro) { $Distro = "Ubuntu-24.04" }

$ModelId = $env:DIFFUSION_GEMMA_MODEL_ID
if (-not $ModelId) {
  $ModelId = "cyankiwi/diffusiongemma-26B-A4B-it-AWQ-INT4"
}

$ModelDir = $env:DIFFUSION_GEMMA_MODEL_DIR
if (-not $ModelDir) {
  $ModelDir = "/models/cyankiwi-diffusiongemma-26B-A4B-it-AWQ-INT4"
}

$Workers = $env:DIFFUSION_GEMMA_DOWNLOAD_WORKERS
if (-not $Workers) { $Workers = "4" }

$installed = (wsl.exe -l -q 2>$null) -split "`r?`n" |
  ForEach-Object { $_.Trim([char]0xFEFF).Trim() } |
  Where-Object { $_ }

if ($installed -notcontains $Distro) {
  throw "WSL distro '$Distro' is not installed. Run scripts\vllm\install-wsl-vllm.ps1 first."
}

$repoScript = "/mnt/g/agent0/acn1.0/scripts/diffusiongemma-windows/download.sh"
$command = @(
  "export DIFFUSION_GEMMA_MODEL_ID='$($ModelId.Replace("'", "'\''"))'"
  "export DIFFUSION_GEMMA_MODEL_DIR='$($ModelDir.Replace("'", "'\''"))'"
  "export DIFFUSION_GEMMA_DOWNLOAD_WORKERS='$Workers'"
  "bash '$repoScript'"
) -join "; "

Write-Host "Downloading $ModelId into WSL native storage at $ModelDir"
Write-Host "The download is resumable; rerun this command if it is interrupted."
wsl.exe -d $Distro -- bash -lc $command
if ($LASTEXITCODE -ne 0) {
  throw "DiffusionGemma download failed with exit code $LASTEXITCODE."
}

