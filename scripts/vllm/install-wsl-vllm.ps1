$ErrorActionPreference = "Stop"

$distro = $env:VLLM_WSL_DISTRO
if (-not $distro) {
  $distro = "Ubuntu-24.04"
}

$installed = (wsl.exe -l -q 2>$null) -split "`r?`n" | ForEach-Object { $_.Trim([char]0xFEFF).Trim() } | Where-Object { $_ }
if ($installed -notcontains $distro) {
  Write-Host "Installing WSL distro $distro..."
  wsl.exe --install -d $distro
  Write-Host "WSL install was started. If Ubuntu opens an account-creation prompt, complete it, then rerun this script."
  exit 0
}

Write-Host "Configuring vLLM inside $distro..."
$repoScript = "/mnt/g/agent0/acn1.0/scripts/vllm/install-vllm.sh"
wsl.exe -d $distro -- bash $repoScript
