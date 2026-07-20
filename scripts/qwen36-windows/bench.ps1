$ErrorActionPreference = "Stop"

$ServerRoot = $env:QWEN36_SERVER_ROOT
if (-not $ServerRoot) { $ServerRoot = "D:\qwen36\server\qwen3.6-windows-server" }

$Python = Join-Path $ServerRoot "python\python.exe"
$Bench = Join-Path $ServerRoot "windows_tools\bench.py"

if (-not (Test-Path $Python)) { throw "Python runtime not found: $Python" }
if (-not (Test-Path $Bench)) { throw "Benchmark script not found: $Bench" }

$env:VLLM_BENCH_BASE = "http://127.0.0.1:5001"
$env:VLLM_BENCH_MODEL = "qwen3.6-27b-autoround"

& $Python $Bench --quiet --wait --max-tokens 700

