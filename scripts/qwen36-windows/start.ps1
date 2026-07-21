$ErrorActionPreference = "Stop"

$ServerRoot = $env:QWEN36_SERVER_ROOT
if (-not $ServerRoot) { $ServerRoot = "D:\qwen36\server\qwen3.6-windows-server" }

$ModelDir = $env:QWEN36_MODEL_DIR
if (-not $ModelDir) { $ModelDir = "D:\qwen36\models\Qwen3.6-27B-int4-AutoRound" }

$Snapshot = Join-Path $ServerRoot "snapshots\start_gpu0_50k.py"
$Python = Join-Path $ServerRoot "python\python.exe"
$LogDir = "D:\qwen36\run-logs"
$BaseUrl = "http://127.0.0.1:5001"

if (-not (Test-Path $Python)) { throw "Python runtime not found: $Python" }
if (-not (Test-Path $Snapshot)) { throw "Launch snapshot not found: $Snapshot" }
if (-not (Test-Path $ModelDir)) { throw "Model directory not found: $ModelDir" }

New-Item -ItemType Directory -Force $LogDir | Out-Null

try {
  Invoke-RestMethod -Uri "$BaseUrl/v1/models" -TimeoutSec 2 | Out-Null
  Write-Host "Qwen3.6 server is already running at $BaseUrl"
} catch {
  $env:VLLM_MODEL_DIR = $ModelDir
  $env:VLLM_NO_WT = "1"
  $stdout = Join-Path $LogDir "start_gpu0_50k.stdout.log"
  $stderr = Join-Path $LogDir "start_gpu0_50k.stderr.log"
  Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue

  $proc = Start-Process $Python `
    -ArgumentList "-u", $Snapshot `
    -WorkingDirectory $ServerRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru

  Write-Host "Started Qwen3.6 launcher pid=$($proc.Id). Waiting for API..."

  $deadline = (Get-Date).AddMinutes(15)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-RestMethod -Uri "$BaseUrl/v1/models" -TimeoutSec 2 | Out-Null
      $ready = $true
      break
    } catch {
      Start-Sleep -Seconds 5
    }
  }

  if (-not $ready) {
    Write-Host "Server did not become ready. Recent vLLM log:"
    $vllmLog = Join-Path $ServerRoot "logs\vllm_server.5001.log"
    if (Test-Path $vllmLog) { Get-Content $vllmLog -Tail 80 }
    throw "Qwen3.6 server failed to start within 15 minutes."
  }
}

$models = Invoke-RestMethod -Uri "$BaseUrl/v1/models" -TimeoutSec 10
$models | ConvertTo-Json -Depth 8

Write-Host ""
Write-Host "Use these for Local-Coder:"
Write-Host '$env:VLLM_BASE_URL = "http://127.0.0.1:5001/v1"'
Write-Host '$env:VLLM_API_KEY = "EMPTY"'
