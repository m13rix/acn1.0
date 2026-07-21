$ErrorActionPreference = "Stop"

$matches = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match 'qwen3\.6|start_4090_safe|start_gpu0_50k|start_coder_|vllm_server\.5001|Qwen3\.6-27B-int4-AutoRound|--port=5001|qwen36\\server\\qwen3\.6-windows-server'
}

foreach ($proc in $matches) {
  if ($proc.ProcessId -eq $PID) { continue }
  Write-Host "Stopping $($proc.Name) pid=$($proc.ProcessId)"
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host "Qwen3.6 Windows server processes stopped."
