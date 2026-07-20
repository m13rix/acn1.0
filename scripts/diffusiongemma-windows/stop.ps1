$ErrorActionPreference = "Stop"
$Distro = $env:VLLM_WSL_DISTRO
if (-not $Distro) { $Distro = "Ubuntu-24.04" }
$repoScript = "/mnt/g/agent0/acn1.0/scripts/diffusiongemma-windows/stop.sh"
wsl.exe -d $Distro -- bash $repoScript
if ($LASTEXITCODE -ne 0) { throw "Failed to stop native DiffusionGemma server." }

