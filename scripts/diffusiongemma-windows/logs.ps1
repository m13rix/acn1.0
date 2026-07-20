$ErrorActionPreference = "Stop"
$Distro = $env:VLLM_WSL_DISTRO
if (-not $Distro) { $Distro = "Ubuntu-24.04" }
wsl.exe -d $Distro -- tail -n 240 /root/.local/share/diffusiongemma-vllm/logs/server.log
if ($LASTEXITCODE -ne 0) { throw "Could not read DiffusionGemma server logs." }

