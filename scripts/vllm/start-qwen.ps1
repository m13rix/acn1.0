$ErrorActionPreference = "Stop"

$distro = $env:VLLM_WSL_DISTRO
if (-not $distro) {
  $distro = "Ubuntu-24.04"
}

$model = $env:VLLM_MODEL_ID
$fallbackModel = $env:VLLM_FALLBACK_MODEL_ID
if (-not $fallbackModel) {
  $fallbackModel = "Qwen/Qwen3.5-27B-GPTQ-Int4"
}
$useFallback = $false
if (-not $model) {
  $model = "cyankiwi/Qwen3.6-27B-AWQ-INT4"
  $useFallback = $true
}

$maxModelLen = $env:VLLM_MAX_MODEL_LEN
if (-not $maxModelLen) {
  $maxModelLen = "16384"
}

$gpuMemoryUtilization = $env:VLLM_GPU_MEMORY_UTILIZATION
if (-not $gpuMemoryUtilization) {
  $gpuMemoryUtilization = "0.90"
}

$hfTokenPrefix = ""
if ($env:HF_TOKEN) {
  $hfTokenPrefix = "export HF_TOKEN='$($env:HF_TOKEN.Replace("'", "'\''"))'; "
}

$repoScript = "/mnt/g/agent0/acn1.0/scripts/vllm/start-qwen.sh"
$useFallbackValue = $useFallback.ToString().ToLowerInvariant()
$command = "export TELOS_VLLM_MODEL_ID='$($model.Replace("'", "'\''"))'; export TELOS_VLLM_FALLBACK_MODEL_ID='$($fallbackModel.Replace("'", "'\''"))'; export TELOS_VLLM_USE_FALLBACK='$useFallbackValue'; export TELOS_VLLM_MAX_MODEL_LEN='$maxModelLen'; export TELOS_VLLM_GPU_MEMORY_UTILIZATION='$gpuMemoryUtilization'; export TELOS_VLLM_ENFORCE_EAGER='true'; export TELOS_VLLM_ENABLE_PREFIX_CACHING='false'; export VLLM_USE_FLASHINFER_SAMPLER='0'; export HF_HOME=/mnt/g/hf-cache; $hfTokenPrefix bash $repoScript"

Write-Host "Starting vLLM in $distro with model $model"
wsl.exe -d $distro -- bash -lc $command
